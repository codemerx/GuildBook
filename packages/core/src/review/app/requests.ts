// Change requests (PLAN.md §3.11 "Change requests", ADR 0032): ordinary branches, as in a plain git GUI. A Member
// commits to a new branch and pushes it; the request is made, reviewed and merged on the host's website. The app opens
// the page that makes it: the link the server sent with the push, else the page the host kind gives, else none (a
// plain git server: the person asks a reviewer to merge the branch).
import { parseGitUrl } from '../../library/index.ts';
import { AppError } from '../../shared/errors.ts';
import type { DomainEvent } from '../../shared/events.ts';
import {
  branchNameValid,
  type CommitConfirmations,
  type CommitResult,
  identityOf,
  type PushResult,
} from '../../sync/index.ts';
import { requestLinkFrom, slug, suggestBranch } from '../domain/requests.ts';
import { accountOf, type ReviewDeps } from './review-context.ts';

export type OpenResult =
  /** The branch is on the server. `link` is the page that makes the request, or null: ask a reviewer to merge it. */
  | { readonly kind: 'opened'; readonly branch: string; readonly base: string; readonly link: string | null }
  /** The push came back with secrets or a rejection: nothing was sent. */
  | { readonly kind: 'push'; readonly push: PushResult };

/** A branch on the server with work the company branch doesn't hold: an open change request, or one to come. */
export interface ServerBranch {
  readonly branch: string;
  /** The newest commit's subject and author. */
  readonly title: string;
  readonly author: string;
}

export class RequestFlow {
  readonly #deps: ReviewDeps;
  readonly #changed: () => void;

  constructor(deps: ReviewDeps, changed: () => void) {
    this.#deps = deps;
    this.#changed = changed;
  }

