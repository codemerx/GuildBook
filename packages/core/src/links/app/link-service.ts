// The link engine of one instance (IMPLEMENTATION.md Step 5, PLAN.md §3.4, §3.8, §3.10 "Adjusting links"): company
// skills appear in every enabled tool, and stay correct whatever happens on disk.
// - The health check is a background command: at start, on focus, every 3 minutes and after git changes. It only ever
//   does what's safe without asking (PLAN.md §3.8); everything else becomes a red warning in "Needs attention".
// - Renames and deletions made with any git tool are found by comparing HEAD with the applied-state baseline (S6), so
//   the user's choices move with a renamed skill.
// - Enabling a tool, and every answer to a warning, is a plan the user confirms, applied only if its hash still holds.
// - Links stop changing while a git operation is unfinished, and while the library needs a newer app (A5.7).
import type { Catalog } from '@app/tools';
import {
  agentSkillNameProblems,
  type JsonValue,
  LINK_FOLDER_KIND,
  SKILL_LINK_KIND,
  type SkillLinkRow,
  type SkillLinkStatus,
} from '@app/schemas';
import type { ActivityEntry, ActivityLog, InstanceTrash } from '../../activity/index.ts';
import {
  chooseLinkFolders,
  detectTools,
  type LinkFolderChoice,
  type ResolvedTool,
  resolveTools,
  type ToolSettings,
} from '../../catalog/index.ts';
import {
  combinePlans,
  defineCommand,
  defineQuery,
  type InstanceEngine,
  type Plan,
  type ReconcileRunner,
} from '../../engine/index.ts';
import type { LibrarySnapshot } from '../../library/index.ts';
import type { Clock } from '../../ports/clock.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { GitRepo } from '../../ports/git.ts';
import type { Links } from '../../ports/links.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Store } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import { hashValue } from '../../shared/hash.ts';
import { mapLimit } from '../../shared/map-limit.ts';
import type { DomainEvent } from '../../shared/events.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import type { AppliedStateBaseline, BaselineDiff, PreviewLibrary, PreviewPlaces } from '../../sync/index.ts';
import {
  type ChosenFolder,
  desiredSkillLinks,
  isWarning,
  itemOf,
  type LinkableSkill,
  type LinkDecision,
  type SkillLinkAction,
  type SkillLinkDesired,
  type SkillLinkInputs,
  type StrayLink,
} from '../domain/skill-links.ts';
import type { LinkStrategy } from './link-strategy.ts';
import { madeFolderReconciler } from './made-folder-reconciler.ts';
import { retargetReconciler } from './retarget-reconciler.ts';
import { renamedSkillMd } from './skill-copy.ts';
import { COPY_MARKER, readRow, skillLinkReconciler, type SkillLinkReconcilerDeps } from './skill-link-reconciler.ts';

type NoInput = Record<string, never>;

/** The health check (PLAN.md §3.8 "When"). Background work: a user command cancels it, and it runs again after. */
export const CheckLinks = defineCommand<NoInput, LinkCheckReport>('CheckLinks', { background: true });
export const SetTools = defineCommand<{ enabled: readonly string[]; planHash: string }, LinkCheckReport>('SetTools');
export const ResolveLink = defineCommand<{ dest: string; decision: LinkDecision; planHash: string }, LinkCheckReport>(
  'ResolveLink',
);
export const RestoreSkill = defineCommand<{ skill: string }, LinkCheckReport>('RestoreSkill');
export const RestoreFromTrash = defineCommand<{ id: string }, LinkCheckReport>('RestoreFromTrash');
export const RemoveAllLinks = defineCommand<NoInput, number>('RemoveAllLinks');

export const ToolsQuery = defineQuery<NoInput, ToolsState>('Tools');
export const PreviewTools = defineQuery<{ enabled: readonly string[] }, LinkPlanView>('PreviewTools');
export const PreviewDecision = defineQuery<{ dest: string; decision: LinkDecision }, LinkPlanView>('PreviewDecision');
export const SkillLinksQuery = defineQuery<NoInput, SkillLinksState>('SkillLinks');
export const AttentionQuery = defineQuery<NoInput, AttentionItem[]>('Attention');
export const FolderDifferences = defineQuery<{ dest: string }, FileDifference[]>('FolderDifferences');

/** Links changed: the renderer refreshes its skills, warnings and tools (IMPLEMENTATION.md §2.4 events). */
export interface LinksChanged extends DomainEvent {
  readonly type: 'LinksChanged';
  readonly attention: number;
}

export interface LinkCheckReport {
  /**
   * Why nothing changed, when nothing could: `frozen` (a newer library format), `paused` (git is busy), `missing` (the
   * library folder is gone, S9), `prefix-waiting` (a new git prefix clashes here and waits for a local prefix, Step 14).
   */
  readonly state: 'done' | 'frozen' | 'paused' | 'not-ready' | 'missing' | 'prefix-waiting';
  readonly applied: number;
  readonly attention: number;
}

export interface ToolView {
  readonly id: string;
  readonly name: string;
  readonly custom: boolean;
  readonly found: boolean;
  readonly enabled: boolean;
  readonly home: string | null;
  readonly homeSource: ResolvedTool['homeSource'];
  readonly homeEnv: string | null;
  readonly skillDirs: readonly string[];
  readonly sameNameHandling: ResolvedTool['sameNameHandling'];
  readonly verified: { readonly version: string; readonly date: string } | null;
  /** It reads copies, not links: a copy target (copy mode, Step 16). */
  readonly copy: boolean;
}

export interface ToolsState {
  readonly tools: readonly ToolView[];
  readonly choice: LinkFolderChoice;
}

export interface LinkChangeView {
  readonly op: SkillLinkAction['op'];
  readonly skill: string;
  readonly dest: string;
  readonly folder: string | null;
  /** For a `mark`: the warning it raises. */
  readonly status: SkillLinkStatus | null;
  /** A link, or a copy in a copy-mode folder (Step 16). */
  readonly method: SkillLinkRow['method'];
}

export interface LinkPlanView {
  readonly hash: string;
  readonly changes: readonly LinkChangeView[];
  /** Links that stay in a folder because another enabled tool still reads it (A5.16). */
  readonly kept: ReadonlyArray<{ readonly tool: string; readonly folder: string; readonly readers: readonly string[] }>;
  readonly folders: readonly string[];
}

export interface SkillLinkView {
  readonly dest: string;
  readonly folder: string;
  readonly tools: readonly string[];
  readonly status: SkillLinkStatus | 'pending';
  /** A link, or a copy in a copy-mode folder (Step 16). */
  readonly method: SkillLinkRow['method'];
}

export interface SkillLinksState {
  readonly state: LinkCheckReport['state'];
  readonly skills: ReadonlyArray<{ readonly skill: string; readonly links: readonly SkillLinkView[] }>;
}

/**
 * A link's warning, the library's (`frozen`), placement's: a repo folder gone (S10) or a ticked tag gone (§3.6), or a
 * projected copy's (§3.3): both sides changed, or a skill this device skips under its local prefix.
 */
export type AttentionKind =
  | SkillLinkStatus
  | 'frozen'
  | 'library-missing'
  | 'connections-lost'
  | 'relocation-unfinished'
  | 'repo-missing'
  | 'tag-gone'
  | 'copy-conflict'
  | 'name-too-long'
  | 'wrong-prefix'
  /** A new git prefix clashes on this device (Step 14): `reason` is the new prefix, `takenBy` the old one. */
  | 'prefix-waiting';

export interface AttentionItem {
  /** The link path, `library` for the instance-wide item, or placement's own id. */
  readonly id: string;
  readonly kind: AttentionKind;
  readonly skill: string | null;
  readonly dest: string | null;
  readonly folder: string | null;
  /** The enabled tools that read the folder, by name. */
  readonly tools: readonly string[];
  readonly reason: string | null;
  readonly takenBy: string | null;
  readonly since: number;
  /** The code repo it's about (PLAN.md §3.6): its id and its name. */
  readonly repoId: string | null;
  readonly repo: string | null;
  /** For `tag-gone`: the tag, and the repos whose rule uses it. */
  readonly tag: string | null;
  readonly repos: readonly string[];
}

export interface FileDifference {
  readonly path: string;
  readonly change: 'added' | 'removed' | 'changed';
}

/** What the worker shows as a system notification (PLAN.md §3.19), translated there. */
export type LinkNotice =
  | { readonly type: 'warning'; readonly status: SkillLinkStatus; readonly skill: string; readonly tools: string[] }
  | { readonly type: 'renamed'; readonly from: string; readonly to: string; readonly author: string | null }
  | { readonly type: 'removed'; readonly skill: string; readonly author: string | null }
  /** Links moved with no preview: a branch switch, a stash or another git tool changed placement (PLAN.md §3.6). */
  | { readonly type: 'moved'; readonly moves: readonly PlacementMove[] }
  /** The library folder is gone: moved outside the app, most likely (S9). */
  | { readonly type: 'library-missing' };

/**
 * The links at the new place after a relocation's rewrite (PLAN.md §3.9 step 5), with the tools that read each, and
 * the ones skipped.
 */
export interface RetargetReport {
  readonly retargeted: ReadonlyArray<{ readonly path: string; readonly tools: string[] }>;
  readonly skipped: readonly string[];
}

/** Where a skill is linked: globally, in these repos (by name), or nowhere. */
export interface PlacedWhere {
  readonly global: boolean;
  readonly repos: readonly string[];
}

export interface PlacementMove {
  readonly skill: string;
  readonly from: PlacedWhere;
  readonly to: PlacedWhere;
}

/** What placement needs from the link engine to say where skills go. */
export interface PlacementContext {
  readonly tools: readonly ResolvedTool[];
  readonly enabled: readonly string[];
  /** The global link folders the catalog chose for the enabled tools. */
  readonly globalFolders: readonly string[];
}

