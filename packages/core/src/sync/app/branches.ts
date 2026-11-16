// Branches, stashes and history, as in other git GUIs (PLAN.md §3.10 "Also as in other git GUIs"): create, switch
// (local changes that block a switch get the same choices as a pull), merge and delete branches; stash, apply and drop;
// the library's history and a skill's, each commit's files and flags, and [Revert this commit] (§3.15).
import type { Branch, Commit, FileChange, Oid, Stash } from '../../ports/git.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import type { DomainEvent } from '../../shared/events.ts';
import type { CommitFlags } from '../domain/flags.ts';
import type { PullFlow } from './incoming.ts';
import { blobAt, requireIdentity, type SyncDeps, textOf } from './sync-context.ts';

export interface BranchesView {
  readonly current: string | null;
  /** The repo's default branch on the server: the company branch (PLAN.md §3.10). */
  readonly defaultBranch: string | null;
  readonly local: readonly Branch[];
  /** Branches on the server that have no local branch yet: switching to one makes it. */
  readonly remote: ReadonlyArray<{ readonly name: string; readonly head: Oid }>;
}

export interface HistoryEntry extends CommitFlags {
  readonly id: Oid;
  readonly subject: string;
  readonly author: string;
  readonly authorDate: number;
  readonly merge: boolean;
  /** Not on the server yet ("Not pushed yet"). */
  readonly local: boolean;
}

export interface CommitView extends HistoryEntry {
  readonly message: string;
  readonly parents: readonly Oid[];
  readonly changes: readonly FileChange[];
}

export type SwitchResult =
  | { readonly kind: 'switched' }
  /** Local changes block the switch: commit them first, or stash, switch and re-apply (PLAN.md §3.10). */
  | { readonly kind: 'localChanges'; readonly files: readonly string[] }
  | { readonly kind: 'stashConflicts'; readonly files: readonly string[] };

export type MergeResult =
  | { readonly kind: 'merged' }
  | { readonly kind: 'upToDate' }
  | { readonly kind: 'localChanges'; readonly files: readonly string[] }
  | { readonly kind: 'conflicts'; readonly files: readonly string[] };

export type StashResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'localChanges'; readonly files: readonly string[] }
  | { readonly kind: 'conflicts'; readonly files: readonly string[] };

export type RevertResult =
  { readonly kind: 'reverted' } | { readonly kind: 'conflicts'; readonly files: readonly string[] };

