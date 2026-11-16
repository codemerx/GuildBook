// Placement of one instance (IMPLEMENTATION.md Step 6, PLAN.md §3.6): skills only where they're needed.
// - The user adds code repos, or parent folders where the app looks one level down for repos (never a library folder).
//   Each repo's remote names it and matches tag suggestions; its worktrees get the same links (§3.6 "Worktrees").
// - Tag rules, individual additions and exclusions, and each skill's mode decide where each skill goes; the pure
//   calculator does the sums. The link engine asks this service where each skill goes (it implements LinkPlacement),
//   so every trigger only changes inputs and runs the reconcilers (IMPLEMENTATION.md §2.5).
// - Every change the user makes is a list of edits: previewed as a plan, applied only if that plan still holds.
// - S10 (a repo folder gone) and a ticked tag that no longer exists are items in "Needs attention".
import {
  EXCLUDE_ENTRY_KIND,
  type ExcludeEntryRow,
  type RepoRecord,
  RepoRecordSchema,
  type SkillMode,
  type SkillLinkStatus,
} from '@app/schemas';
import type { ActivityLog } from '../../activity/index.ts';
import { chooseRepoLinkFolders, type ResolvedTool } from '../../catalog/index.ts';
import { defineCommand, defineQuery, type InstanceEngine, type ReconcileRunner } from '../../engine/index.ts';
import { type LibrarySnapshot, parseGitUrl } from '../../library/index.ts';
import type { PreviewLibrary, PreviewPlaces } from '../../sync/index.ts';
import {
  type AttentionItem,
  type ChosenFolder,
  CheckLinks,
  type CompanionReconcile,
  type LinkCheckReport,
  type LinkPlacement,
  type LinkPlanView,
  type LinkService,
  type PlacedSkills,
  type PlacementContext,
  type SkillLinkDesired,
  type StrayLink,
} from '../../links/index.ts';
import type { Clock } from '../../ports/clock.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Git } from '../../ports/git.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Random } from '../../ports/random.ts';
import type { Store, WriteTx } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import type { DomainEvent } from '../../shared/events.ts';
import { setList } from '../../shared/set-list.ts';
import { randomToken } from '../../shared/ids.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import {
  calculatePlacement,
  type PlacementKind,
  type RepoCell,
  repoCell,
  type SkillPlacement,
} from '../domain/calculator.ts';
import { excludeLine, hasLine } from '../domain/exclude-file.ts';
import {
  nestedRepos,
  nestedRepoWarnings,
  type NestedRepoWarning,
  remoteSlug,
  repoName,
  suggestedTags,
} from '../domain/repos.ts';
import { applyEdits, type PlacementEdit, type PlacementState, renameSkills } from '../domain/state.ts';
import { type ExcludeEntry, excludeKey, excludeReconciler, readExcludeRow } from './exclude-reconciler.ts';

type NoInput = Record<string, never>;

export const AddRepo = defineCommand<{ path: string }, RepoView>('AddRepo');
export const AddRepoRoot = defineCommand<{ path: string }, RepoView[]>('AddRepoRoot');
export const ApplyPlacement = defineCommand<{ edits: readonly PlacementEdit[]; planHash: string }, LinkCheckReport>(
  'ApplyPlacement',
);
export const LocateRepo = defineCommand<{ repo: string; path: string }, LinkCheckReport>('LocateRepo');
export const DismissSuggestion = defineCommand<{ repo: string; tag: string }, void>('DismissSuggestion');

export const OverviewQuery = defineQuery<NoInput, OverviewView>('Overview');
export const PreviewPlacement = defineQuery<{ edits: readonly PlacementEdit[] }, PlacementPlanView>('PreviewPlacement');
export const PlacementAnalysis = defineQuery<NoInput, NestedRepoWarning[]>('PlacementAnalysis');

/** A repo as the screens show it (PLAN.md §3.6 "Repo screen example"). */
export interface RepoView {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  /** `owner/name` from the remote, or the remote as git has it, or null. */
  readonly remote: string | null;
  /** The parent folder it was found in, or null when it was added itself. */
  readonly root: string | null;
  /** S10: the folder is gone since then; null while it's there. */
  readonly missingSince: number | null;
  /** Its other checkouts: the worktrees git lists, that exist (§3.6 "Worktrees"). */
  readonly worktrees: readonly string[];
  /** The ticked tags. */
  readonly rules: readonly string[];
  /** Ticked tags no skill carries any more. */
  readonly gone: readonly string[];
  /** Tags library.yaml suggests for its remote, not ticked and not turned down (§3.6). */
  readonly suggestions: readonly string[];
}

export type GlobalCell =
  | { readonly kind: 'placed' }
  /** Everywhere: global by choice. */
  | { readonly kind: 'by-choice' }
  | { readonly kind: 'off' }
  /** Not global: in repos, excluded in every repo that claims it, or a repo-only tag. */
  | { readonly kind: 'none'; readonly why: 'repos' | 'excluded' | 'repo-only' };

export interface CellProblem {
  readonly dest: string;
  readonly status: SkillLinkStatus;
  readonly reason: string | null;
  readonly tools: readonly string[];
}

export interface OverviewRow {
  readonly skill: string;
  readonly tags: readonly string[];
  readonly mode: SkillMode;
  readonly kind: PlacementKind;
  readonly global: GlobalCell;
  readonly globalProblems: readonly CellProblem[];
  readonly cells: ReadonlyArray<{
    readonly repo: string;
    readonly cell: RepoCell;
    readonly problems: readonly CellProblem[];
  }>;
  /** The repos that exclude it, by name: "excluded in backend-api". */
  readonly excludedIn: readonly string[];
}

