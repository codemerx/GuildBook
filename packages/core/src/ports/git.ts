// Git through dugite, behind this port (ADR 0013, IMPLEMENTATION.md §2.9). Everything the app needs from git, as typed
// operations: the library gets the full set (`repo`), the user's code repos only what PLAN.md §3.7 allows
// (`codeRepo`), and the adapter's guard refuses anything else (§2.10). Expected outcomes (conflicts, "would be
// overwritten", a rejected push) are data; failures (authentication, offline, not found, busy) are AppErrors with
// `git.*` codes.
import type { AbsPath } from '../shared/brand.ts';

/** A full object id (40 hex characters for SHA-1 repositories). */
export type Oid = string;

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/** How one command authenticates (ADR 0014). Credentials only ever reach git's environment. */
export type GitAuth =
  | { readonly kind: 'none' }
  /** A host token sent as an HTTP header, only to this origin, e.g. `https://github.com`. */
  | { readonly kind: 'https-header'; readonly origin: string; readonly header: string }
  /** The user's own SSH agent and SSH config. */
  | { readonly kind: 'ssh-agent' }
  /** A key the app keeps (e.g. a deploy key), written to a private temporary file for one command. */
  | { readonly kind: 'ssh-key'; readonly privateKey: string };

export interface GitProgress {
  /** git's phase, e.g. "Receiving objects". */
  readonly phase: string;
  readonly percent: number | null;
}

export interface GitCallOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: GitProgress) => void;
}

// ---- Status -----------------------------------------------------------------------------------------------------

/** One side's state of a path, as `git status --porcelain=v2` reports it. */
export type ChangeCode = 'unmodified' | 'modified' | 'typeChanged' | 'added' | 'deleted' | 'renamed' | 'copied';

export type ConflictKind =
  'bothModified' | 'bothAdded' | 'bothDeleted' | 'addedByUs' | 'addedByThem' | 'deletedByUs' | 'deletedByThem';

export type StatusEntry =
  | {
      readonly kind: 'changed';
      readonly path: string;
      /** Set for a rename or copy recorded in the index: where it came from. */
      readonly from: string | null;
      readonly staged: ChangeCode;
      readonly unstaged: ChangeCode;
    }
  | { readonly kind: 'conflicted'; readonly path: string; readonly conflict: ConflictKind }
  | { readonly kind: 'untracked'; readonly path: string };

export interface BranchStatus {
  /** The checked-out branch, or null when HEAD is detached (e.g. in the middle of a rebase). */
  readonly branch: string | null;
  /** null in a repo without commits. */
  readonly head: Oid | null;
  /** e.g. `origin/main`, when the branch tracks one. */
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
}

export interface Status extends BranchStatus {
  readonly entries: readonly StatusEntry[];
}

// ---- History ----------------------------------------------------------------------------------------------------