  /** The company branch: the repo's default branch on the server (PLAN.md §3.10). */
  async companyBranch(): Promise<string> {
    return (await this.#deps.repo.defaultBranch().catch(() => null)) ?? 'main';
  }

  /** Who the user is, for the branch name: the host login, or the commit author's name where there's no account. */
  #who(): string {
    const login = accountOf(this.#deps.store)?.login ?? null;
    return slug(login ?? identityOf(this.#deps.store)?.name ?? 'me');
  }

  /** Every branch name taken here or on the server. */
  async #taken(): Promise<Set<string>> {
    const { repo } = this.#deps;
    const local = (await repo.branches()).map((b) => b.name);
    const remote = (await repo.remoteBranches()).map((b) => b.name.replace(/^[^/]+\//, ''));
    return new Set([...local, ...remote]);
  }

  /** [Commit to a new branch]'s suggestion: `requests/<who>/<first skill>` (PLAN.md §3.11 step 1). */
  async suggest(skills: readonly string[]): Promise<string> {
    return suggestBranch(this.#who(), skills, await this.#taken());
  }

  /**
   * [Commit to a new branch] (PLAN.md §3.11 step 1): the branch starts at the current commit and takes the uncommitted
   * changes along; then the chosen paths are committed there. Checks that need an answer come back first, before
   * anything moves.
   */
  async commitToNewBranch(
    input: { paths: readonly string[]; message: string; branch: string; confirm: CommitConfirmations },
    emit: (event: DomainEvent) => void,
  ): Promise<CommitResult> {
    const { repo, sync, activity } = this.#deps;
    const branch = input.branch.trim();
    if (!branchNameValid(branch)) throw new AppError('sync.branchName', { name: branch });
    if ((await this.#taken()).has(branch)) throw new AppError('sync.branchExists', { name: branch });
    const checks = await sync.commits.check(input.paths);
    const unanswered =
      (checks.deletions.length > 0 && !input.confirm.deletions) ||
      (checks.secrets.length > 0 && !input.confirm.secrets) ||
      (checks.largeFiles.length > 0 && !input.confirm.largeFiles) ||
      (checks.problems.length > 0 && !input.confirm.problems);
    if (unanswered) return { kind: 'checks', checks };
    const before = (await repo.status()).branch;
    return sync.own(async () => {
      await repo.createBranch(branch, 'HEAD');
      // The new branch is at the same commit: switching changes no file, so every local change comes along.
      await repo.switchBranch(branch);
      activity.append([{ kind: 'branch-created', path: null, details: { branch, from: before } }]);
      try {
        return await sync.commits.commit({ ...input, push: false }, emit);
      } catch (error) {
        // Nothing was committed: back to where the user was, without the new branch.
        if (before !== null) {
          await repo.switchBranch(before).catch(() => undefined);
          await repo.deleteBranch(branch, { force: true }).catch(() => undefined);
        }
        throw error;
      } finally {
        this.#changed();
      }
    });
  }

  /**
   * [Push and open change request] (PLAN.md §3.11 step 2, ADR 0032): pushes the current branch, and finds the page
   * that makes the request. Pushing again to a branch that has a request adds to it on the host.
   */
  async open(input: { confirmSecrets: boolean }, emit: (event: DomainEvent) => void): Promise<OpenResult> {
    const { repo, sync, activity } = this.#deps;
    const branch = (await repo.status()).branch;
    if (branch === null) throw new AppError('sync.detached');
    const base = await this.companyBranch();
    if (branch === base) throw new AppError('review.notARequestBranch', { branch });
    const push = await sync.commits.push({ confirmSecrets: input.confirmSecrets }, emit);
    if (push.kind !== 'pushed' && push.kind !== 'upToDate') return { kind: 'push', push };
    const sent = push.kind === 'pushed' ? push.remoteMessage : '';
    const link = (await this.#serverLink(sent)) ?? (await this.#deps.newRequestUrl(branch, base).catch(() => null));
    activity.append([{ kind: 'request-opened', path: null, details: { branch, link } }]);
    this.#changed();
    return { kind: 'opened', branch, base, link };
  }

  /** The link in the server's lines, when it is on the library's own server. */
  async #serverLink(remoteMessage: string): Promise<string | null> {
    if (remoteMessage === '') return null;
    const url = parseGitUrl(await this.#deps.repo.remoteUrl().catch(() => ''));
    return url.ok ? requestLinkFrom(remoteMessage, url.value.host) : null;
  }

  /**
   * The branches on the server with work the company branch doesn't hold, newest first (PLAN.md §3.2 step 4): the open
   * change requests, as git sees them on every host.
   */
  async serverBranches(): Promise<ServerBranch[]> {
    const { repo } = this.#deps;
    const base = await this.companyBranch();
    const found: Array<ServerBranch & { at: number }> = [];
    for (const remote of await repo.remoteBranches()) {
      const branch = remote.name.replace(/^[^/]+\//, '');
      if (branch === base || branch === 'HEAD') continue;
      if (await repo.isAncestor(remote.head, `origin/${base}`).catch(() => true)) continue;
      const last = (await repo.log({ range: remote.head, max: 1 }))[0];
      if (!last) continue;
      found.push({ branch, title: last.subject, author: last.author.name, at: last.commitDate });
    }
    return found.sort((a, b) => b.at - a.at).map(({ branch, title, author }) => ({ branch, title, author }));
  }

  /**
   * [Move my commits to a new branch] (PLAN.md §3.11 step 8): the branch starts at the current commit (nothing in the
   * folder changes, so uncommitted changes stay), and the company branch goes back to the company's version.
   */
  async moveCommits(branch: string): Promise<void> {
    const { repo, sync, activity } = this.#deps;
    const name = branch.trim();
    if (!branchNameValid(name)) throw new AppError('sync.branchName', { name });
    if ((await this.#taken()).has(name)) throw new AppError('sync.branchExists', { name });
    const base = await this.companyBranch();
    const status = await repo.status();
    if (status.branch !== base) throw new AppError('review.notARequestBranch', { branch: status.branch ?? '' });
    const company = await repo.resolve(`refs/remotes/origin/${base}`);
    if (company === null) throw new AppError('sync.noUpstream');
    await sync.own(async () => {
      await repo.createBranch(name, 'HEAD');
      await repo.switchBranch(name);
      await repo.forceBranch(base, company);
    });
    activity.append([{ kind: 'branch-created', path: null, details: { branch: name, from: base, moved: true } }]);
    await sync.changed();
    this.#changed();
  }
}
