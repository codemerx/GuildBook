// The git screens (IMPLEMENTATION.md Step 11, PLAN.md §3.10): the library as a git working copy with a git GUI's
// buttons. Fetch is automatic and read-only: every 3 minutes, at start, on focus and when the network comes back (the
// timer can be switched off for SSH keys that ask for a touch); everything else the user starts. The commands run in
// the instance's queue, so a pull, a watcher event and a relocation never race (§2.4).
import type { GitIdentityValue } from '@app/schemas';
import { defineCommand, defineQuery, Scheduler } from '../../engine/index.ts';
import type { Timer } from '../../ports/clock.ts';
import type { ConflictTake, GitIdentity, RepoState, Stash } from '../../ports/git.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import type { BaselineDiff } from './applied-state.ts';
import {
  type BranchesView,
  BranchFlow,
  type CommitView,
  type HistoryEntry,
  type MergeResult,
  type RevertResult,
  type StashResult,
  type SwitchResult,
} from './branches.ts';
import {
  type ChangeDiff,
  type ChangesView,
  type CommitChecks,
  type CommitConfirmations,
  CommitFlow,
  type CommitResult,
  type PushResult,
} from './commits.ts';
import {
  type ConflictFile,
  type ConflictsView,
  type ContinueResult,
  type IncomingPreview,
  PullFlow,
  type PullResult,
} from './incoming.ts';
import { identityOf, setIdentity, type SyncDeps, type SyncPrefixHooks, type SyncReviewHooks } from './sync-context.ts';

type NoInput = Record<string, never>;

/** The fetch every 3 minutes (PLAN.md §3.10 "Fetch"). */
export const FETCH_INTERVAL_MS = 3 * 60 * 1000;
/** Incoming changes are announced at most once an hour per instance (PLAN.md §3.19 "Notifications"). */
export const INCOMING_NOTICE_MS = 60 * 60 * 1000;

export interface SyncStatus {
  readonly branch: string | null;
  readonly head: string | null;
  readonly upstream: string | null;
  /** Commits on the server not here yet (↓) and commits here not on the server yet (↑). */
  readonly incoming: number;
  readonly toPush: number;
  /** Files with uncommitted changes ("Modified on this device"). */
  readonly changes: number;
  readonly operation: RepoState['operation'];
  /** Conflicted files and their skills: the banner (PLAN.md §3.10 step 3). */
  readonly conflicts: ReadonlyArray<{ readonly path: string; readonly skill: string | null }>;
  readonly stashes: number;
  readonly offline: boolean;
  readonly fetching: boolean;
  readonly lastFetchAt: number | null;
  /** Why the last fetch failed, when it wasn't the network. */
  readonly fetchError: {
    readonly code: string;
    readonly params: Readonly<Record<string, string | number | boolean | null>>;
  } | null;
  /** The fetched library.yaml: anything but `ok` disables Pull and Push until the app is updated (PLAN.md §3.2). */
  readonly compatibility: 'ok' | 'formatTooNew' | 'appTooOld';
  readonly identity: GitIdentity | null;
  readonly fetchTimer: boolean;
  readonly pullMode: 'merge' | 'rebase';
  /** The library has a remote to fetch from (a test library may not). */
  readonly remote: boolean;
}

export const SyncStatusQuery = defineQuery<NoInput, SyncStatus>('SyncStatus');
export const ChangesQuery = defineQuery<NoInput, ChangesView>('Changes');
export const ChangeDiffQuery = defineQuery<{ path: string }, ChangeDiff>('ChangeDiff');
export const CommitChecksQuery = defineQuery<{ paths: readonly string[] }, CommitChecks>('CommitChecks');
export const IncomingQuery = defineQuery<
  { edits: readonly unknown[]; localPrefix?: string | null | undefined },
  IncomingPreview
