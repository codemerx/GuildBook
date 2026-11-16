// The changes screen and the commit pipeline (PLAN.md §3.10 "The changes screen", §3.15; IMPLEMENTATION.md Step 11):
// local changes grouped by skill with their diffs, the commits not pushed yet, the checks before a commit (secrets,
// large files, letter case, validation, the executable bit, S8's deletions), the author and trailers, discard, undo
// the last commit, and push with its own secret scan of the commits it sends.
import type { Commit, GitIdentity, PushRejection } from '../../ports/git.ts';
import { AppError } from '../../shared/errors.ts';
import type { DomainEvent } from '../../shared/events.ts';
import {
  type ChangeGroup,
  clashesWith,
  groupChanges,
  LARGE_FILE_REFUSED,
  LARGE_FILE_WARNING,
  needsExecutableBit,
} from '../domain/changes.ts';
import { skillsOf } from '../domain/flags.ts';
import { isBinary, scanSecrets, type SecretFinding } from '../domain/secrets.ts';
import { blobAt, identityOf, onDisk, requireIdentity, type SyncDeps, textOf } from './sync-context.ts';

export interface ChangesView {
  readonly groups: readonly ChangeGroup[];
  /** Commits on this branch that the server doesn't have yet ("Not pushed yet"), newest first. */
  readonly notPushed: readonly Commit[];
  /** Whether [Undo last commit] can run: the last commit isn't pushed, and it has a parent. */
  readonly canUndo: boolean;
}

export interface ChangeDiff {
  readonly path: string;
  /** HEAD's version (null: new, or binary). */
  readonly before: string | null;
  /** The file on disk (null: deleted, or binary). */
  readonly after: string | null;
  readonly binary: boolean;
}

export interface CommitChecks {
  /** Every path the commit takes. */
  readonly paths: readonly string[];
  readonly skills: readonly string[];
  /** Skills the commit deletes from the library (PLAN.md §3.8 S8): asked first. */
  readonly deletions: readonly string[];
  readonly secrets: readonly SecretFinding[];
  /** Over 10 MB: asked first. */
  readonly largeFiles: ReadonlyArray<{ readonly path: string; readonly size: number }>;
  /** Over 50 MB: refused. */
  readonly tooLarge: ReadonlyArray<{ readonly path: string; readonly size: number }>;
  /** Paths that differ only in letter case: refused. */
  readonly caseClashes: ReadonlyArray<readonly [string, string]>;
  /** New `#!` scripts that get the executable bit. */
  readonly executable: readonly string[];
  /** Validation errors in the skills it commits: asked first. */
  readonly problems: ReadonlyArray<{ readonly skill: string | null; readonly code: string; readonly path: string }>;
  readonly identityNeeded: boolean;
  /** The host requires signed commits and no signing key is chosen yet (PLAN.md §3.10 "Signing"). */
  readonly signingKeyNeeded: boolean;
}

export interface CommitConfirmations {
  readonly deletions?: boolean | undefined;
  readonly secrets?: boolean | undefined;
  readonly largeFiles?: boolean | undefined;
  readonly problems?: boolean | undefined;
}

export type PushResult =
  | {
      readonly kind: 'pushed';
      readonly commits: number;
      readonly branch: string;
      /** The server's own lines: the link to make a change request, where the host sends one (ADR 0032). */
      readonly remoteMessage: string;
    }
  | { readonly kind: 'upToDate' }
  /** Secrets in the commits it would send: nothing was sent; confirm to send anyway (PLAN.md §3.15). */
  | { readonly kind: 'secrets'; readonly findings: readonly SecretFinding[] }
  | {
      readonly kind: 'rejected';
      readonly reason: PushRejection;
      readonly branch: string;
      readonly remoteMessage: string;
    };

export type CommitResult =
  | { readonly kind: 'committed'; readonly commit: string; readonly push: PushResult | null }
  /** The checks need an answer first: nothing was committed. */
  | { readonly kind: 'checks'; readonly checks: CommitChecks };

/** Files larger than this get no text diff. */
const DIFF_MAX_BYTES = 2 * 1024 * 1024;