export interface Commit {
  readonly id: Oid;
  readonly parents: readonly Oid[];
  readonly author: GitIdentity;
  /** Epoch milliseconds. */
  readonly authorDate: number;
  readonly committer: GitIdentity;
  readonly commitDate: number;
  /** The first line. */
  readonly subject: string;
  /** The whole message, trailers included. */
  readonly message: string;
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typeChanged';

/** One file in a diff, with renames detected (`--name-status -M`). */
export interface FileChange {
  readonly status: FileChangeStatus;
  readonly path: string;
  /** The old path, for a rename or copy. */
  readonly from: string | null;
  /** git's similarity in percent, for a rename or copy. */
  readonly similarity: number | null;
}

export interface CommitDetails extends Commit {
  /** Compared with the first parent (or the empty tree for the first commit). */
  readonly changes: readonly FileChange[];
}

export interface LogOptions {
  /** A revision or range, e.g. `HEAD`, `main..origin/main`. Defaults to HEAD. */
  readonly range?: string;
  /** Only commits that touch these paths (relative to the repo). */
  readonly paths?: readonly string[];
  readonly max?: number;
  readonly skip?: number;
}

/** A diff's ends: a commit-ish, or the working tree. */
export type DiffEnd = string | { readonly worktree: true };

export type TreeEntryKind = 'file' | 'executable' | 'link' | 'dir' | 'submodule';

export interface GitTreeEntry {
  /** Relative to the tree's root, with forward slashes. */
  readonly path: string;
  readonly kind: TreeEntryKind;
  readonly oid: Oid;
  /** Blob size in bytes; 0 for folders and submodules. */
  readonly size: number;
}

// ---- Changing the repo ------------------------------------------------------------------------------------------

export interface CommitInput {
  readonly message: string;
  readonly author: GitIdentity;
  /** Trailers appended to the message, e.g. `Device-Name: John-MacBook` (PLAN.md §3.10). */
  readonly trailers?: Readonly<Record<string, string>>;
  /** Stage these paths first (additions, changes and deletions); without it, what's staged is committed. */
  readonly paths?: readonly string[];
  readonly allowEmpty?: boolean;
  /** Files among `paths` that get the executable bit in git (new `#!` scripts, PLAN.md §3.10). */
  readonly executable?: readonly string[];
}

export type IntegrateMode = 'merge' | 'rebase';

export interface IntegrateInput {
  /** The commit to bring in: exactly the fetched commit the preview used (IMPLEMENTATION.md §2.5). */
  readonly commit: Oid;
  /** For the merge commit's message, e.g. `origin/main`. */
  readonly name: string;
  readonly mode: IntegrateMode;
  /** Stash local changes that overlap, integrate, and re-apply them (git's autostash). */
  readonly autostash: boolean;
  readonly identity: GitIdentity;
  /** The merge commit's message; by default git's for a remote-tracking branch, e.g. a local branch merged in. */
  readonly message?: string;
}

export type IntegrateOutcome =
  | { readonly kind: 'upToDate' }
  | { readonly kind: 'fastForwarded'; readonly head: Oid }
  | { readonly kind: 'merged'; readonly head: Oid }
  | { readonly kind: 'rebased'; readonly head: Oid }
  /** git refused, as it always does: local changes to files the integration changes (PLAN.md §3.10 step 1). */
  | { readonly kind: 'wouldBeOverwritten'; readonly files: readonly string[] }
  /** Stopped with conflicts in the files; the repo is merging or rebasing. */
  | { readonly kind: 'conflicts'; readonly files: readonly string[] }
  /** Integrated, but re-applying the autostash conflicted; the stash is kept. */
  | { readonly kind: 'stashConflicts'; readonly head: Oid; readonly files: readonly string[] };

export type ContinueOutcome =
  | { readonly kind: 'done'; readonly head: Oid }
  /** A rebase stopped again on the next commit. */
  | { readonly kind: 'conflicts'; readonly files: readonly string[] }
  /** Conflict markers or unmerged paths are left. */
  | { readonly kind: 'unresolved'; readonly files: readonly string[] };

export interface GitConflict {
  readonly path: string;
  readonly kind: ConflictKind;
}

/** The three versions of a conflicted path in the index (stages 1–3); null where a side has none. */
export interface ConflictVersions {
  readonly base: Oid | null;
  readonly ours: Oid | null;
  readonly theirs: Oid | null;
}

/** How a conflicted path is resolved without editing it: one side's version, or deleted. */
export type ConflictTake = 'ours' | 'theirs' | 'delete';

/** The commits whose sides a conflict shows (PLAN.md §3.10: "current" and "incoming" swap places during a rebase). */
export interface OperationHeads {
  /** The commit being merged in (MERGE_HEAD), reverted (REVERT_HEAD) or picked. */
  readonly incoming: Oid | null;
  /** A rebase: the commit being replayed (REBASE_HEAD), and the one the branch is replayed onto. */
  readonly replaying: Oid | null;
  readonly onto: Oid | null;
}

/** `unsigned`: the host requires signed commits (PLAN.md §3.10 "Signing"). */
export type PushRejection = 'nonFastForward' | 'protected' | 'unsigned' | 'other';

export type PushOutcome =
  | {
      readonly kind: 'pushed';
      readonly dryRun: boolean;
      /** The server's own lines (`remote: …`): a host sends the link to make a change request here (ADR 0032). */
      readonly remoteMessage: string;
    }
  | { readonly kind: 'upToDate' }
  | {
      readonly kind: 'rejected';
      readonly reason: PushRejection;
      /** The host whose message it was, when it's recognized. */
      readonly host: 'github' | 'gitlab' | null;
      /** The server's own lines (`remote: …`), for the explanation. */
      readonly remoteMessage: string;
    };

export interface PushInput {
  readonly branch: string;
  /** Defaults to the same name. */
  readonly remoteBranch?: string;
  readonly dryRun?: boolean;
  readonly setUpstream?: boolean;
}

export interface Stash {
  readonly index: number;
  readonly id: Oid;
  readonly message: string;
}

export interface Branch {
  readonly name: string;
  readonly head: Oid;
  readonly current: boolean;
  readonly upstream: string | null;
}

export interface RemoteBranch {
  /** e.g. `origin/main` */
  readonly name: string;
  readonly head: Oid;
}

export type StashApplyOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'conflicts'; readonly files: readonly string[] }
  | { readonly kind: 'wouldBeOverwritten'; readonly files: readonly string[] };

export type RevertOutcome =
  { readonly kind: 'reverted'; readonly head: Oid } | { readonly kind: 'conflicts'; readonly files: readonly string[] };