>('Incoming');
export const ConflictsQuery = defineQuery<NoInput, ConflictsView>('Conflicts');
export const ConflictFileQuery = defineQuery<{ path: string }, ConflictFile>('ConflictFile');
export const BranchesQuery = defineQuery<NoInput, BranchesView>('Branches');
export const StashesQuery = defineQuery<NoInput, Stash[]>('Stashes');
export const GitHistoryQuery = defineQuery<{ skill: string | null; skip: number; max: number }, HistoryEntry[]>(
  'GitHistory',
);
export const CommitQuery = defineQuery<{ id: string }, CommitView>('Commit');
export const CommitDiffQuery = defineQuery<
  { id: string; path: string },
  { path: string; before: string | null; after: string | null; binary: boolean }
>('CommitDiff');

/** Background: a user command cancels it, and a request joins one that waits (§2.4). */
export const FetchLibrary = defineCommand<NoInput, void>('FetchLibrary', { background: true });
export const CommitChanges = defineCommand<
  { paths: readonly string[]; message: string; confirm: CommitConfirmations; push: boolean },
  CommitResult
>('CommitChanges');
export const DiscardChanges = defineCommand<{ paths: readonly string[] }, void>('DiscardChanges');
export const UndoLastCommit = defineCommand<NoInput, void>('UndoLastCommit');
export const PullLibrary = defineCommand<
  { planHash: string; edits: readonly unknown[]; stash: boolean; localPrefix?: string | null | undefined },
  PullResult
>('PullLibrary');
export const PushLibrary = defineCommand<{ confirmSecrets: boolean }, PushResult>('PushLibrary');
export const TakeConflict = defineCommand<{ path: string; take: ConflictTake }, void>('TakeConflict');
export const MarkResolved = defineCommand<{ paths: readonly string[] }, void>('MarkResolved');
export const ContinueOperation = defineCommand<NoInput, ContinueResult>('ContinueOperation');
export const AbortOperation = defineCommand<NoInput, void>('AbortOperation');
export const CreateBranch = defineCommand<{ name: string; switchTo: boolean }, SwitchResult>('CreateBranch');
export const SwitchBranch = defineCommand<{ name: string; stash: boolean }, SwitchResult>('SwitchBranch');
/** `remote`: the branch on the server, e.g. the company's new changes into a change request's branch (ADR 0032). */
export const MergeBranch = defineCommand<{ name: string; remote?: boolean }, MergeResult>('MergeBranch');
export const DeleteBranch = defineCommand<{ name: string; force: boolean }, void>('DeleteBranch');
export const StashChanges = defineCommand<{ message: string }, void>('StashChanges');
export const ApplyStash = defineCommand<{ index: number; drop: boolean }, StashResult>('ApplyStash');
export const DropStash = defineCommand<{ index: number }, void>('DropStash');
export const RevertCommit = defineCommand<{ id: string }, RevertResult>('RevertCommit');
export const SetCommitIdentity = defineCommand<GitIdentityValue, void>('SetCommitIdentity');
export const SetSyncSettings = defineCommand<{ fetchTimer?: boolean; pullMode?: 'merge' | 'rebase' }, void>(
  'SetSyncSettings',
);

/** Failures that say "no network": the offline state (PLAN.md §3.19 "Offline"). */
const OFFLINE = new Set(['git.offline', 'git.certificate']);

/**
 * How long the network must stay back before the fetch runs (Step 17, A17.3): a network that comes and goes (a train,
 * a weak Wi-Fi) gets one fetch once it holds, not one for each time it came back.
 */
export const NETWORK_SETTLE_MS = 2000;

export class SyncService {
  readonly commits: CommitFlow;
  readonly pulls: PullFlow;
  readonly branches: BranchFlow;
  readonly #deps: SyncDeps;
  readonly #scheduler: Scheduler;
  #offline = false;
  #networkBack: Timer | null = null;
  #fetching = false;
  #lastFetchAt: number | null = null;
  #fetchError: SyncStatus['fetchError'] = null;
  #lastNotice: { at: number; target: string } | null = null;
  /** HEADs the app itself made (commits, pulls, merges, switches): moving to one isn't "another git tool". */
  readonly #own = new Set<string>();
  #running = 0;