export class CommitFlow {
  readonly #deps: SyncDeps;
  readonly #emit: () => void;

  constructor(deps: SyncDeps, emit: () => void) {
    this.#deps = deps;
    this.#emit = emit;
  }

  /** The author of the app's commits, or null while it must be asked first (PLAN.md §3.10 "Commit"). */
  identity(): GitIdentity | null {
    return identityOf(this.#deps.store);
  }

  /** The links follow HEAD already: the app's own commit isn't announced as another git tool's change. */
  async recordBaseline(): Promise<void> {
    await this.#deps.baseline.record('HEAD');
  }

  /** The skill folders with files on disk now: a skill with none left is deleted (S8). */
  #present(): Set<string> {
    return new Set((this.#deps.snapshot()?.skills ?? []).filter((s) => s.files > 0).map((s) => s.folder));
  }

  async changes(): Promise<ChangesView> {
    const { repo } = this.#deps;
    const status = await repo.status();
    const groups = groupChanges(status.entries, this.#present());
    const notPushed = await this.notPushed(status.upstream);
    const canUndo = status.head !== null && notPushed.length > 0 && (await repo.resolve('HEAD~1')) !== null;
    return { groups, notPushed, canUndo };
  }

  /** The branch's commits that no remote branch has: all of them before its first push. */
  async notPushed(upstream: string | null): Promise<Commit[]> {
    const { repo } = this.#deps;
    if ((await repo.resolve('HEAD')) === null) return [];
    if (upstream) return repo.log({ range: `${upstream}..HEAD`, max: 200 });
    // A branch never pushed: what isn't on the company branch yet.
    const base = (await repo.remoteBranches())[0]?.name ?? null;
    return repo.log({ range: base ? `${base}..HEAD` : 'HEAD', max: 200 });
  }

  async diff(path: string): Promise<ChangeDiff> {
    const { repo, fs } = this.#deps;
    const head = await repo.resolve('HEAD');
    const before = head === null ? null : await blobAt(repo, head, path).catch(() => null);
    const entry = await fs.lstat(onDisk(this.#deps, path));
    const after =
      entry?.kind === 'file' && entry.size <= DIFF_MAX_BYTES ? await fs.readBytes(onDisk(this.#deps, path)) : null;
    const binary = (before !== null && isBinary(before)) || (after !== null && isBinary(after));
    return { path, before: binary ? null : textOf(before), after: binary ? null : textOf(after), binary };
  }

  /** The checks for committing these paths (PLAN.md §3.10 "Commit", §3.15). */
  async check(paths: readonly string[]): Promise<CommitChecks> {
    const { repo, fs, store } = this.#deps;
    const status = await repo.status();
    const wanted = new Set(paths);
    const entries = status.entries.filter(
      (e) => wanted.has(e.path) || (e.kind === 'changed' && e.from !== null && wanted.has(e.from)),
    );
    if (entries.length === 0) throw new AppError('sync.nothingSelected');
    const groups = groupChanges(entries, this.#present());
    const all = [...new Set(groups.flatMap((g) => g.paths))].sort();
    const head = status.head;
    const tracked = head === null ? [] : (await repo.listTree(head)).filter((e) => e.kind !== 'dir').map((e) => e.path);
    const secrets: SecretFinding[] = [];
    const largeFiles: Array<{ path: string; size: number }> = [];
    const tooLarge: Array<{ path: string; size: number }> = [];
    const executable: string[] = [];
    const present: string[] = [];
    for (const entry of entries) {
      if (entry.kind === 'conflicted') continue;
      const file = onDisk(this.#deps, entry.path);
      const stat = await fs.lstat(file);
      if (stat?.kind !== 'file') continue;
      present.push(entry.path);
      if (stat.size > LARGE_FILE_REFUSED) tooLarge.push({ path: entry.path, size: stat.size });
      else if (stat.size > LARGE_FILE_WARNING) largeFiles.push({ path: entry.path, size: stat.size });
      if (stat.size > LARGE_FILE_WARNING) continue;
      const bytes = await fs.readBytes(file);
      secrets.push(...scanSecrets(entry.path, bytes));
      const isNew = entry.kind === 'untracked' || (entry.kind === 'changed' && entry.staged === 'added');
      const runnable = (stat.mode & 0o111) !== 0;
      if (
        isNew &&
        /^skills\/[^/]+\/scripts\//.test(entry.path) &&
        needsExecutableBit({ path: entry.path, bytes, executable: runnable })
      ) {
        executable.push(entry.path);
      }
    }
    const skills = skillsOf(all);
    // A skill the editor renamed shows as a deletion and a new skill until git sees both in one commit. Committed
    // together, they are a rename: nothing is deleted for anyone (PLAN.md §3.10).
    const renames = this.#deps.links.renames?.() ?? new Map<string, string>();
    const renamedInto = (skill: string): string | null => {
      let name = renames.get(skill) ?? null;
      for (let hops = 0; name !== null && hops < 20; hops++) {
        const next = renames.get(name);
        if (next === undefined) break;
        name = next;
      }
      return name;
    };
    const problems = (this.#deps.snapshot()?.issues ?? [])
      .filter((issue) => issue.severity === 'error' && issue.skill !== null && skills.includes(issue.skill))
      .map((issue) => ({ skill: issue.skill, code: issue.code, path: issue.path }));
    return {
      paths: all,
      skills,
      deletions: groups
        .filter((g) => g.deleted && g.skill !== null)
        .map((g) => g.skill as string)
        .filter((skill) => {
          const to = renamedInto(skill);
          return to === null || !skills.includes(to);
        }),
      secrets,
      largeFiles,
      tooLarge,
      caseClashes: clashesWith(present, tracked),
      executable: executable.sort(),
      problems,
      identityNeeded: (() => {
        try {
          requireIdentity(store);
          return false;
        } catch {
          return true;
        }
      })(),
      signingKeyNeeded: this.#deps.review?.signingKeyNeeded() ?? false,
    };
  }

  /**
   * Commits the paths with the user's message, as the signed-in author with the device and app trailers. Checks that
   * need an answer come back unanswered; a refused one throws. With `push`, pushes after.
   */
  async commit(
    input: { paths: readonly string[]; message: string; confirm: CommitConfirmations; push: boolean },
    emit: (event: DomainEvent) => void,
  ): Promise<CommitResult> {
    const deps = this.#deps;
    const { repo, store } = deps;
    const checks = await this.check(input.paths);
    if (checks.identityNeeded) throw new AppError('sync.identityNeeded');
    if (checks.signingKeyNeeded) throw new AppError('review.signingKeyNeeded');
    if (checks.caseClashes.length > 0) {
      const [a, b] = checks.caseClashes[0]!;
      throw new AppError('sync.caseClash', { a, b });
    }
    if (checks.tooLarge.length > 0) throw new AppError('sync.fileTooLarge', { path: checks.tooLarge[0]!.path });
    const unanswered =
      (checks.deletions.length > 0 && !input.confirm.deletions) ||
      (checks.secrets.length > 0 && !input.confirm.secrets) ||
      (checks.largeFiles.length > 0 && !input.confirm.largeFiles) ||
      (checks.problems.length > 0 && !input.confirm.problems);
    if (unanswered) return { kind: 'checks', checks };
    const message = input.message.trim();
    if (message === '') throw new AppError('sync.nothingSelected');
    const author = requireIdentity(store);
    const commit = await repo.commit({
      message,
      author,
      paths: checks.paths,
      executable: checks.executable,
      trailers: { 'Device-Name': deps.deviceName(), 'App-Version': deps.appVersion },
    });
    deps.activity.append([
      {
        kind: 'committed',
        path: checks.skills.length === 1 ? `skills/${checks.skills[0]}` : null,
        author: author.name,
        commit,
        details: { message: firstLine(message), skills: [...checks.skills], deleted: [...checks.deletions] },
      },
    ]);
    // The links already follow the folder: the app's own commit isn't a change to announce again (Step 10's rename).
    await deps.baseline.record('HEAD');
    this.#emit();
    const push = input.push ? await this.push({ confirmSecrets: input.confirm.secrets === true }, emit) : null;
    return { kind: 'committed', commit, push };
  }

  /** Discard (PLAN.md §3.10): these paths go back to the last commit; new files go. */
  async discard(paths: readonly string[], emit: (event: DomainEvent) => void): Promise<void> {
    const { repo, links, activity } = this.#deps;
    const status = await repo.status();
    const wanted = new Set(paths);
    const entries = status.entries.filter(
      (e) => wanted.has(e.path) || (e.kind === 'changed' && e.from !== null && wanted.has(e.from)),
    );
    if (entries.length === 0) throw new AppError('sync.nothingSelected');
    if (entries.some((e) => e.kind === 'conflicted')) throw new AppError('git.busy', { operation: 'conflicts' });
    const groups = groupChanges(entries, this.#present());
    await repo.discard([...new Set(groups.flatMap((g) => g.paths))]);
    activity.append(
      groups.map((g) => ({
        kind: 'discarded' as const,
        path: g.skill ? `skills/${g.skill}` : g.kind === 'instructions' ? 'instructions' : null,
        details: { files: g.files.length, source: 'changes' },
      })),
    );
    await links.checkNow(emit);
    this.#emit();
  }

  /** [Undo last commit], while it isn't pushed: its changes stay in the folder (PLAN.md §3.10). */
  async undo(emit: (event: DomainEvent) => void): Promise<void> {
    const { repo, activity, baseline, links } = this.#deps;
    const view = await this.changes();
    if (!view.canUndo) throw new AppError('sync.alreadyPushed');
    const last = view.notPushed[0]!;
    await repo.undoCommit();
    activity.append([{ kind: 'commit-undone', path: null, commit: last.id, details: { message: last.subject } }]);
    await baseline.record('HEAD');
    await links.checkNow(emit);
    this.#emit();
  }

  /** The secrets in commits about to be pushed, made in the app or with another git tool (PLAN.md §3.15). */
  async #scanOutgoing(commits: readonly Commit[]): Promise<SecretFinding[]> {
    const { repo } = this.#deps;
    const findings: SecretFinding[] = [];
    for (const commit of commits) {
      const details = await repo.show(commit.id);
      for (const change of details.changes) {
        if (change.status === 'deleted') continue;
        const bytes = await blobAt(repo, commit.id, change.path).catch(() => null);
        if (bytes !== null) findings.push(...scanSecrets(change.path, bytes, commit.id));
      }
    }
    return findings;
  }

  /** Push (PLAN.md §3.10): the current branch, after scanning what it sends. Rejections are explained, never lost. */
  async push(input: { confirmSecrets: boolean }, _emit: (event: DomainEvent) => void): Promise<PushResult> {
    const { repo, activity, review } = this.#deps;
    const status = await repo.status();
    if (status.branch === null) throw new AppError('sync.detached');
    await review?.checkPush(status.branch);
    const commits = await this.notPushed(status.upstream);
    if (commits.length === 0 && status.upstream) return { kind: 'upToDate' };
    if (!input.confirmSecrets) {
      const findings = await this.#scanOutgoing(commits);
      if (findings.length > 0) return { kind: 'secrets', findings };
    }
    const outcome = await repo.push({ branch: status.branch, setUpstream: status.upstream === null });
    if (outcome.kind === 'rejected') {
      // "Pull first": what's new on the server shows at once, so Pull can bring it in.
      if (outcome.reason === 'nonFastForward') await repo.fetch().catch(() => undefined);
      activity.append([
        { kind: 'push-rejected', path: null, details: { branch: status.branch, reason: outcome.reason } },
      ]);
      await review?.pushRejected(outcome.reason, status.branch);
      this.#emit();
      return { kind: 'rejected', reason: outcome.reason, branch: status.branch, remoteMessage: outcome.remoteMessage };
    }
    if (outcome.kind === 'upToDate') return { kind: 'upToDate' };
    activity.append([
      {
        kind: 'pushed',
        path: null,
        commit: status.head,
        details: { branch: status.branch, commits: commits.length },
      },
    ]);
    this.#emit();
    return { kind: 'pushed', commits: commits.length, branch: status.branch, remoteMessage: outcome.remoteMessage };
  }
}

const firstLine = (text: string) => text.split('\n', 1)[0]!;