export interface OverviewView {
  readonly repos: readonly RepoView[];
  readonly roots: readonly string[];
  /** Every valid tag in the library, with how many skills carry it. */
  readonly tags: ReadonlyArray<{ readonly tag: string; readonly skills: number }>;
  readonly repoOnlyTags: readonly string[];
  readonly rows: readonly OverviewRow[];
}

/** Where a skill goes, as a confirmation says it. */
export interface PlacedWhereView {
  readonly kind: PlacementKind;
  readonly global: boolean;
  readonly repos: readonly string[];
  readonly excludedIn: readonly string[];
}

export interface PlacementPlanView extends LinkPlanView {
  /** Each skill whose place changes: from where, to where (PLAN.md §3.6 Day 15's confirmation). */
  readonly moves: ReadonlyArray<{
    readonly skill: string;
    readonly from: PlacedWhereView;
    readonly to: PlacedWhereView;
  }>;
}

/** What the worker watches for each repo: its git folder, where its worktree list lives (§3.6 "Worktrees"). */
export interface WatchedRepo {
  readonly id: string;
  readonly path: string;
  readonly gitDir: string | null;
}

export type PlacementNotice =
  | { readonly type: 'repo-missing'; readonly repo: string; readonly path: string }
  | { readonly type: 'tag-gone'; readonly tag: string; readonly repos: readonly string[] };

export interface PlacementServiceDeps {
  readonly engine: InstanceEngine;
  readonly store: Store;
  readonly fs: FileSystem;
  readonly git: Pick<Git, 'codeRepo'>;
  readonly runner: ReconcileRunner;
  readonly activity: ActivityLog;
  readonly paths: PathFlavour;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  /** The link engine, which applies what placement decides. A getter: the two are made one after the other. */
  readonly links: () => LinkService;
  readonly snapshot: () => LibrarySnapshot | null;
  /** Every library folder on this device, this one's too: never taken as a code repo (§3.6 "Adding repos"). */
  readonly libraryFolders: () => readonly string[];
  /** Runs `fn` holding a device-wide lock (IMPLEMENTATION.md §2.13 rule 8). */
  readonly lock: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  readonly notify: (notice: PlacementNotice) => void;
  /** The repos changed: the worker watches their worktree lists, and tells main their folders. */
  readonly onRepos?: (repos: readonly WatchedRepo[]) => void;
}