  constructor(deps: SyncDeps) {
    this.#deps = deps;
    const changed = () => void this.#changed();
    this.commits = new CommitFlow(deps, changed);
    this.pulls = new PullFlow(deps, changed);
    this.branches = new BranchFlow(deps, this.pulls, changed);
    this.#scheduler = new Scheduler(deps.clock);
    const { engine } = deps;
    engine.handleQuery(SyncStatusQuery, () => this.status());
    engine.handleQuery(ChangesQuery, () => this.commits.changes());
    engine.handleQuery(ChangeDiffQuery, ({ path }) => this.commits.diff(path));
    engine.handleQuery(CommitChecksQuery, ({ paths }) => this.commits.check(paths));
    engine.handleQuery(IncomingQuery, ({ edits, localPrefix }) => this.pulls.preview(edits, localPrefix ?? null));
    engine.handleQuery(ConflictsQuery, () => this.pulls.conflicts());
    engine.handleQuery(ConflictFileQuery, ({ path }) => this.pulls.file(path));
    engine.handleQuery(BranchesQuery, () => this.branches.branches());
    engine.handleQuery(StashesQuery, () => this.branches.stashes());
    engine.handleQuery(GitHistoryQuery, (input) => this.branches.history(input));
    engine.handleQuery(CommitQuery, ({ id }) => this.branches.commit(id));
    engine.handleQuery(CommitDiffQuery, ({ id, path }) => this.branches.commitDiff(id, path));

    engine.handle(FetchLibrary, (_input, context) => this.#fetch(context.signal));
    engine.handle(CommitChanges, (input, context) =>
      this.#own_(() => this.commits.commit(input, (event) => context.emit(event))),
    );
    engine.handle(DiscardChanges, ({ paths }, context) => this.commits.discard(paths, (event) => context.emit(event)));
    engine.handle(UndoLastCommit, (_input, context) => this.#own_(() => this.commits.undo((e) => context.emit(e))));
    engine.handle(PullLibrary, (input, context) =>
      this.#own_(() => this.#online(() => this.pulls.pull(input, (event) => context.emit(event)))),
    );
    engine.handle(PushLibrary, (input, context) =>
      this.#online(() => this.commits.push(input, (event) => context.emit(event))),
    );
    engine.handle(TakeConflict, ({ path, take }) => this.pulls.take(path, take));
    engine.handle(MarkResolved, ({ paths }) => this.pulls.markResolved(paths));
    engine.handle(ContinueOperation, (_input, context) =>
      this.#own_(() => this.pulls.continue((e) => context.emit(e))),
    );
    engine.handle(AbortOperation, (_input, context) => this.#own_(() => this.pulls.abort((e) => context.emit(e))));
    engine.handle(CreateBranch, ({ name, switchTo }, context) =>
      this.#own_(() => this.branches.create(name, switchTo, (e) => context.emit(e))),
    );
    engine.handle(SwitchBranch, ({ name, stash }, context) =>
      this.#own_(() => this.branches.switchTo(name, stash, (e) => context.emit(e))),
    );
    engine.handle(MergeBranch, ({ name, remote }, context) =>
      this.#own_(() => this.branches.merge(name, (e) => context.emit(e), remote ?? false)),
    );
    engine.handle(DeleteBranch, ({ name, force }) => this.branches.remove(name, force));
    engine.handle(StashChanges, ({ message }, context) => this.branches.stash(message, (e) => context.emit(e)));
    engine.handle(ApplyStash, ({ index, drop }, context) => this.branches.apply(index, drop, (e) => context.emit(e)));
    engine.handle(DropStash, ({ index }) => this.branches.drop(index));
    engine.handle(RevertCommit, ({ id }, context) =>
      this.#own_(() => this.branches.revert(id, (e) => context.emit(e))),
    );
    engine.handle(SetCommitIdentity, async (identity) => {
      if (identity.name.trim() === '' || !/^[^@\s]+@[^@\s]+$/.test(identity.email.trim())) {
        throw new AppError('sync.identityNeeded');
      }
      setIdentity(deps.store, { name: identity.name.trim(), email: identity.email.trim() });
      await this.#changed();
    });
    engine.handle(SetSyncSettings, async (input) => {
      deps.store.write((tx) => tx.settings.set({ ...tx.settings.get(), ...input }));
      this.#timer();
      await this.#changed();
    });
  }

  /**
   * Runs a command that may move HEAD, and remembers where HEAD went: the app's own change, not another tool's. While
   * it runs, the link check it starts sees HEAD move too: that's the app's own as well (commands run one at a time).
   */
  async #own_<T>(fn: () => Promise<T>): Promise<T> {
    this.#running += 1;
    try {
      return await fn();
    } finally {
      this.#running -= 1;
      const head = await this.#deps.repo.resolve('HEAD').catch(() => null);
      if (head !== null) this.#own.add(head);
    }
  }

  /** Pull and Push need the network, and a library.yaml this app can read (PLAN.md §3.2, §3.19). */
  async #online<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#offline) throw new AppError('git.offline');
    const status = await this.#deps.repo.status();
    const compatibility = await this.pulls.compatibility(status);
    if (compatibility !== 'ok') throw new AppError('sync.libraryTooNew', { reason: compatibility });
    try {
      return await fn();
    } catch (error) {
      if (isAppError(error) && OFFLINE.has(error.code)) {
        this.#offline = true;
        await this.#changed();
      }
      throw error;
    }
  }

  async status(): Promise<SyncStatus> {
    const { repo, store } = this.#deps;
    const [state, status, stashes] = await Promise.all([repo.state(), repo.status(), repo.stashList()]);
    const remote = await repo
      .remoteUrl()
      .then(() => true)
      .catch(() => false);
    const settings = store.read((tx) => tx.settings.get());
    const conflicts = status.entries.flatMap((e) =>
      e.kind === 'conflicted' ? [{ path: e.path, skill: /^skills\/([^/]+)\//.exec(e.path)?.[1] ?? null }] : [],
    );
    // Without a server there's nothing to push to.
    const toPush = !remote ? 0 : status.upstream ? status.ahead : (await this.commits.notPushed(null)).length;
    return {
      branch: status.branch,
      head: status.head,
      upstream: status.upstream,
      incoming: status.behind,
      toPush,
      changes: status.entries.length,
      operation: state.operation,
      conflicts,
      stashes: stashes.length,
      offline: this.#offline,
      fetching: this.#fetching,
      lastFetchAt: this.#lastFetchAt,
      fetchError: this.#fetchError,
      compatibility: await this.pulls.compatibility(status),
      identity: identityOf(store),
      fetchTimer: settings.fetchTimer,
      pullMode: settings.pullMode,
      remote,
    };
  }

  /** Asks for a fetch; requests while one waits join it (background commands coalesce, §2.4). */
  fetch(reason: string): void {
    this.#deps.engine.execute(FetchLibrary, {}).catch((error: unknown) => {
      if (!(isAppError(error) && (error.code === 'command.cancelled' || OFFLINE.has(error.code)))) {
        this.#deps.logger.warn('fetch failed', { reason, error: String(error) });
      }
    });
  }

  /** Step 12: roles and signing join the git screens (the review module's hooks). */
  useReview(hooks: SyncReviewHooks): void {
    this.#deps.review = hooks;
  }

  /** Step 14: the prefix change joins the pull (the prefix module's hooks). */
  usePrefix(hooks: SyncPrefixHooks): void {
    this.#deps.prefix = hooks;
  }

  /**
   * Runs a review command that moves HEAD (a new branch, Pull from main, Move my commits) as the app's own change, so
   * it isn't announced as another git tool's.
   */
  own<T>(fn: () => Promise<T>): Promise<T> {
    return this.#own_(fn);
  }

  /** Tells the renderer and main the sync state changed. */
  changed(): Promise<void> {
    return this.#changed();
  }

  /** Starts the timer (when it's on) and the first fetch (PLAN.md §3.10: at app start). */
  start(): void {
    this.#timer();
    this.fetch('start');
  }

  stop(): void {
    this.#scheduler.stopAll();
  }

  #timer(): void {
    this.#scheduler.stopAll();
    if (this.#deps.store.read((tx) => tx.settings.get()).fetchTimer) {
      this.#scheduler.every(FETCH_INTERVAL_MS, () => this.fetch('timer'));
    }
  }

