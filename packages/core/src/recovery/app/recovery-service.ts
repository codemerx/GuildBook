// [Recover connections] (PLAN.md §3.5): when instance.db was lost or damaged and no backup could replace it, the app
// knows nothing of the links it made. The user clicks the button deliberately; the app then looks at the links in the
// tool folders, and in the repo folders the user adds again, and rebuilds the registry from them:
// - only names that may be the library's are looked at, and of each only whether it's a link and where it points
// - the tools whose folders hold the links are enabled again
// - a skill found linked in a repo is placed there again (as an individual addition), so the next check removes its
//   global links: no skill ends up both global and in a repo (§3.6). Tag rules are ticked again by hand.
import type { Catalog } from '@app/tools';
import type { ActivityLog } from '../../activity/index.ts';
import { detectTools, resolveTools, type ToolSettings } from '../../catalog/index.ts';
import { defineCommand, defineQuery, type InstanceEngine } from '../../engine/index.ts';
import type { LibrarySnapshot } from '../../library/index.ts';
import { COPY_MARKER, type LinkCheckReport, type LinkNaming } from '../../links/index.ts';
import type { Clock } from '../../ports/clock.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Links } from '../../ports/links.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Store } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import type { DomainEvent } from '../../shared/events.ts';
import { setList } from '../../shared/set-list.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import { type FoundLink, recoverConnections } from '../domain/recovery.ts';
import { type CopyMarker, CopyMarkerSchema, SKILL_LINK_KIND } from '@app/schemas';

/** The registry row that says the connections were lost and aren't recovered yet. */
export const RECOVERY_KIND = 'recovery';
const RECOVERY_KEY = 'connections';

export interface RecoveryState {
  /** instance.db was lost or damaged, without a backup: [Recover connections] waits for the user. */
  readonly needed: boolean;
  readonly since: number | null;
}

export interface RecoveryReport {
  readonly links: number;
  /** The tools enabled again, by name. */
  readonly tools: readonly string[];
  /** The repos added again, by name, with the skills placed in each. */
  readonly repos: ReadonlyArray<{ readonly name: string; readonly skills: readonly string[] }>;
  /** Repo folders that weren't git repos: nothing was looked at there. */
  readonly notRepos: readonly string[];
}

export const RecoveryQuery = defineQuery<Record<string, never>, RecoveryState>('Recovery');
export const RecoverConnections = defineCommand<{ repos: readonly string[] }, RecoveryReport>('RecoverConnections');

export interface RecoveryServiceDeps {
  readonly engine: InstanceEngine;
  readonly store: Store;
  readonly fs: FileSystem;
  readonly links: Links;
  readonly paths: PathFlavour;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly activity: ActivityLog;
  readonly home: string;
  readonly catalog: () => Catalog;
  readonly toolSettings: () => ToolSettings;
  readonly libraryRoot: () => string;
  readonly projectionRoot: string;
  readonly snapshot: () => LibrarySnapshot | null;
  /** The links' names under the local prefix, when the library has one (Step 8). */
  readonly naming: () => LinkNaming | null;
  readonly placement: {
    recoverRepo(path: string): Promise<{ id: string; checkouts: readonly string[] } | null>;
    recoverPlacement(
      found: ReadonlyArray<{ repo: string; skill: string; dest: string; checkout: string }>,
    ): Promise<void>;
    repoName(id: string): string | null;
  };
  /** A link check from inside the command: it settles the links on the recovered registry. */
  readonly check: (emit: (event: DomainEvent) => void) => Promise<LinkCheckReport>;
  /** The instance's id: a copy-mode copy whose marker names it is this library's (Step 16). */
  readonly instanceId?: string;
}

export class RecoveryService {
  readonly #deps: RecoveryServiceDeps;
  readonly #lists = new Set<string>();
  readonly #exact = new Set<string>();
  readonly #entries = new Set<string>();

  constructor(deps: RecoveryServiceDeps) {
    this.#deps = deps;
    deps.engine.handleQuery(RecoveryQuery, () => this.state());
    deps.engine.handle(RecoverConnections, ({ repos }, context) =>
      this.#recover(repos, (event) => context.emit(event)),
    );
  }

  state(): RecoveryState {
    const record = this.#deps.store.read((tx) => tx.registry.get(RECOVERY_KIND, RECOVERY_KEY));
    const since = (record?.data as { since?: unknown } | undefined)?.since;
    return { needed: record !== undefined, since: typeof since === 'number' ? since : null };
  }

  /** The worker found instance.db lost or damaged, and no backup to restore: the connections wait for recovery. */
  markLost(): void {
    const now = this.#deps.clock.now();
    this.#deps.store.write((tx) => tx.registry.put(RECOVERY_KIND, RECOVERY_KEY, { since: now }, now));
  }

  /** What the guard lets the scan reach: the link folders' names, and the entries that may be the library's. */
  roots(): { lists: string[]; exact: string[]; entries: string[] } {
    // The same arrays while nothing was added: the guard keeps a lookup per array, and asks at every file operation
    // (new arrays here made the `large` world's link check take over an hour, Step 17).
    return {
      lists: this.#listsList(this.#lists),
      exact: this.#exactList(this.#exact),
      entries: this.#entriesList(this.#entries),
    };
  }

  readonly #listsList = setList();
  readonly #exactList = setList();
  readonly #entriesList = setList();