/** A repo's checkouts and git folders, as the last check found them. */
interface Live {
  readonly path: string;
  readonly checkouts: readonly string[];
  readonly excludeFile: string | null;
  readonly gitDir: string | null;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class PlacementService implements LinkPlacement {
  readonly #deps: PlacementServiceDeps;
  readonly #live = new Map<string, Live>();
  /** Paths the guard lets placement look at: repo and worktree folders, `.git` entries, link folders. */
  readonly #exact = new Set<string>();
  /** Folders whose names may be listed: parent folders, and link folders (S11). */
  readonly #lists = new Set<string>();
  /** Exclude files: read and written (by line) under the device lock. */
  readonly #files = new Set<string>();
  /** The tags each skill carried when last seen: a skill deleted on this device keeps its place (S8). */
  readonly #tags = new Map<string, readonly string[]>();
  /** When each ticked tag was first found gone. */
  readonly #goneSince = new Map<string, number>();

  constructor(deps: PlacementServiceDeps) {
    this.#deps = deps;
    const { engine } = deps;
    // Every exclude file the registry knows stays reachable: to remove the app's lines, e.g. when the instance goes.
    for (const record of deps.store.read((tx) => tx.registry.list(EXCLUDE_ENTRY_KIND))) {
      const row = readExcludeRow(record);
      if (row) this.#files.add(row.file);
    }
    engine.handle(AddRepo, ({ path }) => this.#addRepo(path));
    engine.handle(AddRepoRoot, ({ path }) => this.#addRoot(path));
    engine.handle(ApplyPlacement, ({ edits, planHash }, context) =>
      this.#apply(edits, planHash, (event) => context.emit(event)),
    );
    engine.handle(LocateRepo, ({ repo, path }, context) => this.#locate(repo, path, (event) => context.emit(event)));
    engine.handle(DismissSuggestion, async ({ repo, tag }) => {
      this.#repo(repo);
      deps.store.write((tx) => tx.placement.dismiss({ repo, tag }));
    });
    engine.handleQuery(OverviewQuery, () => this.overview());
    engine.handleQuery(PreviewPlacement, ({ edits }) => this.preview(edits));
    engine.handleQuery(PlacementAnalysis, () => this.analysis());
  }

  /** What the guarded file system allows placement (IMPLEMENTATION.md §2.10, PLAN.md §3.7 rule 4). */
  roots(): { entries: string[]; exact: string[]; lists: string[] } {
    // The same arrays while nothing was added, each list on its own: the guard keeps a lookup per array, and a new
    // list of 27,000 entries at every file operation made a start of the `large` world take minutes (Step 17).
    return {
      entries: this.#entriesList(this.#files),
      exact: this.#exactList(this.#exact),
      lists: this.#listsList(this.#lists),
    };
  }

  readonly #entriesList = setList();
  readonly #exactList = setList();
  readonly #listsList = setList();

  // ---- LinkPlacement ---------------------------------------------------------------------------------------------

  async refresh(): Promise<void> {
    const { store, clock, logger } = this.#deps;
    await this.#discover();
    const now = clock.now();
    for (const repo of this.#state().repos) {
      if (repo.hidden) continue;
      const live = await this.#look(repo.path).catch((error: unknown) => {
        logger.warn('a code repo could not be read', { repo: repo.id, error: String(error) });
        return null;
      });
      if (live === null) {
        this.#live.delete(repo.id);
        if (repo.missingSince === null) {
          store.write((tx) => tx.placement.putRepo({ ...repo, missingSince: now }));
          this.#deps.notify({ type: 'repo-missing', repo: repo.name, path: repo.path });
        }
        continue;
      }
      this.#live.set(repo.id, live);
      if (repo.missingSince !== null) store.write((tx) => tx.placement.putRepo({ ...repo, missingSince: null }));
    }
    this.#noticeGoneTags(now);
    this.#deps.onRepos?.(
      this.#state()
        .repos.filter((repo) => !repo.hidden)
        .map((repo) => ({ id: repo.id, path: repo.path, gitDir: this.#live.get(repo.id)?.gitDir ?? null })),
    );
  }

  async place(
    skills: readonly string[],
    context: PlacementContext,
    change?: unknown,
    library?: PreviewLibrary,
  ): Promise<PlacedSkills> {
    const { paths } = this.#deps;
    const edits = (change ?? []) as readonly PlacementEdit[];
    const state = this.#stateFor(edits, library);
    const placements = this.#calculate(state, skills, library);
    const folders = this.#repoFolders(context);
    const live = await this.#liveFor(state);
    const bySkill = new Map<string, { global: boolean; repos: string[]; repoFolders: ChosenFolder[] }>();
    for (const placement of placements) {
      const repoFolders: ChosenFolder[] = [];
      for (const repo of placement.repos) {
        for (const checkout of live.get(repo)?.checkouts ?? []) {
          for (const folder of folders) {
            const path = paths.normalize(paths.join(checkout, folder));
            repoFolders.push({ path, repo, checkout });
          }
        }
      }
      bySkill.set(placement.skill, { global: placement.global, repos: [...placement.repos], repoFolders });
    }
    return { bySkill, strays: await this.#strays(skills, context, live, folders) };
  }

  previewPlaces(skills: readonly string[], change: unknown, library: PreviewLibrary): PreviewPlaces {
    const state = this.#stateFor((change ?? []) as readonly PlacementEdit[], library);
    return {
      placements: this.#calculate(state, skills, library).map((p) => ({
        skill: p.skill,
        kind: p.kind,
        global: p.global,
        repos: [...p.repos],
      })),
      tagsGone: [...this.#goneTags(state, library.snapshot)].map(([tag, repos]) => ({ tag, repos })),
    };
  }

  /** The choices with a change applied; for a preview library, after its renames moved them (S6). */
  #stateFor(edits: readonly PlacementEdit[], library: PreviewLibrary | undefined): PlacementState {
    const state = this.#state();
    return applyEdits(library ? renameSkills(state, library.renames) : state, edits);
  }

  companion(desired: readonly SkillLinkDesired[], change?: unknown): CompanionReconcile {
    const { runner, fs, paths } = this.#deps;
    const edits = (change ?? []) as readonly PlacementEdit[];
    const entriesFor = async (): Promise<ExcludeEntry[]> => {
      const live = await this.#liveFor(applyEdits(this.#state(), edits));
      const entries: ExcludeEntry[] = [];
      for (const d of desired) {
        const repo = d.repo ?? null;
        const checkout = d.checkout ?? null;
        const file = repo === null ? null : (live.get(repo)?.excludeFile ?? null);
        if (repo === null || checkout === null || file === null) continue;
        const relative = paths.relative(checkout, d.dest);
        if (relative === undefined || relative === '') continue;
        entries.push({ file, line: excludeLine(relative), repo });
      }
      return entries;
    };
    const deps = {
      fs,
      paths,
      locked: <T>(file: string, fn: () => Promise<T>) => this.#deps.lock(`exclude:${file}`, fn),
    };
    return {
      plan: async () => runner.plan(excludeReconciler(deps, 'all'), { entries: await entriesFor() }),
      apply: async (phase) => {
        const report = await runner.apply(excludeReconciler(deps, phase === 'before' ? 'before' : 'all'), {
          entries: await entriesFor(),
        });
        return report.applied;
      },
    };
  }

  attention(): AttentionItem[] {
    const state = this.#state();
    const items: AttentionItem[] = [];
    const blank = { skill: null, dest: null, folder: null, tools: [], reason: null, takenBy: null, tag: null };
    for (const repo of state.repos) {
      if (repo.hidden || repo.missingSince === null) continue;
      items.push({
        ...blank,
        id: `repo:${repo.id}`,
        kind: 'repo-missing',
        dest: repo.path,
        since: repo.missingSince,
        repoId: repo.id,
        repo: repo.name,
        repos: [],
      });
    }
    for (const [tag, repos] of this.#goneTags(state)) {
      items.push({
        ...blank,
        id: `tag:${tag}`,
        kind: 'tag-gone',
        tag,
        since: this.#goneSince.get(tag) ?? this.#deps.clock.now(),
        repoId: null,
        repo: null,
        repos: repos.map((id) => this.repoName(id) ?? id).sort(byText),
      });
    }
    return items;
  }

  async committed(checkout: string, dest: string): Promise<boolean> {
    const relative = this.#deps.paths.relative(checkout, dest);
    if (relative === undefined || relative === '') return false;
    return this.#deps.git
      .codeRepo(checkout as AbsPath)
      .isCommitted(excludeLine(relative))
      .catch(() => false);
  }

  repoName(id: string): string | null {
    return this.#state().repos.find((repo) => repo.id === id)?.name ?? null;
  }

  repoFolder(id: string): string | null {
    return this.#deps.store.read((tx) => tx.placement.repos()).find((repo) => repo.id === id)?.path ?? null;
  }

  renamed(from: string, to: string): void {
    this.#deps.store.write((tx) => tx.placement.renameSkill(from, to));
    const tags = this.#tags.get(from);
    if (tags) this.#tags.set(to, tags);
  }

  // ---- Queries ---------------------------------------------------------------------------------------------------

  /** The overview (PLAN.md §3.6 "Overview screen"): every skill × Global and each added repo. */
  overview(): OverviewView {
    const state = this.#state();
    const snapshot = this.#deps.snapshot();
    const skills = (snapshot?.skills ?? []).filter((s) => s.name === s.folder).map((s) => s.folder);
    const placements = this.#calculate(state, skills);
    const links = this.#deps.links();
    const problems = new Map<string, Array<CellProblem & { repo: string | null }>>();
    for (const item of links.attention()) {
      if (item.skill === null || item.dest === null) continue;
      const list = problems.get(item.skill) ?? [];
      list.push({
        dest: item.dest,
        status: item.kind as SkillLinkStatus,
        reason: item.reason,
        tools: item.tools,
        repo: item.repoId,
      });
      problems.set(item.skill, list);
    }
    const repos = state.repos.filter((repo) => !repo.hidden);
    const name = (id: string) => repos.find((repo) => repo.id === id)?.name ?? id;
    return {
      repos: repos.map((repo) => this.#repoView(repo, state)),
      roots: this.#deps.store.read((tx) => tx.placement.roots()),
      tags: (snapshot?.tags ?? []).map((t) => ({ tag: t.tag, skills: t.skills.length })),
      repoOnlyTags: [...(snapshot?.config.value.repoOnlyTags ?? [])],
      rows: placements.map((p) => {
        const mine = problems.get(p.skill) ?? [];
        const strip = ({ repo: _repo, ...problem }: CellProblem & { repo: string | null }) => problem;
        return {
          skill: p.skill,
          tags: [...(this.#tags.get(p.skill) ?? [])],
          mode: p.mode,
          kind: p.kind,
          global: globalCell(p),
          globalProblems: mine.filter((m) => m.repo === null).map(strip),
          cells: repos.map((repo) => ({
            repo: repo.id,
            cell: repoCell(p, repo.id),
            problems: mine.filter((m) => m.repo === repo.id).map(strip),
          })),
          excludedIn: p.claims.filter((c) => c.excluded).map((c) => name(c.repo)),
        };
      }),
    };
  }

  /** The confirmation of a placement change: its plan, and where each skill moves (IMPLEMENTATION.md §2.5). */
  async preview(edits: readonly PlacementEdit[]): Promise<PlacementPlanView> {
    this.#checkEdits(edits);
    const { view } = await this.#deps.links().previewChange(edits);
    const before = this.#state();
    const after = applyEdits(before, edits);
    const skills = (this.#deps.snapshot()?.skills ?? []).filter((s) => s.name === s.folder).map((s) => s.folder);
    const was = new Map(this.#calculate(before, skills).map((p) => [p.skill, p]));
    const name = (id: string) => [...before.repos, ...after.repos].find((repo) => repo.id === id)?.name ?? id;
    const where = (p: SkillPlacement): PlacedWhereView => ({
      kind: p.kind,
      global: p.global,
      repos: p.repos.map(name).sort(byText),
      excludedIn: p.claims
        .filter((c) => c.excluded)
        .map((c) => name(c.repo))
        .sort(byText),
    });
    const moves: Array<{ skill: string; from: PlacedWhereView; to: PlacedWhereView }> = [];
    for (const p of this.#calculate(after, skills)) {
      const old = was.get(p.skill);
      if (!old) continue;
      const from = where(old);
      const to = where(p);
      if (from.global !== to.global || from.repos.join('\u0000') !== to.repos.join('\u0000')) {
        moves.push({ skill: p.skill, from, to });
      }
    }
    return { ...view, moves };
  }

  /** The placement analysis for nested repos (A6.12); the Doctor shows it from Step 7. */
  analysis(): NestedRepoWarning[] {
    const state = this.#state();
    const repos = state.repos.filter((repo) => !repo.hidden);
    const links = this.#deps.links();
    const tools = links.toolsSnapshot();
    return nestedRepoWarnings(nestedRepos(repos, this.#deps.paths), tools.tools, tools.enabled);
  }

  // ---- Commands --------------------------------------------------------------------------------------------------

  /**
   * The pull preview's answers (PLAN.md §3.6 Day 8 [Change], Day 12 [Use another tag]): written together with the pull,
   * whose plan hash already covered them. Run it inside the pull's command, after the merge.
   */
  persist(change: unknown): void {
    const edits = (change ?? []) as readonly PlacementEdit[];
    if (edits.length === 0) return;
    this.#checkEdits(edits);
    this.#deps.store.write((tx) => {
      const entries = activityOf(edits, tx.placement.repos());
      persistEdits(tx, edits);
      this.#deps.activity.appendIn(tx, entries);
    });
  }

  /** Throws for edits that name an unknown repo or a tag rule that can't change; before a preview shows them. */
  checkEdits(change: unknown): void {
    this.#checkEdits((change ?? []) as readonly PlacementEdit[]);
  }

  async #apply(
    edits: readonly PlacementEdit[],
    planHash: string,
    emit: (event: DomainEvent) => void,
  ): Promise<LinkCheckReport> {
    this.#checkEdits(edits);
    return this.#deps.links().applyChange(
      edits,
      planHash,
      () =>
        this.#deps.store.write((tx) => {
          // Named before the edits are written: a parent folder's repos are gone after.
          const entries = activityOf(edits, tx.placement.repos());
          persistEdits(tx, edits);
          this.#deps.activity.appendIn(tx, entries);
        }),
      emit,
    );
  }

  async #addRepo(path: string): Promise<RepoView> {
    const folder = this.#folder(path);
    if (!(await this.#isRepo(folder))) throw new AppError('placement.notARepo', { path: folder });
    const existing = this.#state().repos.find((repo) => this.#deps.paths.same(repo.path, folder));
    if (existing && !existing.hidden) throw new AppError('placement.alreadyAdded', { path: folder });
    const id = await this.#putRepo(folder);
    await this.refresh();
    this.#check();
    return this.#repoView(this.#repo(id), this.#state());
  }

  /**
   * Recovering connections (PLAN.md §3.5): a repo folder the user adds again, as [Add repo] adds it, without a check
   * of its own. Returns the repo's id and its checkouts, or null when the folder isn't a repo.
   */
  async recoverRepo(path: string): Promise<{ id: string; checkouts: readonly string[] } | null> {
    const folder = this.#folder(path);
    if (!(await this.#isRepo(folder))) return null;
    const existing = this.#state().repos.find((repo) => this.#deps.paths.same(repo.path, folder) && !repo.hidden);
    const id = existing?.id ?? (await this.#putRepo(folder));
    await this.refresh();
    return { id, checkouts: this.#live.get(id)?.checkouts ?? [folder] };
  }

  /**
   * Recovering connections: each skill found linked in a repo is placed there again, as an individual addition, so it
   * isn't also linked globally (PLAN.md §3.5). The exclude lines of those links are the app's again: they go with the
   * links.
   */
  async recoverPlacement(found: ReadonlyArray<{ repo: string; skill: string; dest: string; checkout: string }>) {
    const { store, clock, paths, fs } = this.#deps;
    const edits: PlacementEdit[] = [];
    const seen = new Set<string>();
    for (const link of found) {
      const key = `${link.repo}\u0000${link.skill}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edits.push({ op: 'add', repo: link.repo, skill: link.skill, on: true });
    }
    const rows: Array<{ key: string; row: ExcludeEntryRow }> = [];
    for (const link of found) {
      const file = this.#live.get(link.repo)?.excludeFile ?? null;
      const relative = paths.relative(link.checkout, link.dest);
      if (file === null || relative === undefined || relative === '') continue;
      const line = excludeLine(relative);
      const text = (await fs.lstat(file as AbsPath))?.kind === 'file' ? await fs.readText(file as AbsPath) : '';
      if (!hasLine(text, line)) continue;
      rows.push({
        key: excludeKey(file, line),
        row: { file, line, repo: link.repo, preexisting: false, createdAt: clock.now() },
      });
    }
    store.write((tx) => {
      persistEdits(tx, edits);
      for (const { key, row } of rows) tx.registry.put(EXCLUDE_ENTRY_KIND, key, row, clock.now());
    });
  }

  /** Records a repo folder, or brings a removed one back under its id, as it is now. Returns its id. */
  async #putRepo(folder: string): Promise<string> {
    const { paths, store, clock } = this.#deps;
    const existing = this.#state().repos.find((repo) => paths.same(repo.path, folder));
    const remote = await this.#remote(folder);
    // A removed repo comes back by hand, under its id, as it is now.
    const repo: RepoRecord = existing
      ? {
          ...existing,
          remote,
          name: repoName(remote, folder, paths),
          root: null,
          addedAt: clock.now(),
          missingSince: null,
          hidden: false,
        }
      : {
          id: `repo_${randomToken(this.#deps.random)}`,
          path: folder,
          remote,
          name: repoName(remote, folder, paths),
          root: null,
          addedAt: clock.now(),
          missingSince: null,
          hidden: false,
        };
    store.write((tx) => {
      tx.placement.putRepo(RepoRecordSchema.parse(repo));
      this.#deps.activity.appendIn(tx, [
        { kind: 'repo-added', path: null, details: { repo: repo.name, path: folder } },
      ]);
    });
    return repo.id;
  }

  async #addRoot(path: string): Promise<RepoView[]> {
    const folder = this.#folder(path);
    const entry = await this.#deps.fs.lstat(folder as AbsPath);
    if (entry?.kind !== 'dir') throw new AppError('placement.notAFolder', { path: folder });
    const before = new Set(this.#state().repos.map((repo) => repo.id));
    this.#deps.store.write((tx) => tx.placement.putRoot(folder));
    await this.refresh();
    this.#check();
    const state = this.#state();
    return state.repos
      .filter((repo) => !before.has(repo.id) && !repo.hidden)
      .map((repo) => this.#repoView(repo, state));
  }

  async #locate(id: string, path: string, emit: (event: DomainEvent) => void): Promise<LinkCheckReport> {
    const repo = this.#repo(id);
    const folder = this.#folder(path);
    if (!(await this.#isRepo(folder))) throw new AppError('placement.notARepo', { path: folder });
    // S10 [Locate]: the folder must hold the same repo: its remote decides.
    const remote = await this.#remote(folder);
    if (!sameRemote(repo.remote, remote)) {
      throw new AppError('placement.remoteMismatch', { expected: remoteSlug(repo.remote) ?? repo.remote ?? '' });
    }
    const edits: PlacementEdit[] = [{ op: 'locate', repo: id, path: folder }];
    const { hash } = await this.#deps.links().previewChange(edits);
    const report = await this.#apply(edits, hash, emit);
    await this.refresh();
    return report;
  }

  // ---- Inside ----------------------------------------------------------------------------------------------------

  #check(): void {
    this.#deps.engine.execute(CheckLinks, {}).catch(() => undefined);
  }

  #state(): PlacementState & { readonly roots: readonly string[] } {
    return this.#deps.store.read((tx) => ({
      repos: tx.placement.repos(),
      roots: tx.placement.roots(),
      rules: tx.placement.tagRules(),
      added: tx.placement.added(),
      excluded: tx.placement.excluded(),
      modes: tx.placement.modes(),
    }));
  }

  #repo(id: string): RepoRecord {
    const repo = this.#state().repos.find((r) => r.id === id && !r.hidden);
    if (!repo) throw new AppError('placement.repoNotFound', { repo: id });
    return repo;
  }

  #folder(path: string): string {
    const { paths } = this.#deps;
    if (!paths.isAbsolute(path.trim())) throw new AppError('placement.notAFolder', { path });
    const folder = paths.normalize(path.trim());
    // A library folder, of any instance, is never a code repo (§3.6 "Adding repos", A6.13).
    if (this.#isLibrary(folder)) throw new AppError('placement.libraryFolder', { path: folder });
    this.#exact.add(folder);
    this.#exact.add(paths.join(folder, '.git'));
    return folder;
  }

  #isLibrary(folder: string): boolean {
    const { paths } = this.#deps;
    return this.#deps.libraryFolders().some((library) => paths.isInside(library, folder));
  }

  async #isRepo(folder: string): Promise<boolean> {
    const { fs, paths } = this.#deps;
    this.#exact.add(folder);
    this.#exact.add(paths.join(folder, '.git'));
    if ((await fs.lstat(folder as AbsPath))?.kind !== 'dir') return false;
    const git = await fs.lstat(paths.join(folder, '.git') as AbsPath);
    return git?.kind === 'dir' || git?.kind === 'file';
  }

  async #remote(folder: string): Promise<string | null> {
    return this.#deps.git
      .codeRepo(folder as AbsPath)
      .remoteUrl()
      .catch(() => null);
  }

  /** Parent folders, one level down: new git repos become repos; library folders never do (§3.6 "Adding repos"). */
  async #discover(): Promise<void> {
    const { fs, paths, store, clock } = this.#deps;
    const state = this.#state();
    for (const root of state.roots) {
      this.#lists.add(root);
      this.#exact.add(root);
      if ((await fs.lstat(root as AbsPath))?.kind !== 'dir') continue;
      for (const name of await fs.list(root as AbsPath)) {
        const folder = paths.join(root, name);
        if (state.repos.some((repo) => paths.same(repo.path, folder))) continue;
        if (this.#isLibrary(folder) || !(await this.#isRepo(folder))) continue;
        const remote = await this.#remote(folder);
        const repo: RepoRecord = {
          id: `repo_${randomToken(this.#deps.random)}`,
          path: folder,
          remote,
          name: repoName(remote, folder, paths),
          root,
          addedAt: clock.now(),
          missingSince: null,
          hidden: false,
        };
        store.write((tx) => {
          tx.placement.putRepo(repo);
          this.#deps.activity.appendIn(tx, [
            { kind: 'repo-added', path: null, details: { repo: repo.name, path: folder, root } },
          ]);
        });
      }
    }
  }

  /** A repo's checkouts and git folders, or null when its folder is gone (S10). */
  async #look(path: string): Promise<Live | null> {
    const { fs, paths, git } = this.#deps;
    if (!(await this.#isRepo(path))) return null;
    const code = git.codeRepo(path as AbsPath);
    const worktrees = await code.worktrees();
    const checkouts: string[] = [];
    for (const worktree of worktrees) {
      const at = paths.normalize(worktree.path);
      this.#exact.add(at);
      // A worktree git still lists but whose folder is gone has no links to keep (§3.6 "Worktrees").
      if ((await fs.lstat(at as AbsPath))?.kind === 'dir') checkouts.push(at);
    }
    if (!checkouts.some((c) => paths.same(c, path))) checkouts.unshift(path);
    const excludeFile = paths.normalize(await code.excludePath());
    this.#files.add(excludeFile);
    this.#exact.add(paths.dirname(excludeFile));
    const gitDir = paths.dirname(paths.dirname(excludeFile));
    return { path, checkouts, excludeFile, gitDir };
  }

  /** Each repo's checkouts for a state: a located repo is looked at in its new folder. */
  async #liveFor(state: PlacementState): Promise<Map<string, Live>> {
    const { paths } = this.#deps;
    const out = new Map<string, Live>();
    for (const repo of state.repos) {
      if (repo.hidden) continue;
      const known = this.#live.get(repo.id);
      if (known && paths.same(known.path, repo.path)) out.set(repo.id, known);
      else if (repo.missingSince === null || !known) {
        const live = await this.#look(repo.path).catch(() => null);
        if (live) out.set(repo.id, live);
      }
    }
    return out;
  }

  /** The link folders inside a checkout, relative to it (§3.4 "Repo placement uses the same logic"). */
  #repoFolders(context: PlacementContext): string[] {
    return chooseRepoLinkFolders(context.tools as ResolvedTool[], context.enabled, this.#deps.paths).folders.map(
      (folder) => folder.path,
    );
  }

  /** Links to company skills in the link folders that the app didn't make (S11): names only, then each entry. */
  async #strays(
    skills: readonly string[],
    context: PlacementContext,
    live: ReadonlyMap<string, Live>,
    folders: readonly string[],
  ): Promise<StrayLink[]> {
    const { fs, paths } = this.#deps;
    const names = new Set(skills);
    const places: Array<{ folder: string; repo: string | null; checkout: string | null }> = [
      ...context.globalFolders.map((folder) => ({ folder, repo: null, checkout: null })),
    ];
    for (const [repo, info] of live) {
      for (const checkout of info.checkouts) {
        for (const folder of folders) places.push({ folder: paths.join(checkout, folder), repo, checkout });
      }
    }
    // Every place is allowed before the first is read: one change of the guard's roots, not one per place.
    for (const place of places) {
      this.#lists.add(place.folder);
      this.#exact.add(place.folder);
      this.#exact.add(paths.dirname(place.folder));
    }
    const strays: StrayLink[] = [];
    for (const place of places) {
      if ((await fs.lstat(place.folder as AbsPath))?.kind !== 'dir') continue;
      // Only names of this library's skills are kept; every other name is dropped at once (PLAN.md §3.7 rule 3).
      for (const name of await fs.list(place.folder as AbsPath)) {
        if (!names.has(name)) continue;
        strays.push({ dest: paths.join(place.folder, name), skill: name, ...place });
      }
    }
    return strays;
  }

  #calculate(state: PlacementState, skills: readonly string[], library?: PreviewLibrary): SkillPlacement[] {
    // A preview library's tags count for it alone: the tags remembered for deleted skills stay this library's.
    const snapshot = library?.snapshot ?? this.#deps.snapshot();
    const tags = library ? new Map(this.#tags) : this.#tags;
    for (const rename of library?.renames ?? []) {
      const old = tags.get(rename.from);
      if (old) tags.set(rename.to, old);
    }
    for (const skill of snapshot?.skills ?? []) tags.set(skill.folder, skill.tags);
    return calculatePlacement({
      skills: skills.map((folder) => ({ folder, tags: tags.get(folder) ?? [] })),
      repos: state.repos.filter((repo) => !repo.hidden).map((repo) => repo.id),
      rules: state.rules,
      added: state.added,
      excluded: state.excluded,
      modes: state.modes,
      repoOnlyTags: snapshot?.config.value.repoOnlyTags ?? [],
    });
  }

  /** Ticked tags no skill carries (§3.6 Day 12): tag → the repos whose rule uses it. */
  #goneTags(state: PlacementState, of?: LibrarySnapshot): Map<string, string[]> {
    const snapshot = of ?? this.#deps.snapshot();
    const out = new Map<string, string[]>();
    if (!snapshot || snapshot.compatibility !== 'ok') return out;
    const tags = new Set(snapshot.tags.map((t) => t.tag));
    const repos = new Set(state.repos.filter((repo) => !repo.hidden).map((repo) => repo.id));
    for (const rule of state.rules) {
      if (tags.has(rule.tag) || !repos.has(rule.repo)) continue;
      out.set(rule.tag, [...(out.get(rule.tag) ?? []), rule.repo]);
    }
    return out;
  }

  #noticeGoneTags(now: number): void {
    const gone = this.#goneTags(this.#state());
    for (const tag of [...this.#goneSince.keys()]) if (!gone.has(tag)) this.#goneSince.delete(tag);
    for (const [tag, repos] of gone) {
      if (this.#goneSince.has(tag)) continue;
      this.#goneSince.set(tag, now);
      this.#deps.notify({ type: 'tag-gone', tag, repos: repos.map((id) => this.repoName(id) ?? id).sort(byText) });
    }
  }

  #repoView(repo: RepoRecord, state: PlacementState): RepoView {
    const snapshot = this.#deps.snapshot();
    const tags = new Set((snapshot?.tags ?? []).map((t) => t.tag));
    const rules = state.rules
      .filter((r) => r.repo === repo.id)
      .map((r) => r.tag)
      .sort(byText);
    const dismissed = this.#deps.store
      .read((tx) => tx.placement.dismissed())
      .filter((d) => d.repo === repo.id)
      .map((d) => d.tag);
    const live = this.#live.get(repo.id);
    const { paths } = this.#deps;
    return {
      id: repo.id,
      name: repo.name,
      path: repo.path,
      remote: remoteSlug(repo.remote) ?? repo.remote,
      root: repo.root,
      missingSince: repo.missingSince,
      worktrees: (live?.checkouts ?? []).filter((c) => !paths.same(c, repo.path)),
      rules,
      gone: snapshot ? rules.filter((tag) => !tags.has(tag)) : [],
      suggestions: suggestedTags(snapshot?.config.value.suggest, repo.remote).filter(
        (tag) => !rules.includes(tag) && !dismissed.includes(tag) && tags.has(tag),
      ),
    };
  }

  #checkEdits(edits: readonly PlacementEdit[]): void {
    const state = this.#state();
    const known = new Set(state.repos.filter((repo) => !repo.hidden).map((repo) => repo.id));
    for (const edit of edits) {
      if ('repo' in edit && !known.has(edit.repo)) throw new AppError('placement.repoNotFound', { repo: edit.repo });
      if (edit.op === 'remove-root') {
        // The parent folder must still be added, and only a repo found in it can be kept.
        if (!state.roots.includes(edit.root)) throw new AppError('placement.rootNotFound', { path: edit.root });
        for (const id of edit.keep) {
          if (!state.repos.some((r) => r.id === id && !r.hidden && r.root === edit.root)) {
            throw new AppError('placement.repoNotFound', { repo: id });
          }
        }
      }
      // A skill set to Everywhere can't be excluded from one repo: a global link is visible in every repo (§3.6).
      if (edit.op === 'exclude' && edit.on && state.modes.some((m) => m.skill === edit.skill && m.mode === 'global')) {
        const later = edits.some((e) => e.op === 'mode' && e.skill === edit.skill && e.mode !== 'global');
        if (!later) throw new AppError('placement.everywhere', { skill: edit.skill });
      }
    }
  }
}