export interface SkillPlaces {
  readonly global: boolean;
  /** The repos it's placed in, by id: missing ones too (S10). */
  readonly repos: readonly string[];
  /** The link folders of those repos, in every checkout the app can reach. */
  readonly repoFolders: readonly ChosenFolder[];
}

export interface PlacedSkills {
  readonly bySkill: ReadonlyMap<string, SkillPlaces>;
  /** Links to company skills that the app didn't make, found in the link folders (S11). */
  readonly strays: readonly StrayLink[];
}

/** How skills are named and linked under a local prefix (PLAN.md §3.3, Step 8). */
export interface LinkNaming {
  /** Where the projected copies live. */
  readonly root: string;
  /** A skill's link name, or null when this device skips it (a name too long, or not under the git prefix). */
  name(folder: string): string | null;
  /** Where a link with this name points: its projected copy. */
  target(name: string): string;
  /** Every skill was named: the skipped ones are known. */
  done(): void;
}

/**
 * The projected copies (Step 8) as the link engine sees them. The projection module implements it; the links module
 * knows only this interface.
 */
export interface LinkProjection {
  /** Where the copies live: a row named after the local prefix points there, whatever the prefix is now. */
  readonly root: string;
  /** The local prefix on this device, or null. */
  readonly localPrefix: string | null;
  /**
   * Null while the instance has no local prefix: links are named after the folders and point at the library. `view`
   * names the skills of a preview library (a pull's dry run, Step 14): its git prefix, and the local prefix it would
   * have; nothing is recorded or announced for it.
   */
  naming(view?: { readonly gitPrefix: string | null; readonly localPrefix: string | null }): LinkNaming | null;
  /** Before the links change: copies made and refreshed, edits written back. */
  before(skills: readonly string[]): Promise<number>;
  /** After the links changed: the copies no link points at any more go. */
  after(skills: readonly string[]): Promise<number>;
  attention(): AttentionItem[];
}

/** A reconciler planned and applied together with the skill links: a code repo's exclude entries (PLAN.md §3.6). */
export interface CompanionReconcile {
  plan(): Promise<Plan<unknown>>;
  /** `before` the links change: only what must exist first (new entries); `after`: the rest (old entries go). */
  apply(phase: 'before' | 'after', expectedHash?: string): Promise<number>;
}

/** A setup wizard's choices as the link engine's inputs (Step 15): nothing of them is stored yet. */
export interface SetupLinkInputs {
  readonly enabled: readonly string[];
  /** The name check's answers, by link path. */
  readonly decisions: Readonly<Record<string, LinkDecision>>;
  /** The tags ticked on the repos page, as placement edits. */
  readonly change: unknown;
}

/** What a setup's [Finish] does to the links (PLAN.md §3.17 steps 8–9). */
export interface SetupLinkPreview {
  /** The combined plan's hash (links and exclude entries). */
  readonly hash: string;
  readonly view: LinkPlanView;
  /** Where each skill goes: everywhere, or in these repos (by id). */
  readonly skills: ReadonlyArray<{
    readonly skill: string;
    readonly global: boolean;
    readonly repos: readonly string[];
  }>;
  /** Names already taken on this device (S2): the name check asks about each. */
  readonly taken: ReadonlyArray<{
    readonly dest: string;
    readonly skill: string;
    readonly folder: string;
    readonly reason: string | null;
    readonly repo: string | null;
    readonly tools: readonly string[];
  }>;
  /** The links made, replaced or moved aside. */
  readonly links: ReadonlyArray<{ readonly op: SkillLinkAction['op']; readonly dest: string; readonly skill: string }>;
  /** The paths that won't get a link, with the state recorded for each (`skipped`, `suppressed`). */
  readonly skipped: ReadonlyArray<{
    readonly skill: string;
    readonly dest: string;
    readonly status: SkillLinkStatus;
    readonly tools: readonly string[];
  }>;
}

/** A pull's link changes, before it runs: the plan, the links wanted after it, and where each skill goes. */
export interface LinkPreview {
  readonly view: LinkPlanView;
  /** The combined plan's hash (links and exclude entries). */
  readonly hash: string;
  readonly links: ReadonlyArray<{ readonly dest: string; readonly target: string; readonly skill: string }>;
  /** Where each linked skill is now, from the registry. */
  readonly before: ReadonlyMap<string, PlacedWhere>;
  readonly places: PreviewPlaces;
}

/**
 * Placement (PLAN.md §3.6, Step 6) as the link engine sees it. The placement module implements it; the links module
 * knows only this interface, so the two modules don't depend on each other both ways.
 */
export interface LinkPlacement {
  /** Before each check: repos found, gone (S10) or back, and their worktrees. */
  refresh(): Promise<void>;
  /**
   * Where each skill goes. `change` is a placement change being previewed or applied; else the stored choices.
   * `library` is a library a pull would produce: its tags count, and its renames move the choices.
   */
  place(
    skills: readonly string[],
    context: PlacementContext,
    change?: unknown,
    library?: PreviewLibrary,
  ): Promise<PlacedSkills>;
  /** Where placement puts each skill of a preview library, with a change applied (the pull's questions). */
  previewPlaces(skills: readonly string[], change: unknown, library: PreviewLibrary): PreviewPlaces;
  /** The exclude entries for these links. */
  companion(desired: readonly SkillLinkDesired[], change?: unknown): CompanionReconcile;
  /** Placement's own items in "Needs attention": S10, and ticked tags that no longer exist. */
  attention(): AttentionItem[];
  repoName(id: string): string | null;
  /** The repo's main checkout: a checkout of the repo that isn't this is a worktree. */
  repoFolder(id: string): string | null;
  /** A skill renamed in git (S6): its placement choices move to the new name. */
  renamed(from: string, to: string): void;
  /** Whether the code repo commits the path in this checkout (S2): asked of git for that one path (§3.7 rule 4). */
  committed(checkout: string, dest: string): Promise<boolean>;
}

export interface LinkServiceDeps {
  readonly engine: InstanceEngine;
  readonly runner: ReconcileRunner;
  readonly store: Store;
  readonly fs: FileSystem;
  readonly links: Links;
  readonly strategy: LinkStrategy;
  readonly trash: InstanceTrash;
  readonly activity: ActivityLog;
  readonly paths: PathFlavour;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly home: string;
  readonly libraryRoot: () => string;
  readonly catalog: () => Catalog;
  readonly toolSettings: () => ToolSettings;
  /** The prefixes in use on this device: a moved folder's new name must not start with one (PLAN.md §3.8 S2). */
  readonly prefixesInUse: () => readonly string[];
  readonly snapshot: () => LibrarySnapshot | null;
  readonly repo: Pick<
    GitRepo,
    'state' | 'resolve' | 'listTree' | 'pathVersions' | 'restore' | 'log' | 'diff' | 'readBlob'
  >;
  readonly baseline: AppliedStateBaseline;
  readonly notify: (notice: LinkNotice) => void;
  /** False while the instance is setting up: nothing outside the library changes before [Finish] (§2.1). */
  readonly active?: () => boolean;
  /** Placement (Step 6). Without it every skill is global, as in Step 5. */
  readonly placement?: LinkPlacement;
  /** Projected copies under a local prefix (Step 8). Without it links always point at the library. */
  readonly projection?: LinkProjection;
  /**
   * The instance's own items, shown first in "Needs attention" (Step 9): connections lost with the database, or a move
   * that stopped with an error.
   */
  readonly instanceItems?: () => readonly AttentionItem[];
  /**
   * HEAD moved since the links were last adjusted (Step 11): the sync module tells a change made with another git tool
   * from the app's own, and announces it (PLAN.md §3.10 "Adjusting links").
   */
  readonly baselineMoved?: (diff: BaselineDiff) => void;
  /**
   * The prefix change (Step 14, PLAN.md §3.2 step 3): before the links change, the device adjusts to a new git prefix;
   * one that clashes here holds them until the user chooses a local prefix.
   */
  readonly prefixGate?: () => Promise<'ok' | 'waiting'>;
  /** Copy mode (Step 16): the instance's id, which the copies' marker files name. */
  readonly instanceId?: string;
  /** Copy mode: which library paths the library's ignore rules match; a copy never holds them (PLAN.md §3.3). */
  readonly ignored?: (paths: readonly string[]) => Promise<readonly string[]>;
}

const CHOICES: readonly SkillLinkStatus[] = ['suppressed', 'detached-by-user'];

/**
 * The registry kind of a skill that the editor renamed (PLAN.md §3.10, A10.8). Git still has the old folder until the
 * person commits, so without this the old name would look like a skill that was deleted on this device: its link would
 * stay, pointing at nothing, with a warning. The key is the old folder, the value says what it became.
 */
const RENAMED_AWAY_KIND = 'skill-renamed-away';

/** A library item's folder. */
function targetOfItem(deps: Pick<LinkServiceDeps, 'paths' | 'libraryRoot'>, item: string): string {
  return deps.paths.normalize(deps.paths.join(deps.libraryRoot(), ...item.split('/')));
}

/**
 * The rows that keep a link folder the app made: its link is there, or a warning about what's at the path waits for an
 * answer. A missing link, or the user's choice not to have one, keeps nothing (PLAN.md §3.6 "Worktrees").
 */
const KEEPS_FOLDER: readonly SkillLinkStatus[] = [
  'linked',
  'deleted',
  'skipped',
  'diverged',
  'taken-over',
  'duplicate',
  'copy-changed',
];

/** Each skill's place: global, and the repos by id. */
type SkillWhere = Map<string, { global: boolean; repos: string[] }>;

/** Without placement there are no exclude entries: an empty plan. */
const NO_COMPANION: CompanionReconcile = {
  plan: async () => ({ kind: 'exclude-entry', actions: [], conflicts: [], hash: 'none' }),
  apply: async () => 0,
};

/** A tools plan's hash: its link changes and the tools it enables. */
function toolsHash(planHash: string, enabled: readonly string[]): string {
  return hashValue({ plan: planHash, enabled: [...enabled].sort() });
}