  /** The device's network changed (PLAN.md §3.19): offline disables Pull and Push; back online fetches at once. */
  setOnline(online: boolean): void {
    this.#networkBack?.cancel();
    this.#networkBack = null;
    if (!online) {
      this.#offline = true;
      void this.#changed();
      return;
    }
    if (!this.#offline) return;
    this.#networkBack = this.#deps.clock.setTimer(NETWORK_SETTLE_MS, () => {
      this.#networkBack = null;
      this.fetch('network back');
    });
  }

  async #fetch(signal: AbortSignal): Promise<void> {
    const { repo, clock, logger } = this.#deps;
    if (
      !(await repo.remoteUrl().then(
        () => true,
        () => false,
      ))
    )
      return;
    this.#fetching = true;
    await this.#changed();
    try {
      await repo.fetch({ signal });
      this.#offline = false;
      this.#fetchError = null;
      this.#lastFetchAt = clock.now();
    } catch (error) {
      if (isAppError(error) && error.code === 'command.cancelled') throw error;
      if (isAppError(error) && OFFLINE.has(error.code)) this.#offline = true;
      else {
        this.#fetchError = isAppError(error)
          ? { code: error.code, params: { ...error.params } }
          : { code: 'internal', params: {} };
        logger.warn('fetch failed', { error: String(error) });
      }
    } finally {
      this.#fetching = false;
      await this.#changed();
    }
    await this.#announceIncoming();
  }

  /** "↓3 from Acme": at most once an hour, and only for commits not announced yet (PLAN.md §3.19). */
  async #announceIncoming(): Promise<void> {
    const { repo, clock } = this.#deps;
    const status = await repo.status();
    if (!status.upstream || status.behind === 0) return;
    const target = await repo.resolve(status.upstream);
    if (target === null || target === this.#lastNotice?.target) return;
    const now = clock.now();
    if (this.#lastNotice && now - this.#lastNotice.at < INCOMING_NOTICE_MS) return;
    const commits = await repo.log({ range: `HEAD..${target}`, max: 100 });
    const skills = new Set<string>();
    for (const commit of commits) for (const skill of (await this.pulls.flags(commit)).skills) skills.add(skill);
    this.#lastNotice = { at: now, target };
    this.#deps.notify({
      type: 'incoming',
      count: status.behind,
      authors: [...new Set(commits.map((c) => c.author.name))].sort(),
      skills: [...skills].sort(),
    });
  }

  /**
   * The link check saw HEAD move (PLAN.md §3.10 "Adjusting links"). A move the app made itself has its own entry;
   * one made with another git tool (a pull in a terminal) that brought other people's commits or changed the skills
   * is listed in a notification.
   */
  async baselineMoved(diff: BaselineDiff): Promise<void> {
    if (this.#running > 0 || this.#own.has(diff.to)) return;
    const { repo, store } = this.#deps;
    const me = identityOf(store)?.email ?? null;
    const commits = diff.exact ? await repo.log({ range: `${diff.from}..${diff.to}`, max: 200 }).catch(() => []) : [];
    const others = commits.filter((c) => c.author.email !== me);
    const { added, deleted, renamed } = diff.changes;
    if (others.length === 0 && added.length === 0 && deleted.length === 0 && renamed.length === 0) return;
    this.#deps.notify({
      type: 'external',
      count: commits.length,
      authors: [...new Set(others.map((c) => c.author.name))].sort(),
      added: [...added],
      removed: [...deleted],
      renamed: renamed.map((r) => ({ from: r.from, to: r.to })),
    });
    await this.#changed();
  }

  /** The renderer and main hear about every change, with the counts for the switcher and the tray. */
  async #changed(): Promise<void> {
    const status = await this.#deps.repo.status().catch(() => null);
    this.#deps.onChange({ incoming: status?.behind ?? 0, toPush: status?.ahead ?? 0 });
  }
}