function globalCell(p: SkillPlacement): GlobalCell {
  switch (p.kind) {
    case 'global':
      return { kind: 'placed' };
    case 'everywhere':
      return { kind: 'by-choice' };
    case 'off':
      return { kind: 'off' };
    case 'repos':
      return { kind: 'none', why: 'repos' };
    case 'excluded':
      return { kind: 'none', why: 'excluded' };
    case 'repo-only':
      return { kind: 'none', why: 'repo-only' };
  }
}

/** Two remotes name the same repo: by their normalized form when git URLs, else as written. */
export function sameRemote(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const pa = parseGitUrl(a);
  const pb = parseGitUrl(b);
  if (pa.ok && pb.ok) return pa.value.key === pb.value.key;
  return a.trim() === b.trim();
}

/** The same edits as `applyEdits`, written to instance.db. */
export function persistEdits(tx: WriteTx, edits: readonly PlacementEdit[]): void {
  const p = tx.placement;
  for (const edit of edits) {
    switch (edit.op) {
      case 'rule':
        p.setTagRule({ repo: edit.repo, tag: edit.tag }, edit.on);
        break;
      case 'add':
        p.setAdded({ repo: edit.repo, skill: edit.skill }, edit.on);
        if (edit.on) p.setExcluded({ repo: edit.repo, skill: edit.skill }, false);
        break;
      case 'exclude':
        p.setExcluded({ repo: edit.repo, skill: edit.skill }, edit.on);
        if (edit.on) p.setAdded({ repo: edit.repo, skill: edit.skill }, false);
        break;
      case 'mode':
        p.setMode(edit.skill, edit.mode);
        break;
      case 'reset':
        for (const { skill, mode } of p.modes()) if (mode === 'global') p.setMode(skill, 'default');
        if (edit.dropChoices) {
          for (const entry of p.added()) p.setAdded(entry, false);
          for (const entry of p.excluded()) p.setExcluded(entry, false);
        }
        break;
      case 'retag':
        p.setTagRule({ repo: edit.repo, tag: edit.from }, false);
        p.setTagRule({ repo: edit.repo, tag: edit.to }, true);
        break;
      case 'remove-repo': {
        const repo = p.repos().find((r) => r.id === edit.repo);
        p.deleteRepo(edit.repo);
        // A removed repo stays hidden, so a look in a parent folder never adds it again, also one the user added by
        // hand; adding it by hand brings it back (PLAN.md §3.6 "Adding repos").
        if (repo) p.putRepo({ ...repo, hidden: true, missingSince: null });
        break;
      }
      case 'remove-root':
        p.deleteRoot(edit.root);
        for (const repo of p.repos()) {
          if (repo.root !== edit.root) continue;
          // A kept repo stays as if the user had added it; the others go with their choices, the hidden ones too.
          if (edit.keep.includes(repo.id)) p.putRepo({ ...repo, root: null });
          else p.deleteRepo(repo.id);
        }
        break;
      case 'locate': {
        const repo = p.repos().find((r) => r.id === edit.repo);
        if (repo) p.putRepo({ ...repo, path: edit.path, missingSince: null });
        break;
      }
    }
  }
}