/** Which decisions answer which state (PLAN.md §3.8). */
const ANSWERS: Readonly<Record<SkillLinkStatus, readonly LinkDecision['kind'][]>> = {
  skipped: ['overwrite', 'move-aside', 'suppress'],
  missing: ['reinstall', 'suppress'],
  diverged: ['move-aside', 'replace', 'bring-in', 'leave'],
  'taken-over': ['take-back', 'leave'],
  deleted: [],
  suppressed: ['reenable'],
  'detached-by-user': ['reenable'],
  duplicate: ['drop-duplicate'],
  // A copy edited where it is (copy mode, Step 16): bring the change into the library, replace the copy, or leave it.
  'copy-changed': ['bring-in', 'replace', 'leave'],
  linked: [],
};

export class LinkService {
  readonly #deps: LinkServiceDeps;
  /** Exact paths the guard lets the reconciler work at: every wanted link, every registered one. */
  readonly #allowed = new Set<string>();
  /** The link folders the app made in code repos: each may be removed again while it's empty. */
  readonly #made = new Set<string>();
  #state: LinkCheckReport['state'] = 'not-ready';

  constructor(deps: LinkServiceDeps) {
    this.#deps = deps;
    const { engine } = deps;
    // Every path the registry or the trash knows stays reachable: to check it, remove our link, or restore there.
    for (const [dest] of this.#rows()) this.#allowed.add(dest);
    for (const entry of deps.trash.list()) this.#allowed.add(entry.originalPath);
    for (const record of deps.store.read((tx) => tx.registry.list(LINK_FOLDER_KIND))) this.#made.add(record.key);
    engine.handle(CheckLinks, (_input, context) => this.#check(context.signal, (event) => context.emit(event)));
    engine.handle(SetTools, ({ enabled, planHash }, context) =>
      this.#setTools(enabled, planHash, (event) => context.emit(event)),
    );
    engine.handle(ResolveLink, ({ dest, decision, planHash }, context) =>
      this.#resolve(dest, decision, planHash, (event) => context.emit(event)),
    );
    engine.handle(RestoreSkill, async ({ skill }, context) => {
      const item = itemOf(skill);
      await this.#inputs(null);
      if (!this.#snapshotHead(skill)) throw new AppError('links.notRestorable', { skill });
      await deps.repo.restore([item]);
      deps.activity.append([{ kind: 'restored', path: item, details: { skill } }]);
      return this.#check(undefined, (event) => context.emit(event));
    });
    engine.handle(RestoreFromTrash, async ({ id }, context) => {
      const entry = await deps.trash.restore(id);
      deps.activity.append([
        {
          kind: 'restored-from-trash',
          path: entry.skill ? itemOf(entry.skill) : null,
          details: { id, path: entry.originalPath },
        },
      ]);
      return this.#check(undefined, (event) => context.emit(event));
    });
    engine.handle(RemoveAllLinks, () => this.removeAll());
    engine.handleQuery(ToolsQuery, () => this.#tools());
    engine.handleQuery(PreviewTools, async ({ enabled }) => {
      const wanted = this.#enabledKnown(enabled);
      const inputs = await this.#inputs(wanted);
      const plans = await this.#planAll(this.#reconciler(), inputs);
      return { ...this.#planView(plans.links, wanted), hash: toolsHash(plans.hash, wanted) };
    });
    engine.handleQuery(PreviewDecision, async ({ dest, decision }) => {
      this.#checkDecision(dest, decision);
      await this.#allowMoveTarget(dest, decision);
      const inputs = await this.#inputs(null, { [dest]: decision });
      const plan = await deps.runner.plan(this.#reconciler({ only: [dest] }), inputs);
      return this.#planView(plan, null);
    });
    engine.handleQuery(SkillLinksQuery, () => this.#skillLinks());
    engine.handleQuery(AttentionQuery, () => this.attention());
    engine.handleQuery(FolderDifferences, ({ dest }) => this.#differences(dest));
  }

  /**
   * What the guard allows besides the data folder and the library: link paths, and tool and link folders. Called for
   * every file operation, so it reads nothing: the paths are kept as they become known.
   */
  roots(): { entries: string[]; exact: string[]; made: string[] } {
    const settings = this.#deps.toolSettings();
    const catalog = this.#deps.catalog();
    if (!this.#exact || this.#exact.settings !== settings || this.#exact.catalog !== catalog) {
      const { paths } = this.#deps;
      const exact = new Set<string>();
      for (const tool of this.#resolved()) {
        for (const path of [...tool.detect, ...tool.skillDirs]) exact.add(path);
        if (tool.home) exact.add(tool.home);
        for (const dir of tool.skillDirs) exact.add(paths.dirname(dir));
      }
      this.#exact = { settings, catalog, paths: [...exact] };
    }
    // The same array while no path was added: the guard keeps a lookup per array (27,000 paths in `large`).
    if (this.#entries === null || this.#entries.length !== this.#allowed.size) this.#entries = [...this.#allowed];
    if (this.#madeList === null || this.#madeList.length !== this.#made.size) this.#madeList = [...this.#made];
    return { entries: this.#entries, exact: this.#exact.paths, made: this.#madeList };
  }

  #entries: string[] | null = null;

  #madeList: string[] | null = null;

  #exact: { settings: ToolSettings; catalog: Catalog; paths: string[] } | undefined;

  /**
   * Removing the instance (PLAN.md §3.8 S12): a reconcile to an empty desired state, which removes every link it
   * made and forgets every row. Call it from inside a command (a device operation's step), or through RemoveAllLinks.
   */
  async removeAll(): Promise<number> {
    const report = await this.#deps.runner.apply(this.#reconciler({ forgetChoices: true }), {
      libraryRoot: this.#deps.libraryRoot(),
      skills: [],
      folders: [],
    });
    // The exclude entries in code repos go too (PLAN.md §3.8 S12): a reconcile to no entries.
    const entries = this.#deps.placement ? await this.#deps.placement.companion([]).apply('after') : 0;
    // And the link folders it made there, while they're empty (PLAN.md §3.6 "Worktrees").
    await this.#tidyFolders();
    // And the projected copies (PLAN.md §3.3): the ones with changes of their own go to the trash.
    const copies = (await this.#deps.projection?.after([])) ?? 0;
    return report.applied + entries + copies;
  }

  /** "Needs attention" (PLAN.md §3.8): every red warning by skill, and the library-wide one first when links froze. */
  attention(): AttentionItem[] {
    const folderTools = this.#folderTools();
    const items: AttentionItem[] = [];
    // S8 is about the skill, not one link: its files are gone for every tool at once, and [Restore] brings them back.
    const deleted = new Map<string, { item: AttentionItem; tools: Set<string> }>();
    for (const [dest, row] of this.#rows()) {
      if (!isWarning(row.status)) continue;
      const repoId = row.status === 'deleted' ? null : (row.repo ?? null);
      const item: AttentionItem = {
        id: row.status === 'deleted' ? `deleted:${row.skill}` : dest,
        kind: row.status,
        skill: row.skill,
        dest,
        folder: row.folder,
        tools: folderTools(row.folder, row.checkout),
        reason: row.reason,
        takenBy: row.takenBy,
        since: row.since,
        repoId,
        repo: repoId === null ? null : (this.#deps.placement?.repoName(repoId) ?? null),
        tag: null,
        repos: [],
      };
      if (row.status !== 'deleted') {
        items.push(item);
        continue;
      }
      const seen = deleted.get(row.skill);
      if (seen) for (const tool of item.tools) seen.tools.add(tool);
      else deleted.set(row.skill, { item, tools: new Set(item.tools) });
    }
    for (const { item, tools } of deleted.values()) items.push({ ...item, tools: [...tools].sort() });
    // By skill, then path: the same order at every look, however close in time the warnings came.
    const key = (item: AttentionItem) => `${item.skill ?? ''}\u0000${item.id}`;
    items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    // The projected copies' items (Step 8), by skill too.
    items.push(...(this.#deps.projection?.attention() ?? []));
    items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    // Placement's items (S10, a tag gone) come first: each one is about a repo or a rule, not one link.
    items.unshift(...(this.#deps.placement?.attention() ?? []));
    items.unshift(...(this.#deps.instanceItems?.() ?? []));
    if (this.#state === 'frozen' || this.#state === 'missing') {
      items.unshift({
        id: 'library',
        kind: this.#state === 'frozen' ? 'frozen' : 'library-missing',
        skill: null,
        dest: null,
        folder: null,
        tools: [],
        reason: null,
        takenBy: null,
        since: this.#deps.clock.now(),
        repoId: null,
        repo: null,
        tag: null,
        repos: [],
      });
    }
    return items;
  }

  // ---- The health check ----------------------------------------------------------------------------------------

  async #check(signal: AbortSignal | undefined, emit: (event: DomainEvent) => void): Promise<LinkCheckReport> {
    const { deps } = { deps: this.#deps };
    await deps.trash.sweep();
    const snapshot = deps.snapshot();
    if (deps.active?.() === false) return this.#report('not-ready', 0, emit);
    // S9: nothing changes while the library folder is gone, and write-back from projected copies waits: the app never
    // takes a moved folder for "every skill deleted".
    if (!(await this.libraryPresent())) {
      if (this.#state !== 'missing') deps.notify({ type: 'library-missing' });
      return this.#report('missing', 0, emit);
    }
    if (!snapshot) return this.#report('not-ready', 0, emit);
    if (snapshot.compatibility !== 'ok') {
      // A newer library format, brought in by any git tool: nothing changes until the app is updated (A5.7).
      return this.#report('frozen', 0, emit);
    }
    const repoState = await deps.repo.state().catch(() => ({ operation: 'none' as const, busy: false }));
    if (repoState.operation !== 'none' || repoState.busy) return this.#report('paused', 0, emit);
    if ((await deps.prefixGate?.()) === 'waiting') return this.#report('prefix-waiting', 0, emit);

    await deps.placement?.refresh();
    const { announce, head } = await this.#followRenames();
    const inputs = await this.#inputs(null);
    const before = this.#warnings();
    const wasPlaced = this.#placedNow();
    const linkedCheckouts = this.#checkouts();
    const started = deps.clock.now();
    // Projected copies (Step 8): made and brought up to date before any link points at them. A pull that another git
    // tool started since the check began waits for its merge: nothing of it reaches the copies (A8.4).
    const skills = inputs.skills.map((skill) => skill.folder);
    const again = await deps.repo.state().catch(() => ({ operation: 'none' as const, busy: false }));
    if (again.operation !== 'none' || again.busy) return this.#report('paused', 0, emit);
    let applied = (await deps.projection?.before(skills)) ?? 0;
    const plans = await this.#planAll(this.#reconciler(), inputs);
    if (plans.links.actions.length > 0 || plans.entries.actions.length > 0) {
      applied += await this.#applyAll(this.#reconciler(), inputs, plans, signal);
      this.#afterApply(plans.links, started, linkedCheckouts);
    } else await this.#tidyFolders();
    // The copies no link points at any more go, once the links moved to the new ones.
    applied += (await deps.projection?.after(skills)) ?? 0;
    // The commit the renames were followed for: a HEAD that another git tool moved meanwhile is the next check's.
    await this.#recordBaseline(head);
    await this.#endRenamedAway();
    announce();
    this.#notifyNewWarnings(before);
    await this.#notifyMoves(wasPlaced);
    return this.#report('done', applied, emit);
  }

  /**
   * Whether the library folder is there (S9): the folder, with its git folder or its library.yaml. A folder moved
   * away takes both with it, which tells the app it's a move and not a deletion.
   */
  async libraryPresent(): Promise<boolean> {
    const { fs, paths } = this.#deps;
    const root = this.#deps.libraryRoot();
    if ((await fs.lstat(root as AbsPath))?.kind !== 'dir') return false;
    if (await fs.lstat(paths.join(root, '.git') as AbsPath)) return true;
    return (await fs.lstat(paths.join(root, 'library.yaml') as AbsPath)) !== undefined;
  }

  /** The state of the last check: `missing` while the library folder is gone (S9). */
  get state(): LinkCheckReport['state'] {
    return this.#state;
  }

  /**
   * Relocation's step 5 (PLAN.md §3.9): every link of the app to the library's old place points at the same item at
   * the new place, swapped in place one at a time. Call it from inside a command (a durable operation's step).
   */
  async retarget(from: string, to: string): Promise<RetargetReport> {
    const { fs, strategy, paths, runner } = this.#deps;
    const reconciler = retargetReconciler({ fs, strategy, paths });
    const inputs = { from: paths.normalize(from), to: paths.normalize(to), rows: this.#rows() };
    const plan = await runner.plan(reconciler, inputs);
    await runner.apply(reconciler, inputs, { expectedHash: plan.hash });
    const tools = this.#folderTools();
    // Every link of the app at the new place, also those a run before a crash swapped: the summary counts them all.
    const skipped = new Set(plan.conflicts.map((conflict) => conflict.key));
    return {
      retargeted: reconciler
        .desired(inputs)
        .filter((d) => !skipped.has(d.dest))
        .map((d) => ({ path: d.dest, tools: tools(d.folder, d.checkout) })),
      skipped: [...skipped],
    };
  }

  /**
   * A health check from inside a command, e.g. a durable operation's step (Step 8): the same work, with its events.
   */
  checkNow(emit: (event: DomainEvent) => void): Promise<LinkCheckReport> {
    return this.#check(undefined, emit);
  }

  /** The skill links' plan and the exclude entries' plan, with one hash (IMPLEMENTATION.md §2.5 "Plans combine"). */
  async #planAll(
    reconciler: ReturnType<typeof skillLinkReconciler>,
    inputs: SkillLinkInputs,
    change?: unknown,
  ): Promise<{ links: Plan<SkillLinkAction>; entries: Plan<unknown>; hash: string }> {
    const links = await this.#deps.runner.plan(reconciler, inputs);
    const entries = await this.#companion(inputs, change).plan();
    return { links, entries, hash: combinePlans([links, entries]).hash };
  }

  #companion(inputs: SkillLinkInputs, change?: unknown): CompanionReconcile {
    const { placement, paths } = this.#deps;
    if (!placement) return NO_COMPANION;
    return placement.companion(desiredSkillLinks(inputs, {}, paths), change);
  }

  /**
   * Applies both plans: new exclude entries first, so a new link in a code repo never shows in `git status`; then the
   * links; then the entries that go. Each part checks its own plan's hash.
   */
  async #applyAll(
    reconciler: ReturnType<typeof skillLinkReconciler>,
    inputs: SkillLinkInputs,
    plans: { links: Plan<SkillLinkAction>; entries: Plan<unknown> },
    signal?: AbortSignal,
    change?: unknown,
  ): Promise<number> {
    const companion = this.#companion(inputs, change);
    const before = await companion.apply('before');
    const report = await this.#deps.runner.apply(reconciler, inputs, {
      expectedHash: plans.links.hash,
      ...(signal ? { signal } : {}),
    });
    // The combined hash was checked before anything ran; the entries' plan changed with the first part.
    const after = await companion.apply('after');
    await this.#tidyFolders();
    return before + report.applied + after;
  }

  /**
   * The link folders the app made in code repos go again once nothing of the app's is in them (PLAN.md §3.6
   * "Worktrees", A6.16): after the links changed, and at every check. No confirmation shows them: no link changes.
   */
  async #tidyFolders(): Promise<void> {
    const { store, runner, fs, paths, logger } = this.#deps;
    const records = store.read((tx) => tx.registry.list(LINK_FOLDER_KIND));
    if (records.length === 0) return;
    for (const record of records) this.#made.add(record.key);
    const kept = new Set(
      this.#rows()
        .filter(([, row]) => KEEPS_FOLDER.includes(row.status))
        .map(([, row]) => row.folder),
    );
    await runner.apply(madeFolderReconciler({ fs, paths, logger }), { kept: [...kept] });
  }

  /** The links now match HEAD's skills: the next comparison starts here (PLAN.md §3.10 "Adjusting links"). */
  async #recordBaseline(revision: string | null = null): Promise<void> {
    if (revision !== null) await this.#deps.baseline.record(revision);
    else if ((await this.#deps.repo.resolve('HEAD')) !== null) await this.#deps.baseline.record('HEAD');
  }

  #report(state: LinkCheckReport['state'], applied: number, emit: (event: DomainEvent) => void): LinkCheckReport {
    const changed = state !== this.#state || applied > 0;
    this.#state = state;
    const attention = this.attention().length;
    if (changed || state === 'done')
      emit({ type: 'LinksChanged', at: this.#deps.clock.now(), attention } as LinksChanged);
    return { state, applied, attention };
  }

  /**
   * S6: a rename git reports moves the user's choices to the new name; renames and deletions are announced. The
   * announcement comes back to run after the baseline is recorded: a check that stops before (a plan that changed
   * during a pull) announces nothing, and the next check, which sees the same changes, announces them once.
   */
  async #followRenames(): Promise<{ announce: () => void; head: string | null }> {
    const { baseline, repo, logger } = this.#deps;
    // HEAD once: the diff and the baseline recorded after the check are of the same commit.
    const head = await repo.resolve('HEAD').catch(() => null);
    if (head === null) return { announce: () => {}, head };
    const diff = await baseline.diffSince(head).catch((error: unknown) => {
      logger.warn('the applied-state baseline can not be compared', { error: String(error) });
      return null;
    });
    if (!diff) return { announce: () => {}, head };
    const authorOf = async (skill: string) => {
      if (!diff.exact) return null;
      const [commit] = await repo
        .log({ range: `${diff.from}..${diff.to}`, paths: [itemOf(skill)], max: 1 })
        .catch(() => []);
      return commit?.author.name ?? null;
    };
    const announcements: Array<() => void> = [];
    for (const rename of diff.changes.renamed) {
      this.skillRenamed(rename.from, rename.to);
      const author = await authorOf(rename.to);
      announcements.push(() => {
        this.#deps.activity.append([
          {
            kind: 'renamed',
            path: itemOf(rename.to),
            author,
            commit: diff.to,
            details: { from: rename.from, to: rename.to },
          },
        ]);
        this.#deps.notify({ type: 'renamed', from: rename.from, to: rename.to, author });
      });
    }
    for (const skill of diff.changes.deleted) {
      const linked = this.#rows().some(([, row]) => row.skill === skill);
      if (linked) announcements.push(() => this.#deps.notify({ type: 'removed', skill, author: null }));
    }
    if (diff.from !== diff.to) announcements.push(() => this.#deps.baselineMoved?.(diff));
    return {
      announce: () => {
        for (const announcement of announcements) announcement();
      },
      head,
    };
  }

  /**
   * A skill was renamed, in git (S6) or in the editor (A10.8): its placement choices and the user's answers to its
   * warnings move to the new name. The next check moves the links.
   */
  skillRenamed(from: string, to: string): void {
    const { store, paths, clock } = this.#deps;
    this.#deps.placement?.renamed(from, to);
    const now = clock.now();
    // Under a local prefix (Step 8) a choice's path has the skill's local name.
    const naming = this.#deps.projection?.naming() ?? null;
    store.write((tx) => {
      for (const record of tx.registry.list(SKILL_LINK_KIND)) {
        const row = readRow(record);
        if (!row || row.skill !== from || !CHOICES.includes(row.status)) continue;
        const name = row.nameSource === 'local-prefix' && naming ? naming.name(to) : to;
        if (name === null) continue;
        const dest = paths.join(row.folder, name);
        // Under a local prefix a prefix change keeps the name (Step 14): the row stays where it is.
        if (dest !== record.key) tx.registry.delete(SKILL_LINK_KIND, record.key);
        tx.registry.put(SKILL_LINK_KIND, dest, { ...row, skill: to, item: itemOf(to) }, now);
      }
      // The old folder is gone from the disk, and git may still have it: that is a rename, not a deletion. A folder that
      // was renamed twice before the commit still goes to the last name: the first mark follows it.
      for (const record of tx.registry.list(RENAMED_AWAY_KIND)) {
        if ((record.data as { to?: unknown }).to === from) tx.registry.put(RENAMED_AWAY_KIND, record.key, { to }, now);
      }
      tx.registry.put(RENAMED_AWAY_KIND, from, { to }, now);
    });
  }

  /**
   * The renames the editor made that git does not have yet: the old folder, and the name it got. The commit check uses
   * them, so a rename is not called a deletion that is "gone for everyone".
   */
  renames(): ReadonlyMap<string, string> {
    const renames = new Map<string, string>();
    for (const record of this.#deps.store.read((tx) => tx.registry.list(RENAMED_AWAY_KIND))) {
      const to = (record.data as { to?: unknown }).to;
      if (typeof to === 'string') renames.set(record.key, to);
    }
    return renames;
  }

  /**
   * The folders that the editor renamed, that git still has, and that are not on the disk: the link check takes them for
   * neither a skill nor a skill deleted on this device. The disk decides, not the library snapshot, which a watcher
   * reads a moment after the rename: a check that runs first must not see the old name as a skill.
   */
  async #renamedAway(inGit: readonly string[]): Promise<Set<string>> {
    const { store, fs, paths } = this.#deps;
    const marked = store.read((tx) => tx.registry.list(RENAMED_AWAY_KIND)).map((record) => record.key);
    const active = new Set<string>();
    if (marked.length === 0) return active;
    const git = new Set(inGit);
    for (const folder of marked) {
      if (!git.has(folder)) continue;
      const at = paths.join(this.#deps.libraryRoot(), 'skills', folder) as AbsPath;
      if ((await fs.lstat(at)) === undefined) active.add(folder);
    }
    return active;
  }

  /** The marks that no longer apply end: git has lost the old folder (the rename was committed), or it is back. */
  async #endRenamedAway(): Promise<void> {
    const { store } = this.#deps;
    if (this.#headSkills === null) return;
    const active = await this.#renamedAway(this.#headSkills.folders);
    const ended = store.read((tx) => tx.registry.list(RENAMED_AWAY_KIND)).filter((record) => !active.has(record.key));
    if (ended.length === 0) return;
    store.write((tx) => {
      for (const record of ended) tx.registry.delete(RENAMED_AWAY_KIND, record.key);
    });
  }

  /** One skill's links and the tools that read each (the editor's "What the agent sees"). */
  linksOf(skill: string): SkillLinksState['skills'][number]['links'] {
    return this.#skillLinks().skills.find((entry) => entry.skill === skill)?.links ?? [];
  }

  // ---- User commands -------------------------------------------------------------------------------------------

  async #setTools(
    enabled: readonly string[],
    planHash: string,
    emit: (event: DomainEvent) => void,
  ): Promise<LinkCheckReport> {
    const { store, clock } = this.#deps;
    if (this.#deps.active?.() === false) throw new AppError('setup.wrongStep', { step: 'setting-up' });
    const wanted = this.#enabledKnown(enabled);
    const inputs = await this.#inputs(wanted);
    const plans = await this.#planAll(this.#reconciler(), inputs);
    // The confirmed plan covers the tools too: the same links with other tools enabled is another plan.
    if (toolsHash(plans.hash, wanted) !== planHash) throw new AppError('plan.changed', { kind: SKILL_LINK_KIND });
    const before = store.read((tx) => tx.settings.get());
    const names = new Map(this.#resolved().map((tool) => [tool.id, tool.name]));
    const added = wanted.filter((id) => !before.enabledTools.includes(id));
    const removed = before.enabledTools.filter((id) => !wanted.includes(id));
    store.write((tx) => {
      tx.settings.set({ ...tx.settings.get(), enabledTools: [...wanted] });
      this.#deps.activity.appendIn(tx, [
        ...added.map((id) => ({ kind: 'tool-enabled' as const, path: null, details: { tool: names.get(id) ?? id } })),
        ...removed.map((id) => ({
          kind: 'tool-disabled' as const,
          path: null,
          details: { tool: names.get(id) ?? id },
        })),
      ]);
    });
    const warnings = this.#warnings();
    const started = clock.now();
    const applied = await this.#applyAll(this.#reconciler(), inputs, plans);
    this.#afterApply(plans.links, started);
    await this.#recordBaseline();
    this.#notifyNewWarnings(warnings);
    return this.#report('done', applied, emit);
  }

  // ---- Placement changes (Step 6) ------------------------------------------------------------------------------

  /** The plan a placement change would apply: what its confirmation shows (PLAN.md §3.6). */
  async previewChange(change: unknown): Promise<{ view: LinkPlanView; hash: string }> {
    const inputs = await this.#inputs(null, {}, change);
    const plans = await this.#planAll(this.#reconciler(), inputs, change);
    return { view: { ...this.#planView(plans.links, null), hash: plans.hash }, hash: plans.hash };
  }

  /**
   * A pull's dry run (IMPLEMENTATION.md §2.5): the plan that would make the links match `library`, with a placement
   * change applied (the answers to the preview's questions). Nothing changes; the pull checks the same hash before it
   * starts.
   */
  async previewLibrary(library: PreviewLibrary, change: unknown): Promise<LinkPreview> {
    const inputs = await this.#inputs(null, {}, change, library);
    const plans = await this.#planAll(this.#reconciler(), inputs, change);
    const skills = inputs.skills.map((skill) => skill.folder);
    const places = this.#deps.placement?.previewPlaces(skills, change, library) ?? {
      placements: skills.map((skill) => ({ skill, kind: 'global', global: true, repos: [] })),
      tagsGone: [],
    };
    const name = (id: string) => this.#deps.placement?.repoName(id) ?? id;
    const before = new Map<string, PlacedWhere>();
    for (const [skill, where] of this.#placedNow()) {
      before.set(skill, { global: where.global, repos: where.repos.map(name).sort() });
    }
    return {
      view: { ...this.#planView(plans.links, null), hash: plans.hash },
      hash: plans.hash,
      links: desiredSkillLinks(inputs, {}, this.#deps.paths)
        .filter((d) => !d.deletedLocally)
        .map((d) => ({ dest: d.dest, target: d.target, skill: d.skill })),
      before,
      places,
    };
  }

  /** The tools on this device and the enabled ones: for placement's analysis of nested repos (A6.12). */
  toolsSnapshot(): { tools: ResolvedTool[]; enabled: string[] } {
    return { tools: this.#resolved(), enabled: this.#enabled() };
  }

  /**
   * Applies a confirmed placement change: refused with `plan.changed` when its plan isn't the one confirmed. `persist`
   * writes the change once the plan checks out; the links then follow it. Run it inside a command.
   */
  async applyChange(
    change: unknown,
    planHash: string,
    persist: () => void,
    emit: (event: DomainEvent) => void,
  ): Promise<LinkCheckReport> {
    if (this.#deps.active?.() === false) throw new AppError('setup.wrongStep', { step: 'setting-up' });
    const inputs = await this.#inputs(null, {}, change);
    const plans = await this.#planAll(this.#reconciler(), inputs, change);
    if (plans.hash !== planHash) throw new AppError('plan.changed', { kind: SKILL_LINK_KIND });
    persist();
    const warnings = this.#warnings();
    const started = this.#deps.clock.now();
    const applied = await this.#applyAll(this.#reconciler(), inputs, plans, undefined, change);
    this.#afterApply(plans.links, started);
    this.#notifyNewWarnings(warnings);
    return this.#report('done', applied, emit);
  }

  // ---- The setup wizard (Step 15) --------------------------------------------------------------------------------

  /**
   * The links a setup's [Finish] makes (PLAN.md §3.17 steps 8–9): the plan with the wizard's tools, tag ticks and
   * name answers as inputs, while nothing of them is the instance's settings yet. `taken` lists the names already
   * taken on this device, with or without an answer: the name check asks about each.
   */
  async previewSetup(setup: SetupLinkInputs): Promise<SetupLinkPreview> {
    const { enabled, asked, inputs } = await this.#setupInputs(setup);
    const open = await this.#deps.runner.plan(this.#reconciler(), asked);
    const plans = await this.#planAll(this.#reconciler(), inputs, setup.change);
    const tools = this.#folderToolsFor(enabled);
    const wanted = new Set(desiredSkillLinks(inputs, {}, this.#deps.paths).map((d) => d.dest));
    const taken = open.actions.flatMap((action) =>
      action.op === 'mark' && action.status === 'skipped' && wanted.has(action.dest)
        ? [
            {
              dest: action.dest,
              skill: action.skill,
              folder: action.folder,
              reason: action.reason,
              repo: action.repo ?? null,
              tools: tools(action.folder, action.checkout),
            },
          ]
        : [],
    );
    return {
      hash: plans.hash,
      view: { ...this.#planView(plans.links, enabled), hash: plans.hash },
      skills: inputs.skills
        .filter((skill) => !skill.deletedLocally)
        .map((skill) => ({ skill: skill.folder, global: skill.global ?? true, repos: [...(skill.repos ?? [])] })),
      taken,
      links: plans.links.actions.flatMap((action) =>
        action.op === 'mark' ? [] : [{ op: action.op, dest: action.dest, skill: action.skill }],
      ),
      skipped: plans.links.actions.flatMap((action) =>
        action.op === 'mark'
          ? [
              {
                skill: action.skill,
                dest: action.dest,
                status: action.status,
                tools: tools(action.folder, action.checkout),
              },
            ]
          : [],
      ),
    };
  }

  /**
   * [Finish] (PLAN.md §3.17 step 10): refused with `plan.changed` when the plan isn't the one the summary showed. Then
   * `persist` writes the wizard's choices, and the links, the exclude entries and the projected copies follow them, as
   * in a health check. Run it inside a command, before the setup's state goes.
   */
  async applySetup(
    setup: SetupLinkInputs,
    planHash: string,
    persist: () => void,
    emit: (event: DomainEvent) => void,
  ): Promise<number> {
    const { inputs } = await this.#setupInputs(setup);
    const plans = await this.#planAll(this.#reconciler(), inputs, setup.change);
    if (plans.hash !== planHash) throw new AppError('plan.changed', { kind: SKILL_LINK_KIND });
    persist();
    const skills = inputs.skills.map((skill) => skill.folder);
    const started = this.#deps.clock.now();
    let applied = (await this.#deps.projection?.before(skills)) ?? 0;
    applied += await this.#applyAll(this.#reconciler(), inputs, plans, undefined, setup.change);
    this.#afterApply(plans.links, started);
    applied += (await this.#deps.projection?.after(skills)) ?? 0;
    await this.#recordBaseline();
    this.#report('done', applied, emit);
    return applied;
  }

  /** The tools on this device, with the ones found and the enabled ones (the wizard's tools page). */
  tools(): Promise<ToolsState> {
    return this.#tools();
  }

  /** The link folders the catalog chooses for these tools (PLAN.md §3.4). */
  linkFolders(enabled: readonly string[]): string[] {
    return this.#choice(this.#enabledKnown(enabled)).folders.map((folder) => folder.path);
  }

  /** Exact paths the guard lets the app work at from now on: a setup's own folders it moves (Step 15). */
  allowPaths(paths: readonly string[]): void {
    for (const path of paths) this.#allowed.add(this.#deps.paths.normalize(path));
  }

  /**
   * A setup's inputs: without its answers (what the name check asks about), and with them. Only answers for paths the
   * links want count; a moved folder's new name must be free.
   */
  async #setupInputs(
    setup: SetupLinkInputs,
  ): Promise<{ enabled: string[]; asked: SkillLinkInputs; inputs: SkillLinkInputs }> {
    const enabled = this.#enabledKnown(setup.enabled);
    const asked = await this.#inputs(enabled, {}, setup.change);
    const wanted = new Set(desiredSkillLinks(asked, {}, this.#deps.paths).map((d) => d.dest));
    const decisions: Record<string, LinkDecision> = {};
    for (const [dest, decision] of Object.entries(setup.decisions)) {
      if (!wanted.has(dest)) continue;
      await this.#allowMoveTarget(dest, decision);
      decisions[dest] = decision;
    }
    return { enabled, asked, inputs: { ...asked, decisions } };
  }

  /** The tool names that read a folder, among `enabled`. */
  #folderToolsFor(enabled: readonly string[]): (folder: string, checkout?: string | null) => string[] {
    const tools = this.#resolved().filter((tool) => enabled.includes(tool.id));
    const { paths } = this.#deps;
    return (folder, checkout) => {
      const inRepo = checkout ? paths.relative(checkout, folder) : undefined;
      return tools
        .filter((tool) =>
          inRepo === undefined
            ? tool.skillDirs.some((dir) => paths.same(dir, folder))
            : tool.repoSkillDirs.some((dir) => paths.normalize(dir) === paths.normalize(inRepo)),
        )
        .map((tool) => tool.name);
    };
  }

  /** Where each skill is linked now, from the registry: what "before" means for a move. */
  #placedNow(): SkillWhere {
    const out = new Map<string, { global: boolean; repos: string[] }>();
    for (const [, row] of this.#rows()) {
      if (row.status !== 'linked') continue;
      const where = out.get(row.skill) ?? { global: false, repos: [] };
      const repo = row.repo ?? null;
      if (repo === null) where.global = true;
      else if (!where.repos.includes(repo)) where.repos.push(repo);
      out.set(row.skill, where);
    }
    return out;
  }

  /**
   * Links that moved in a health check moved with no preview: a branch switch, a stash or another git tool changed
   * the skill's tags or the rules' tags. They're listed in one notification (PLAN.md §3.6 "Nothing moves silently").
   */
  async #notifyMoves(before: SkillWhere): Promise<void> {
    const after = this.#placedNow();
    const name = (id: string) => this.#deps.placement?.repoName(id) ?? id;
    const moves: PlacementMove[] = [];
    for (const [skill, was] of before) {
      const now = after.get(skill) ?? { global: false, repos: [] };
      const key = (w: { global: boolean; repos: readonly string[] }) => `${w.global}:${[...w.repos].sort().join(',')}`;
      if (key(was) === key(now)) continue;
      // A skill whose links all went with the skill itself (S6) has its own notice. A folder that is gone from the disk
      // is such a skill: deleted, renamed in the editor, or discarded. The disk decides, not the library snapshot,
      // which a watcher reads a moment after the change.
      if (!this.#deps.snapshot()?.skills.some((s) => s.folder === skill)) continue;
      if (!(await this.#skillOnDisk(skill))) continue;
      moves.push({
        skill,
        from: { global: was.global, repos: was.repos.map(name).sort() },
        to: { global: now.global, repos: now.repos.map(name).sort() },
      });
    }
    if (moves.length > 0) this.#deps.notify({ type: 'moved', moves });
  }

  async #resolve(
    dest: string,
    decision: LinkDecision,
    planHash: string,
    emit: (event: DomainEvent) => void,
  ): Promise<LinkCheckReport> {
    const { runner, clock } = this.#deps;
    this.#checkDecision(dest, decision);
    await this.#allowMoveTarget(dest, decision);
    const inputs = await this.#inputs(null, { [dest]: decision });
    const reconciler = this.#reconciler({ only: [dest] });
    const plan = await runner.plan(reconciler, inputs);
    if (plan.hash !== planHash) throw new AppError('plan.changed', { kind: SKILL_LINK_KIND });
    const warnings = this.#warnings();
    const started = clock.now();
    const report = await runner.apply(reconciler, inputs, { expectedHash: planHash });
    this.#afterApply(plan, started);
    this.#notifyNewWarnings(warnings);
    return this.#report('done', report.applied, emit);
  }

  #checkDecision(dest: string, decision: LinkDecision): void {
    const row = this.#row(dest);
    // [Try again] for a path the app could not write: the same answer as for a missing link.
    const tryAgain = decision.kind === 'reinstall' && row?.status === 'skipped' && row.reason === 'no-access';
    if (!row || !(tryAgain || ANSWERS[row.status].includes(decision.kind))) {
      throw new AppError('links.noWarning', { path: dest });
    }
    if (decision.kind !== 'move-aside') return;
    this.checkMoveName(decision.name);
  }

  /**
   * A moved folder's new name (S2 [Move my folder]): a valid skill name that starts with no prefix in use here, so the
   * user's folder never clashes with a company skill again.
   */
  checkMoveName(name: string): void {
    const trimmed = name.trim();
    const prefixes = this.#deps.prefixesInUse();
    if (
      agentSkillNameProblems(trimmed).length > 0 ||
      prefixes.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix}-`))
    ) {
      throw new AppError('links.nameInvalid', { name: trimmed });
    }
  }

  /** The folder a moved copy goes to: checked free right before, and allowed for that one write (PLAN.md §3.8). */
  async #allowMoveTarget(dest: string, decision: LinkDecision): Promise<void> {
    if (decision.kind !== 'move-aside') return;
    const { paths, fs } = this.#deps;
    const to = paths.join(paths.dirname(dest), decision.name.trim());
    this.#allowed.add(to);
    if (await fs.lstat(to as AbsPath)) throw new AppError('links.pathTaken', { path: to });
  }

  // ---- Inputs and views ----------------------------------------------------------------------------------------

  #reconciler(scope: { only?: readonly string[]; forgetChoices?: boolean } = {}) {
    const d = this.#deps;
    const placement = d.placement;
    const reconcilerDeps: SkillLinkReconcilerDeps = {
      fs: d.fs,
      links: d.links,
      strategy: d.strategy,
      trash: d.trash,
      paths: d.paths,
      logger: d.logger,
      libraryRoot: d.libraryRoot,
      versions: async (item) => {
        const folder = item.slice(item.indexOf('/') + 1);
        const current = d.snapshot()?.skills.find((skill) => skill.folder === folder)?.fingerprint ?? null;
        const older = await d.repo.pathVersions(item, { max: 200 }).catch(() => []);
        return { current, older };
      },
      ...(placement ? { committed: (checkout: string, dest: string) => placement.committed(checkout, dest) } : {}),
      ...(d.instanceId === undefined ? {} : { instanceId: d.instanceId }),
      ...(d.ignored ? { ignored: async (paths: readonly string[]) => new Set(await d.ignored?.(paths)) } : {}),
      ...(d.projection
        ? {
            rowTarget: (row: SkillLinkRow, dest: string) =>
              row.nameSource === 'local-prefix' && d.projection
                ? d.paths.join(d.projection.root, d.paths.basename(dest))
                : targetOfItem(d, row.item),
          }
        : {}),
    };
    return skillLinkReconciler(reconcilerDeps, scope);
  }

  #resolved(): ResolvedTool[] {
    return resolveTools(this.#deps.catalog(), this.#deps.home, this.#deps.toolSettings(), this.#deps.paths);
  }

  #enabled(): string[] {
    const known = new Set(this.#resolved().map((tool) => tool.id));
    return this.#deps.store.read((tx) => tx.settings.get()).enabledTools.filter((id) => known.has(id));
  }

  #enabledKnown(enabled: readonly string[]): string[] {
    const known = new Set(this.#resolved().map((tool) => tool.id));
    for (const id of enabled) if (!known.has(id)) throw new AppError('tools.unknown', { tool: id });
    return [...new Set(enabled)].sort();
  }

  #choice(enabled: readonly string[]): LinkFolderChoice {
    return chooseLinkFolders(this.#resolved(), enabled, this.#deps.paths);
  }

  /** The tool names that read a folder, among the enabled ones; in a code repo, the folder inside its checkout. */
  #folderTools(): (folder: string, checkout?: string | null) => string[] {
    const tools = this.#resolved();
    const enabled = new Set(this.#enabled());
    const { paths } = this.#deps;
    return (folder, checkout) => {
      const inRepo = checkout ? paths.relative(checkout, folder) : undefined;
      return tools
        .filter((tool) => enabled.has(tool.id))
        .filter((tool) =>
          inRepo === undefined
            ? tool.skillDirs.some((dir) => paths.same(dir, folder))
            : tool.repoSkillDirs.some((dir) => paths.normalize(dir) === paths.normalize(inRepo)),
        )
        .map((tool) => tool.name);
    };
  }

  /** The skill folders HEAD has: skills deleted in the folder but still in git stay wanted (S8). */
  #headSkills: { commit: string; folders: string[] } | null = null;

  #snapshotHead(skill: string): boolean {
    return this.#headSkills?.folders.includes(skill) ?? false;
  }

  /**
   * Whether a skill's folder is on the disk with something in it. A folder that a discard or a rename emptied is not a
   * skill: the library scan ignores it too (no files).
   */
  async #skillOnDisk(folder: string): Promise<boolean> {
    const { fs, paths } = this.#deps;
    const at = paths.join(this.#deps.libraryRoot(), 'skills', folder) as AbsPath;
    return (await fs.lstat(at))?.kind === 'dir' && (await fs.list(at).catch(() => [])).length > 0;
  }

  /** The skills of a library scan whose folder is still on the disk. */
  async #onDisk<T extends { readonly folder: string }>(skills: readonly T[]): Promise<T[]> {
    const there = await mapLimit(skills, 16, (skill) => this.#skillOnDisk(skill.folder));
    return skills.filter((_, index) => there[index]);
  }

  async #currentHeadSkills(
    repo: LinkServiceDeps['repo'],
    baseline: AppliedStateBaseline,
  ): Promise<{ commit: string; folders: string[] } | null> {
    const head = await repo.resolve('HEAD').catch(() => null);
    if (head === null) this.#headSkills = null;
    else if (this.#headSkills?.commit !== head) {
      const folders = (await baseline.skillsAt(head)).map((skill) => skill.folder);
      this.#headSkills = { commit: head, folders };
    }
    return this.#headSkills;
  }

  async #inputs(
    enabled: readonly string[] | null,
    decisions: Readonly<Record<string, LinkDecision>> = {},
    change?: unknown,
    library?: PreviewLibrary,
  ): Promise<SkillLinkInputs> {
    const { repo, baseline, paths } = this.#deps;
    const snapshot = library?.snapshot ?? this.#deps.snapshot();
    // Without the library's snapshot every skill would look deleted: nothing is planned until it's read.
    if (!snapshot) throw new AppError('links.notReady');
    // A preview's skill folders in git are the pull's tree's; the cache stays HEAD's.
    const headSkills = library
      ? { commit: library.tree, folders: (await baseline.skillsAt(library.tree)).map((skill) => skill.folder) }
      : await this.#currentHeadSkills(repo, baseline);
    // The library scan is read a moment after a change: right after a rename in the editor, a folder that is gone from
    // the disk is not a skill any more, whatever the scan still lists. The disk is asked only then (a mark of a pending
    // rename exists): asking for every skill on every check costs a second in a library of a thousand skills. A
    // preview's tree is not on the disk.
    const renamePending = !library && this.#deps.store.read((tx) => tx.registry.list(RENAMED_AWAY_KIND).length > 0);
    const scanned = renamePending ? await this.#onDisk(snapshot?.skills ?? []) : (snapshot?.skills ?? []);
    const present = new Map(scanned.map((skill) => [skill.folder, skill]));
    // Under a local prefix (Step 8) each skill's link has its local name and points at its projected copy; a skill
    // whose name can't be made local is skipped here.
    const projection = this.#deps.projection;
    const naming =
      (library
        ? projection?.naming({
            gitPrefix: library.snapshot.config.prefix,
            localPrefix: library.localPrefix === undefined ? projection.localPrefix : library.localPrefix,
          })
        : projection?.naming()) ?? null;
    const named = (folder: string, deletedLocally: boolean): LinkableSkill | null => {
      if (!naming) return { folder, deletedLocally };
      const name = naming.name(folder);
      return name === null ? null : { folder, deletedLocally, name, target: naming.target(name) };
    };
    const skills: LinkableSkill[] = [];
    // A pull's preview looks at the pull's tree, not at this device's renames.
    const renamedAway = library ? new Set<string>() : await this.#renamedAway(headSkills?.folders ?? []);
    for (const skill of scanned) {
      if (skill.name !== skill.folder || skill.files === 0) continue;
      if (renamedAway.has(skill.folder)) continue;
      const linkable = named(skill.folder, false);
      if (linkable) skills.push(linkable);
    }
    for (const folder of headSkills?.folders ?? []) {
      const here = present.get(folder);
      if (here && here.files > 0) continue;
      if (renamedAway.has(folder)) continue;
      const linkable = named(folder, true);
      if (linkable) skills.push(linkable);
    }
    naming?.done();
    const tools = enabled ?? this.#enabled();
    const choice = this.#choice(tools);
    const folders = choice.folders.map((folder) => ({ path: folder.path, ...(folder.copy ? { copy: true } : {}) }));
    // Placement (Step 6): each skill goes to the global folders, or to its repos' folders in every checkout.
    const placed = this.#deps.placement
      ? await this.#deps.placement.place(
          skills.map((skill) => skill.folder),
          { tools: this.#resolved(), enabled: tools, globalFolders: folders.map((f) => f.path) },
          change,
          library,
        )
      : null;
    const inputs: SkillLinkInputs = {
      libraryRoot: this.#deps.libraryRoot(),
      skills: skills
        .sort((a, b) => (a.folder < b.folder ? -1 : 1))
        .map((skill) => {
          const where = placed?.bySkill.get(skill.folder);
          return where ? { ...skill, global: where.global, repos: where.repos, repoFolders: where.repoFolders } : skill;
        }),
      folders,
      decisions,
      // Strays are found by git name; under a local prefix the app's links have other names (Step 8).
      strays: naming ? [] : (placed?.strays ?? []),
    };
    for (const desired of desiredSkillLinks(inputs, {}, paths)) this.#allowed.add(desired.dest);
    for (const stray of inputs.strays ?? []) this.#allowed.add(stray.dest);
    return inputs;
  }

  #rows(): Array<[string, SkillLinkRow]> {
    return this.#deps.store
      .read((tx) => tx.registry.list(SKILL_LINK_KIND))
      .flatMap((record) => {
        const row = readRow(record);
        return row ? [[record.key, row] as [string, SkillLinkRow]] : [];
      });
  }

  #row(dest: string): SkillLinkRow | null {
    return readRow(this.#deps.store.read((tx) => tx.registry.get(SKILL_LINK_KIND, dest)));
  }

  #warnings(): Map<string, SkillLinkStatus> {
    return new Map(
      this.#rows()
        .filter(([, row]) => isWarning(row.status))
        .map(([dest, row]) => [dest, row.status]),
    );
  }

  /** Each new red warning raises one notification (PLAN.md §3.19, A5.12). */
  #notifyNewWarnings(before: ReadonlyMap<string, SkillLinkStatus>): void {
    const folderTools = this.#folderTools();
    const deleted = new Set<string>();
    for (const [dest, row] of this.#rows()) {
      if (!isWarning(row.status) || before.get(dest) === row.status) continue;
      // One notification for a skill deleted on this device, however many tools lost it.
      if (row.status === 'deleted') {
        if (deleted.has(row.skill)) continue;
        deleted.add(row.skill);
      }
      this.#deps.notify({
        type: 'warning',
        status: row.status,
        skill: row.skill,
        tools: folderTools(row.folder, row.checkout),
      });
    }
  }

  /** The checkouts in code repos that hold a row of the app's. */
  #checkouts(): Set<string> {
    const out = new Set<string>();
    for (const [, row] of this.#rows()) if (row.checkout) out.add(row.checkout);
    return out;
  }

  /**
   * Activity-log entries for what an apply did, one per skill and kind (PLAN.md §3.13). In a health check, a worktree
   * that held no row of the app's before (`linkedBefore`), e.g. one an agent just made, gets one `worktree-linked` entry
   * for all its new links: agents make worktrees often, and one entry per skill would bury the rest.
   */
  #afterApply(plan: Plan<SkillLinkAction>, started: number, linkedBefore?: ReadonlySet<string>): void {
    const folderTools = this.#folderTools();
    const { placement, paths } = this.#deps;
    const mains = new Map<string, string | null>();
    const freshWorktree = (action: SkillLinkAction): string | null => {
      if (!linkedBefore || !placement || action.op !== 'create') return null;
      const { checkout, repo } = action;
      if (!checkout || !repo || linkedBefore.has(checkout)) return null;
      if (!mains.has(repo)) mains.set(repo, placement.repoFolder(repo));
      const main = mains.get(repo) ?? null;
      return main !== null && !paths.same(main, checkout) ? checkout : null;
    };
    const worktrees = new Map<string, { repo: string; skills: Set<string>; tools: Set<string> }>();
    const trashed = new Map(
      this.#deps.trash
        .list()
        .filter((entry) => entry.trashedAt >= started)
        .map((entry) => [entry.originalPath, entry.id]),
    );
    const groups = new Map<
      string,
      { kind: ActivityEntry['kind']; skill: string; tools: Set<string>; extra: Record<string, JsonValue> }
    >();
    const repos = new Map<string, Set<string>>();
    // A repo's name is read once per apply: the `large` world creates 25,000 links in one (Step 17).
    const repoNames = new Map<string, string>();
    const repoName = (id: string) => {
      if (!repoNames.has(id)) repoNames.set(id, this.#deps.placement?.repoName(id) ?? id);
      return repoNames.get(id) ?? id;
    };
    const add = (kind: ActivityEntry['kind'], action: SkillLinkAction, extra: Record<string, JsonValue> = {}) => {
      const key = `${kind}\u0000${action.skill}`;
      const group = groups.get(key) ?? { kind, skill: action.skill, tools: new Set<string>(), extra: {} };
      if ('folder' in action && action.folder !== undefined) {
        for (const tool of folderTools(action.folder, action.checkout)) group.tools.add(tool);
      }
      // Where it went or left: "Installed acme-caching into backend-api" (PLAN.md §3.8 S1 step 4).
      const repo = 'repo' in action ? (action.repo ?? null) : null;
      if (repo !== null) {
        const names = repos.get(key) ?? new Set<string>();
        names.add(repoName(repo));
        repos.set(key, names);
      }
      const trashId = trashed.get(action.dest);
      group.extra = { ...group.extra, ...extra, ...(trashId ? { trashId } : {}) };
      groups.set(key, group);
    };
    for (const action of plan.actions) {
      switch (action.op) {
        case 'create': {
          const worktree = freshWorktree(action);
          if (worktree === null) {
            add('installed', action);
            break;
          }
          const entry = worktrees.get(worktree) ?? { repo: action.repo ?? '', skills: new Set(), tools: new Set() };
          entry.skills.add(action.skill);
          for (const tool of folderTools(action.folder, action.checkout)) entry.tools.add(tool);
          worktrees.set(worktree, entry);
          break;
        }
        case 'replace':
          if (action.why === 'take-back') add('taken-back', action);
          else if (action.why === 'overwrite') add('installed', action, { overwrote: true });
          else add('relinked', action, { why: action.why });
          break;
        case 'move-aside':
          add('installed', action, { movedTo: this.#deps.paths.basename(action.to) });
          break;
        case 'bring-in':
          add('brought-in', action);
          break;
        case 'mark':
          if (action.status === 'skipped') add('skipped', action, { reason: action.reason });
          else if (action.status === 'suppressed') add('suppressed', action);
          else if (action.status === 'detached-by-user') add('detached', action);
          break;
        case 'remove':
          add('removed', action);
          break;
        case 'drop':
          add('removed', action, { duplicate: true });
          break;
        // A copy that follows the library, or a row only recorded: nothing the user did.
        case 'adopt':
        case 'refresh':
        case 'forget':
          break;
      }
    }
    this.#deps.activity.append([
      ...[...groups.entries()].map(([key, group]) => ({
        kind: group.kind,
        path: itemOf(group.skill),
        details: {
          skill: group.skill,
          tools: [...group.tools].sort(),
          ...(repos.has(key) ? { repos: [...(repos.get(key) ?? [])].sort() } : {}),
          ...group.extra,
        },
      })),
      ...[...worktrees.entries()].map(([worktree, entry]) => ({
        kind: 'worktree-linked' as const,
        path: null,
        details: {
          repo: placement?.repoName(entry.repo) ?? entry.repo,
          path: worktree,
          skills: [...entry.skills].sort(),
          tools: [...entry.tools].sort(),
        },
      })),
    ]);
  }

  #planView(plan: Plan<SkillLinkAction>, enabled: readonly string[] | null): LinkPlanView {
    // A copy that follows the library (Step 16) is no change the user decides on, like a row only recorded.
    const changes = plan.actions
      .filter((action) => action.op !== 'adopt' && action.op !== 'forget' && action.op !== 'refresh')
      .map((action) => ({
        op: action.op,
        skill: action.skill,
        dest: action.dest,
        folder: 'folder' in action ? action.folder : this.#deps.paths.dirname(action.dest),
        status: action.op === 'mark' ? action.status : null,
        method:
          ('method' in action && action.method === 'copy') || (action.op === 'remove' && action.copy)
            ? ('copy' as const)
            : ('link' as const),
      }));
    const kept: Array<{ tool: string; folder: string; readers: string[] }> = [];
    let folders: string[] = [];
    if (enabled) {
      const tools = this.#resolved();
      const names = new Map(tools.map((tool) => [tool.id, tool.name]));
      const now = new Set(this.#enabled());
      const choice = this.#choice(this.#enabledKnown(enabled));
      folders = choice.folders.map((folder) => folder.path);
      for (const id of [...now].filter((tool) => !enabled.includes(tool))) {
        const tool = tools.find((t) => t.id === id);
        for (const folder of choice.folders) {
          if (!tool?.skillDirs.some((dir) => this.#deps.paths.same(dir, folder.path))) continue;
          kept.push({
            tool: tool.name,
            folder: folder.path,
            readers: folder.enabledTools.map((reader) => names.get(reader) ?? reader),
          });
        }
      }
    }
    return { hash: plan.hash, changes, kept, folders };
  }

  async #tools(): Promise<ToolsState> {
    const tools = this.#resolved();
    const found = new Set(await detectTools(this.#deps.fs, tools));
    const enabled = new Set(this.#enabled());
    return {
      tools: tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        custom: tool.custom,
        found: tool.custom || found.has(tool.id),
        enabled: enabled.has(tool.id),
        home: tool.home,
        homeSource: tool.homeSource,
        homeEnv: tool.homeEnv,
        skillDirs: tool.skillDirs,
        sameNameHandling: tool.sameNameHandling,
        verified: tool.verified ? { version: tool.verified.version, date: tool.verified.date } : null,
        copy: !tool.followsLinks,
      })),
      choice: this.#choice([...enabled]),
    };
  }

  #skillLinks(): SkillLinksState {
    const folderTools = this.#folderTools();
    const rows = new Map(this.#rows());
    const choice = this.#choice(this.#enabled());
    const bySkill = new Map<string, SkillLinkView[]>();
    const { paths } = this.#deps;
    const naming = this.#deps.projection?.naming() ?? null;
    for (const skill of this.#deps.snapshot()?.skills ?? []) {
      if (skill.name !== skill.folder) continue;
      const name = naming ? naming.name(skill.folder) : skill.folder;
      if (name === null) continue;
      bySkill.set(
        skill.folder,
        choice.folders.map((folder) => {
          const dest = paths.join(folder.path, name);
          return {
            dest,
            folder: folder.path,
            tools: folderTools(folder.path),
            status: rows.get(dest)?.status ?? 'pending',
            method: folder.copy ? 'copy' : 'link',
          };
        }),
      );
    }
    for (const [dest, row] of rows) {
      const list = bySkill.get(row.skill) ?? [];
      if (!list.some((link) => link.dest === dest))
        list.push({
          dest,
          folder: row.folder,
          tools: folderTools(row.folder, row.checkout),
          status: row.status,
          method: row.method,
        });
      bySkill.set(row.skill, list);
    }
    // A skill placed only in code repos has rows there and none in the global folders: it isn't waiting for them.
    const inRepos = new Set([...rows.values()].filter((row) => (row.repo ?? null) !== null).map((row) => row.skill));
    for (const [skill, links] of bySkill) {
      if (!inRepos.has(skill)) continue;
      bySkill.set(
        skill,
        links.filter((link) => link.status !== 'pending'),
      );
    }
    return {
      state: this.#state,
      skills: [...bySkill.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([skill, links]) => ({ skill, links: links.sort((a, b) => (a.dest < b.dest ? -1 : 1)) })),
    };
  }

  /**
   * S4 [Show differences], and a copy edited where it is (Step 16): which files of the copy differ from the library's
   * (names only). A copy's marker file isn't the skill's, and its SKILL.md is read under the git name.
   */
  async #differences(dest: string): Promise<FileDifference[]> {
    const row = this.#row(dest);
    if (!row || (row.status !== 'diverged' && row.status !== 'copy-changed')) {
      throw new AppError('links.noWarning', { path: dest });
    }
    const { fs, paths } = this.#deps;
    const read = async (root: string): Promise<Map<string, string>> => {
      const files = new Map<string, string>();
      const visit = async (relative: string) => {
        const dir = (relative === '' ? root : paths.join(root, relative)) as AbsPath;
        for (const name of await fs.list(dir)) {
          const child = relative === '' ? name : `${relative}/${name}`;
          const at = paths.join(root, ...child.split('/')) as AbsPath;
          const entry = await fs.lstat(at);
          if (entry?.kind === 'dir') await visit(child);
          else if (entry?.kind === 'file') files.set(child, new TextDecoder().decode(await fs.readBytes(at)));
          else if (entry?.kind === 'link') files.set(child, `link:${await fs.readLink(at)}`);
        }
      };
      if ((await fs.lstat(root as AbsPath))?.kind === 'dir') await visit('');
      return files;
    };
    const mine = await read(dest);
    mine.delete(COPY_MARKER);
    const skillMd = mine.get('SKILL.md');
    if (skillMd !== undefined && paths.basename(dest) !== row.skill) {
      const restored = renamedSkillMd(new TextEncoder().encode(skillMd), row.skill);
      if (restored) mine.set('SKILL.md', new TextDecoder().decode(restored));
    }
    const library = await read(paths.join(this.#deps.libraryRoot(), ...row.item.split('/')));
    const junk = (path: string) => /(^|\/)(\.DS_Store|Thumbs\.db)$/.test(path);
    const out: FileDifference[] = [];
    for (const [path, text] of mine) {
      if (junk(path)) continue;
      if (!library.has(path)) out.push({ path, change: 'added' });
      else if (library.get(path) !== text) out.push({ path, change: 'changed' });
    }
    for (const path of library.keys()) if (!mine.has(path) && !junk(path)) out.push({ path, change: 'removed' });
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /** For the worker's log: failures of background checks other than a yield. */
  static quiet(error: unknown): boolean {
    return isAppError(error) && error.code === 'command.cancelled';
  }
}