/** git's own rules for a branch name, the ones a person can break by typing (`git check-ref-format`). */
export function branchNameValid(name: string): boolean {
  if (name === '' || name.length > 200 || name.startsWith('-') || name.startsWith('/') || name.endsWith('/'))
    return false;
  if (name.endsWith('.') || name.endsWith('.lock') || name === '@') return false;
  if (/\.\.|\/\/|@\{|\/\.|^\./.test(name)) return false;
  // Control characters, spaces and the characters git refuses.
  if ([...name].some((c) => c.charCodeAt(0) <= 0x20 || c.charCodeAt(0) === 0x7f)) return false;
  return !/[~^:?*[\\]/.test(name);
}

/** A stash's own message: git adds "On <branch>: " (or "WIP on <branch>: "). */
export function stashMessage(message: string): string {
  return message.replace(/^(?:WIP on|On) [^:]+: /, '');
}

export class BranchFlow {
  readonly #deps: SyncDeps;
  readonly #pull: PullFlow;
  readonly #emit: () => void;

  constructor(deps: SyncDeps, pull: PullFlow, emit: () => void) {
    this.#deps = deps;
    this.#pull = pull;
    this.#emit = emit;
  }

  async branches(): Promise<BranchesView> {
    const { repo } = this.#deps;
    const local = await repo.branches();
    const status = await repo.status();
    const names = new Set(local.map((b) => b.name));
    const remote = (await repo.remoteBranches())
      .filter((b) => !b.name.endsWith('/HEAD'))
      .map((b) => ({ name: b.name, head: b.head, short: b.name.replace(/^[^/]+\//, '') }))
      .filter((b) => !names.has(b.short))
      .map((b) => ({ name: b.short, head: b.head }));
    const defaultBranch = await repo.defaultBranch().catch(() => null);
    return { current: status.branch, defaultBranch, local, remote };
  }

  async create(name: string, switchTo: boolean, emit: (event: DomainEvent) => void): Promise<SwitchResult> {
    const { repo, activity } = this.#deps;
    if (!branchNameValid(name)) throw new AppError('sync.branchName', { name });
    if ((await repo.branches()).some((b) => b.name === name)) throw new AppError('sync.branchExists', { name });
    await repo.createBranch(name, 'HEAD');
    activity.append([{ kind: 'branch-created', path: null, details: { branch: name } }]);
    this.#emit();
    return switchTo ? this.switchTo(name, false, emit) : { kind: 'switched' };
  }

  /** Switches branches; with `stash`, local changes are stashed, and re-applied on the other branch. */
  async switchTo(name: string, stash: boolean, emit: (event: DomainEvent) => void): Promise<SwitchResult> {
    const { repo, activity, links, store } = this.#deps;
    const before = (await repo.status()).branch;
    let stashed = false;
    if (stash) {
      stashed =
        (await repo.stashPush({
          message: `Switching to ${name}`,
          identity: requireIdentity(store),
          includeUntracked: true,
        })) !== null;
    }
    try {
      await repo.switchBranch(name);
    } catch (error) {
      if (isAppError(error) && error.code === 'git.wouldBeOverwritten') {
        const files = String(error.params.files ?? '')
          .split(', ')
          .filter((f) => f !== '');
        return { kind: 'localChanges', files };
      }
      if (stashed) await repo.stashApply(0, { pop: true, identity: requireIdentity(store) });
      throw error;
    }
    activity.append([{ kind: 'branch-switched', path: null, details: { from: before, to: name } }]);
    let result: SwitchResult = { kind: 'switched' };
    if (stashed) {
      const applied = await repo.stashApply(0, { pop: true, identity: requireIdentity(store) });
      if (applied.kind !== 'applied') result = { kind: 'stashConflicts', files: applied.files };
    }
    // Tools always see the checked-out branch: the links follow it now.
    await links.checkNow(emit);
    this.#emit();
    return result;
  }

  /**
   * Merges another branch into the current one, as a merge commit when needed. `remote`: the server's branch, e.g.
   * the company branch into a request branch ([Pull from main], PLAN.md §3.11 step 6).
   */
  async merge(name: string, emit: (event: DomainEvent) => void, remote = false): Promise<MergeResult> {
    const { repo, activity, links, store } = this.#deps;
    const ref = remote ? `origin/${name}` : name;
    const tip = await repo.resolve(remote ? `refs/remotes/origin/${name}` : `refs/heads/${name}`);
    if (tip === null) throw new AppError('git.notFound', { branch: ref });
    const outcome = await repo.integrate({
      commit: tip,
      name: ref,
      mode: 'merge',
      autostash: false,
      identity: requireIdentity(store),
      message: remote ? `Merge remote-tracking branch '${ref}'` : `Merge branch '${name}'`,
    });
    if (outcome.kind === 'wouldBeOverwritten') return { kind: 'localChanges', files: outcome.files };
    if (outcome.kind === 'conflicts' || outcome.kind === 'stashConflicts') {
      this.#emit();
      return { kind: 'conflicts', files: outcome.files };
    }
    if (outcome.kind === 'upToDate') return { kind: 'upToDate' };
    activity.append([{ kind: 'merged', path: null, commit: outcome.head, details: { branch: ref } }]);
    await links.checkNow(emit);
    this.#emit();
    return { kind: 'merged' };
  }

  async remove(name: string, force: boolean): Promise<void> {
    const { repo, activity } = this.#deps;
    if ((await repo.status()).branch === name) throw new AppError('sync.currentBranch', { name });
    try {
      await repo.deleteBranch(name, { force });
    } catch (error) {
      if (!force && isAppError(error) && error.code === 'git.failed')
        throw new AppError('sync.branchNotMerged', { name });
      throw error;
    }
    activity.append([{ kind: 'branch-deleted', path: null, details: { branch: name, force } }]);
    this.#emit();
  }

  // ---- Stashes ------------------------------------------------------------------------------------------------

  /** The stashes, with git's "On <branch>: " left out of their messages. */
  async stashes(): Promise<Stash[]> {
    return (await this.#deps.repo.stashList()).map((s) => ({ ...s, message: stashMessage(s.message) }));
  }

  async stash(message: string, emit: (event: DomainEvent) => void): Promise<void> {
    const { repo, activity, links, store } = this.#deps;
    const text = message.trim() === '' ? 'Changes put aside' : message.trim();
    const id = await repo.stashPush({ message: text, identity: requireIdentity(store), includeUntracked: true });
    if (id === null) throw new AppError('sync.nothingToStash');
    activity.append([{ kind: 'stashed', path: null, details: { message: text } }]);
    await links.checkNow(emit);
    this.#emit();
  }

  async apply(index: number, drop: boolean, emit: (event: DomainEvent) => void): Promise<StashResult> {
    const { repo, activity, links, store } = this.#deps;
    const stash = (await repo.stashList()).find((s) => s.index === index);
    if (!stash) throw new AppError('sync.stashNotFound', { index });
    const outcome = await repo.stashApply(index, { pop: drop, identity: requireIdentity(store) });
    if (outcome.kind === 'wouldBeOverwritten') return { kind: 'localChanges', files: outcome.files };
    activity.append([
      { kind: 'stash-applied', path: null, details: { message: stashMessage(stash.message), dropped: drop } },
    ]);
    await links.checkNow(emit);
    this.#emit();
    return outcome.kind === 'conflicts' ? { kind: 'conflicts', files: outcome.files } : { kind: 'applied' };
  }

  async drop(index: number): Promise<void> {
    const { repo, activity } = this.#deps;
    const stash = (await repo.stashList()).find((s) => s.index === index);
    if (!stash) throw new AppError('sync.stashNotFound', { index });
    await repo.stashDrop(index);
    activity.append([{ kind: 'stash-dropped', path: null, details: { message: stashMessage(stash.message) } }]);
    this.#emit();
  }

  // ---- History ------------------------------------------------------------------------------------------------

  async #entry(commit: Commit, local: ReadonlySet<string>): Promise<HistoryEntry> {
    return {
      id: commit.id,
      subject: commit.subject,
      author: commit.author.name,
      authorDate: commit.authorDate,
      merge: commit.parents.length > 1,
      local: local.has(commit.id),
      ...(await this.#pull.flags(commit)),
    };
  }

  async #local(): Promise<Set<string>> {
    const { repo } = this.#deps;
    const status = await repo.status();
    if (status.head === null) return new Set();
    const base = status.upstream ?? (await repo.remoteBranches())[0]?.name ?? null;
    const commits = await repo.log({ range: base ? `${base}..HEAD` : 'HEAD', max: 500 });
    return new Set(commits.map((c) => c.id));
  }

  /** The library's history, or one skill's (PLAN.md §3.10 "History"), newest first. */
  async history(input: { skill?: string | null; skip: number; max: number }): Promise<HistoryEntry[]> {
    const { repo } = this.#deps;
    const paths = input.skill ? [`skills/${input.skill}`] : undefined;
    const commits = await repo.log({ max: input.max, skip: input.skip, ...(paths ? { paths } : {}) });
    const local = await this.#local();
    const out: HistoryEntry[] = [];
    for (const commit of commits) out.push(await this.#entry(commit, local));
    return out;
  }

  async commit(id: string): Promise<CommitView> {
    const { repo } = this.#deps;
    const details = await repo.show(id);
    return {
      ...(await this.#entry(details, await this.#local())),
      message: details.message,
      parents: details.parents,
      changes: details.changes,
    };
  }

  /** A file before and after a commit, for its diff; null where it isn't (or is binary). */
  async commitDiff(
    id: string,
    path: string,
  ): Promise<{ path: string; before: string | null; after: string | null; binary: boolean }> {
    const { repo } = this.#deps;
    const details = await repo.show(id);
    const change = details.changes.find((c) => c.path === path);
    if (!change) throw new AppError('git.notFound', { path });
    const parent = details.parents[0] ?? null;
    const before = parent === null ? null : await blobAt(repo, parent, change.from ?? path).catch(() => null);
    const after = change.status === 'deleted' ? null : await blobAt(repo, details.id, path).catch(() => null);
    const binary = (before !== null && textOf(before) === null) || (after !== null && textOf(after) === null);
    return { path, before: binary ? null : textOf(before), after: binary ? null : textOf(after), binary };
  }

  /** [Revert this commit] (PLAN.md §3.15): a new commit that undoes it; pushed like any other. */
  async revert(id: string, emit: (event: DomainEvent) => void): Promise<RevertResult> {
    const { repo, activity, links, store } = this.#deps;
    const resolved = await repo.resolve(id);
    const [commit] = resolved === null ? [] : await repo.log({ range: resolved, max: 1 });
    if (!commit) throw new AppError('git.notFound', { commit: id });
    const outcome = await repo.revert(commit.id, requireIdentity(store));
    if (outcome.kind === 'conflicts') {
      this.#emit();
      return { kind: 'conflicts', files: outcome.files };
    }
    activity.append([
      { kind: 'reverted', path: null, commit: outcome.head, details: { reverted: commit.id, subject: commit.subject } },
    ]);
    await links.checkNow(emit);
    this.#emit();
    return { kind: 'reverted' };
  }
}