  async #recover(repoFolders: readonly string[], emit: (event: DomainEvent) => void): Promise<RecoveryReport> {
    const { deps } = { deps: this.#deps };
    if (!this.state().needed) throw new AppError('recovery.notNeeded');
    const snapshot = deps.snapshot();
    if (!snapshot) throw new AppError('links.notReady');
    const { paths } = deps;
    const tools = resolveTools(deps.catalog(), deps.home, deps.toolSettings(), paths);
    const installed = new Set(await detectTools(deps.fs, tools));
    const names = this.#names(snapshot);

    const places: Array<{ folder: string; repo: string | null; checkout: string | null }> = [];
    for (const dir of new Set(tools.flatMap((tool) => tool.skillDirs)))
      places.push({ folder: dir, repo: null, checkout: null });
    const repos: Array<{ id: string; name: string }> = [];
    const notRepos: string[] = [];
    const repoDirs = [...new Set(tools.flatMap((tool) => tool.repoSkillDirs))];
    for (const folder of repoFolders) {
      const repo = await deps.placement.recoverRepo(folder);
      if (!repo) {
        notRepos.push(folder);
        continue;
      }
      repos.push({ id: repo.id, name: deps.placement.repoName(repo.id) ?? folder });
      for (const checkout of repo.checkouts) {
        for (const dir of repoDirs) places.push({ folder: paths.join(checkout, dir), repo: repo.id, checkout });
      }
    }

    const found: FoundLink[] = [];
    for (const place of places) {
      this.#lists.add(place.folder);
      this.#exact.add(place.folder);
      if ((await deps.fs.lstat(place.folder as AbsPath))?.kind !== 'dir') continue;
      // Every other name is dropped at once: nothing of the user's own is looked at (PLAN.md §3.7 rule 3).
      for (const name of await deps.fs.list(place.folder as AbsPath)) {
        if (!names.has(name)) continue;
        const dest = paths.join(place.folder, name);
        this.#entries.add(dest);
        const kind = (await deps.fs.lstat(dest as AbsPath))?.kind;
        const target = kind === 'link' ? await deps.links.readTarget(dest as AbsPath) : undefined;
        if (target !== undefined) found.push({ dest, target, ...place });
        // A copy-mode copy (Step 16): only its marker file is read.
        const marker = kind === 'dir' && deps.instanceId !== undefined ? await this.#marker(dest) : undefined;
        if (marker && marker.instance === deps.instanceId) {
          found.push({
            dest,
            target: dest,
            ...place,
            copy: { item: marker.item, contentFingerprint: marker.contentFingerprint },
          });
        }
      }
    }

    const now = deps.clock.now();
    const recovered = recoverConnections(
      {
        libraryRoot: deps.libraryRoot(),
        projectionRoot: deps.projectionRoot,
        names,
        links: found,
        tools: tools.map((tool) => ({
          id: tool.id,
          // A custom tool or copy target is one the user added on this device: it's there.
          installed: installed.has(tool.id) || tool.custom,
          skillDirs: tool.skillDirs,
          repoSkillDirs: tool.repoSkillDirs,
        })),
      },
      paths,
      now,
    );
    await deps.placement.recoverPlacement(recovered.inRepos);
    const enabled = new Set(deps.store.read((tx) => tx.settings.get()).enabledTools);
    for (const id of recovered.tools) enabled.add(id);
    deps.store.write((tx) => {
      for (const link of recovered.links) tx.registry.put(SKILL_LINK_KIND, link.dest, link.row, now);
      tx.settings.set({ ...tx.settings.get(), enabledTools: [...enabled].sort() });
      tx.registry.delete(RECOVERY_KIND, RECOVERY_KEY);
    });
    const toolNames = tools.filter((tool) => recovered.tools.includes(tool.id)).map((tool) => tool.name);
    const placed = repos.map((repo) => ({
      name: repo.name,
      skills: [...new Set(recovered.inRepos.filter((r) => r.repo === repo.id).map((r) => r.skill))].sort(),
    }));
    deps.activity.append([
      {
        kind: 'connections-recovered',
        path: null,
        details: { links: recovered.links.length, tools: toolNames, repos: placed.map((r) => r.name) },
      },
    ]);
    deps.logger.info('connections recovered', { links: recovered.links.length, tools: recovered.tools.length });
    await deps.check(emit);
    return { links: recovered.links.length, tools: toolNames, repos: placed, notRepos };
  }

  /** A copy's marker file, when it has one the app can read. */
  async #marker(dest: string): Promise<CopyMarker | undefined> {
    const at = this.#deps.paths.join(dest, COPY_MARKER) as AbsPath;
    if ((await this.#deps.fs.lstat(at))?.kind !== 'file') return undefined;
    try {
      const parsed = CopyMarkerSchema.safeParse(JSON.parse(await this.#deps.fs.readText(at)));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Each name a link of this library may have: the skills' git names, or their names under the local prefix. */
  #names(snapshot: LibrarySnapshot): Map<string, { skill: string; local: boolean }> {
    const naming = this.#deps.naming();
    const names = new Map<string, { skill: string; local: boolean }>();
    for (const skill of snapshot.skills) {
      if (!naming) {
        names.set(skill.folder, { skill: skill.folder, local: false });
        continue;
      }
      const name = naming.name(skill.folder);
      if (name !== null) names.set(name, { skill: skill.folder, local: true });
    }
    naming?.done();
    return names;
  }
}