/**
 * How the app signs commits where the host requires it (PLAN.md §3.10 "Signing"): git's SSH signing, with the user's
 * own key file (the agent may hold its private part), or a key the app keeps, written to a private file per command.
 */
export type GitSigning =
  { readonly kind: 'file'; readonly path: string } | { readonly kind: 'key'; readonly privateKey: string };

/** A path that a dry-run merge reports as conflicting. */
export interface MergeTreeConflict {
  readonly path: string;
  /** git's conflict type, e.g. `CONFLICT (contents)`, `CONFLICT (modify/delete)`. */
  readonly type: string;
}

export interface MergeTreeResult {
  /** The tree git would produce (with conflict markers in conflicting files). */
  readonly tree: Oid;
  readonly clean: boolean;
  readonly conflicts: readonly MergeTreeConflict[];
}

/** What another git tool (or this app) is in the middle of, from the repo's state files (IMPLEMENTATION.md §2.4). */
export interface RepoState {
  readonly operation: 'none' | 'merging' | 'rebasing' | 'cherryPicking' | 'reverting';
  /** `index.lock` exists: a git command is running, or one crashed. */
  readonly busy: boolean;
}

export interface FetchResult {
  /** Remote branches that moved, e.g. `origin/main`. */
  readonly updated: readonly string[];
}

export interface RemoteRefs {
  /** The branch the remote's HEAD points at (its default branch), when it says. */
  readonly head: string | null;
  readonly branches: ReadonlyArray<{ readonly name: string; readonly head: Oid }>;
}

export interface CloneInput extends GitCallOptions {
  readonly url: string;
  /** Must not exist yet, or be an empty folder. */
  readonly dest: AbsPath;
  readonly branch?: string;
  /** Only the newest commit (`--depth 1`): an import reads one version (PLAN.md §3.18). */
  readonly shallow?: boolean;
  /** How this clone signs in, instead of the library's sign-in for the URL (an import over SSH uses the agent). */
  readonly auth?: GitAuth;
}