interface PlacementActivity {
  readonly kind: 'placement-changed' | 'tag-rule-changed' | 'repo-removed';
  readonly path: string | null;
  readonly details: Record<string, string | boolean>;
}

/**
 * One activity entry per edit (PLAN.md §3.13 "placement-changed", "tag-rule-changed", "repo-removed"), and one per
 * repo that goes with a parent folder, as one came per repo found in it.
 */
function activityOf(edits: readonly PlacementEdit[], repos: readonly RepoRecord[]): PlacementActivity[] {
  const name = (id: string) => repos.find((repo) => repo.id === id)?.name ?? id;
  return edits.flatMap((edit): PlacementActivity | PlacementActivity[] => {
    switch (edit.op) {
      case 'remove-root':
        return repos
          .filter((repo) => repo.root === edit.root && !repo.hidden && !edit.keep.includes(repo.id))
          .map((repo) => repo.name)
          .sort(byText)
          .map((repo) => ({ kind: 'repo-removed', path: null, details: { repo, root: edit.root } }));
      case 'rule':
        return { kind: 'tag-rule-changed', path: null, details: { repo: name(edit.repo), tag: edit.tag, on: edit.on } };
      case 'retag':
        return {
          kind: 'tag-rule-changed',
          path: null,
          details: { repo: name(edit.repo), tag: edit.to, from: edit.from, on: true },
        };
      case 'remove-repo':
        return { kind: 'repo-removed', path: null, details: { repo: name(edit.repo) } };
      case 'locate':
        return {
          kind: 'placement-changed',
          path: null,
          details: { op: 'locate', repo: name(edit.repo), path: edit.path },
        };
      case 'reset':
        return { kind: 'placement-changed', path: null, details: { op: 'reset', dropChoices: edit.dropChoices } };
      case 'mode':
        return {
          kind: 'placement-changed',
          path: `skills/${edit.skill}`,
          details: { op: 'mode', skill: edit.skill, mode: edit.mode },
        };
      case 'add':
      case 'exclude':
        return {
          kind: 'placement-changed',
          path: `skills/${edit.skill}`,
          details: { op: edit.op, skill: edit.skill, repo: name(edit.repo), on: edit.on },
        };
    }
  });
}