/** The library (or another repo the app works in, such as a download folder): every operation. */
export interface GitRepo {
  readonly path: AbsPath;
  state(): Promise<RepoState>;
  status(): Promise<Status>;
  /** Resolves a revision to a commit id, or null when it doesn't exist. */
  resolve(revision: string): Promise<Oid | null>;
  fetch(options?: GitCallOptions): Promise<FetchResult>;
  aheadBehind(local: string, upstream: string): Promise<{ ahead: number; behind: number }>;
  /** The remote's default branch: `origin/HEAD` if git knows it, else asked of the remote. */
  defaultBranch(options?: GitCallOptions): Promise<string | null>;
  log(options?: LogOptions): Promise<Commit[]>;
  show(commit: string): Promise<CommitDetails>;
  diff(from: DiffEnd, to: DiffEnd, paths?: readonly string[]): Promise<FileChange[]>;
  /** Every entry of a tree, folders included, recursively. */
  listTree(treeish: string, path?: string): Promise<GitTreeEntry[]>;
  readBlob(oid: Oid): Promise<Uint8Array>;
  commit(input: CommitInput): Promise<Oid>;
  push(input: PushInput, options?: GitCallOptions): Promise<PushOutcome>;
  integrate(input: IntegrateInput): Promise<IntegrateOutcome>;
  /** Continues the merge (commits it with git's message) or the rebase, after the conflicts are resolved. */
  continue(identity: GitIdentity): Promise<ContinueOutcome>;
  /** Returns to the state before the merge or rebase started, local changes included. */
  abort(): Promise<void>;
  conflicts(): Promise<GitConflict[]>;
  /** Stages resolved files. */
  markResolved(paths: readonly string[]): Promise<void>;
  /** The base, ours and theirs versions of a conflicted path (the three-way view, PLAN.md §3.10). */
  conflictVersions(path: string): Promise<ConflictVersions>;
  /** Resolves a conflicted path with one side's version, or by deleting it, and stages it (binary, edit vs delete). */
  takeConflict(path: string, take: ConflictTake): Promise<void>;
  /** What a merge, rebase or revert in progress brings together. */
  operationHeads(): Promise<OperationHeads>;
  stashPush(input: { message: string; identity: GitIdentity; includeUntracked?: boolean }): Promise<Oid | null>;
  stashList(): Promise<Stash[]>;
  stashApply(index: number, options: { pop: boolean; identity: GitIdentity }): Promise<StashApplyOutcome>;
  stashDrop(index: number): Promise<void>;
  branches(): Promise<Branch[]>;
  remoteBranches(): Promise<RemoteBranch[]>;
  createBranch(name: string, start: string): Promise<void>;
  /** Fails with `git.wouldBeOverwritten` when local changes block the switch. */
  switchBranch(name: string): Promise<void>;
  deleteBranch(name: string, options?: { force?: boolean }): Promise<void>;
  revert(commit: Oid, identity: GitIdentity): Promise<RevertOutcome>;
  /**
   * The tree ids `path` had in HEAD's history, newest first, one per commit that changed it: the company versions a
   * real folder at a link path is compared with (PLAN.md §3.8 S4 STALE).
   */
  pathVersions(path: string, options?: { max?: number }): Promise<Oid[]>;
  /**
   * The paths the library's ignore rules match (`git check-ignore`), relative to the library with forward slashes. A
   * path doesn't need to exist; a tracked file is never ignored. Projected copies never write these back (PLAN.md §3.3).
   */
  ignored(paths: readonly string[]): Promise<string[]>;
  /** Restores paths in the index and the working tree from a commit, HEAD by default (PLAN.md §3.8 S8 [Restore]). */
  restore(paths: readonly string[], source?: string): Promise<void>;
  /** `reset --keep`: moves the branch to a commit, keeping local changes. */
  resetKeep(commit: Oid): Promise<void>;
  /** Points another branch than the current one at a commit (`branch -f`): [Move my commits to a new branch]. */
  forceBranch(name: string, commit: Oid): Promise<void>;
  /** Whether `ancestor` is reachable from `commit`. */
  isAncestor(ancestor: string, commit: string): Promise<boolean>;
  /** Where two histories meet (`merge-base`), or null when they don't. */
  mergeBase(a: string, b: string): Promise<Oid | null>;
  /**
   * Makes every commit after `base` again, signed (PLAN.md §3.10 [Sign my unpushed commits and push again]): authors,
   * dates of authorship and merges stay; local changes stay too.
   */
  signCommits(base: Oid, identity: GitIdentity): Promise<Oid>;
  /**
   * [Undo last commit] (PLAN.md §3.10): the branch goes back one commit, and the commit's changes stay in the folder
   * and the index (`reset --soft HEAD~1`). Nothing in the folder changes.
   */
  undoCommit(): Promise<void>;
  /**
   * Discard (PLAN.md §3.10): these paths go back to HEAD in the index and the folder, and untracked files among them are
   * deleted. Ignored files stay.
   */
  discard(paths: readonly string[]): Promise<void>;
  /** A dry-run merge that doesn't touch the working tree (`merge-tree --write-tree`). */
  mergeTree(ours: string, theirs: string): Promise<MergeTreeResult>;
  /** The `origin` remote's URL (PLAN.md §3.1 Change URL). */
  remoteUrl(): Promise<string>;
  /** Points `origin` at another URL, e.g. after the repo was renamed or moved (PLAN.md §3.1 Change URL). */
  setRemoteUrl(url: string): Promise<void>;
  /** Fetches another URL's default branch without touching any ref but FETCH_HEAD, and returns its commit. */
  fetchUrl(url: string, options?: GitCallOptions): Promise<Oid>;
  /** In a repo without commits (a clone of an empty repo), names the branch the first commit goes on. */
  setUnbornBranch(name: string): Promise<void>;
}

/** A user's code repo: only what PLAN.md §3.7 rule 4 allows. */
export interface CodeRepoGit {
  readonly path: AbsPath;
  /** The remote's URL, or null when there's no such remote. */
  remoteUrl(name?: string): Promise<string | null>;
  /** The main working tree first, then the linked worktrees. */
  worktrees(): Promise<ReadonlyArray<{ readonly path: AbsPath; readonly branch: string | null }>>;
  /** The repo's local exclude file (`info/exclude`, shared by its worktrees). */
  excludePath(): Promise<AbsPath>;
  /** Whether this one path is in the commit HEAD points at. */
  isCommitted(path: string): Promise<boolean>;
}

/**
 * A folder the user picked to import from, or the app's clone of a repo URL (PLAN.md §3.18): only what
 * `metadata.source` needs, its remote and current commit, and where the folder sits in its repo.
 */
export interface ImportSourceGit {
  readonly path: AbsPath;
  /** `origin`'s URL, or null when there's no such remote or no repo. */
  remoteUrl(): Promise<string | null>;
  /** The commit HEAD points at, or null (no repo, or no commit yet). */
  head(): Promise<Oid | null>;
  /** The folder's path in its repo, with forward slashes ('' at the top), or null when it isn't in a repo. */
  prefix(): Promise<string | null>;
}

export interface Git {
  /** The bundled git's version, e.g. "2.53.0". */
  version(): Promise<string>;
  clone(input: CloneInput): Promise<void>;
  lsRemote(url: string, options?: GitCallOptions): Promise<RemoteRefs>;
  repo(path: AbsPath): GitRepo;
  codeRepo(path: AbsPath): CodeRepoGit;
  importSource(path: AbsPath): ImportSourceGit;
}
