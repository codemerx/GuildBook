// What the host lets the signed-in user do with the library (PLAN.md §3.11, §3.17 step 2): the role from the host's
// facts, or PLAN.md's message when the user can't reach the repo. Without an API (a plain server, or a key instead of
// an account) only a dry-run push says whether writing is allowed, so a read-only key makes a Viewer.
import type { GitRepo } from '../../ports/git.ts';
import type { Host, HostAccount, RepoAccess } from '../../ports/host.ts';
import type { Random } from '../../ports/random.ts';
import { type Role, roleFrom } from '../../review/index.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import { randomToken } from '../../shared/ids.ts';

export interface HostAccess {
  readonly role: Role;
  readonly defaultBranch: string | null;
  readonly sizeBytes: number | null;
}

/** The role on `repoPath`, or the error PLAN.md §3.17 step 2 names for why the user can't have one. */
export function accessFrom(access: RepoAccess, repoPath: string): HostAccess {
  const [owner = repoPath, name = repoPath] = repoPath.split('/');
  switch (access.kind) {
    case 'unauthorized':
      throw new AppError('host.unauthorized');
    case 'notFound':
      throw new AppError('host.noAccess', { repo: repoPath });
    case 'appNotInstalled':
      throw new AppError('host.appNotInstalled', { owner, name: repoPath.split('/').at(-1) ?? name });
    case 'ok': {
      const role = roleFrom(access.facts);
      if (role === null) throw new AppError('host.noAccess', { repo: repoPath });
      return { role, defaultBranch: access.defaultBranch, sizeBytes: access.sizeBytes };
    }
  }
}

export async function hostAccess(host: Host, token: string, repoPath: string, signal?: AbortSignal) {
  const options = signal ? { signal } : {};
  const [account, access] = await Promise.all([
    host.account(token, options),
    host.repoAccess(token, repoPath, options),
  ]);
  return { account, ...accessFrom(access, repoPath) } satisfies HostAccess & { account: HostAccount };
}

/** The branch a dry-run push goes to: new, so it's never "up to date", and nothing is sent (PLAN.md §3.11). */
export function accessCheckBranch(random: Random): string {
  return `access-check-${randomToken(random, 8)}`;
}

/**
 * A key's role from a dry-run push of the current branch to a new branch name. The server checks write access before
 * anything is sent (as GitHub and GitLab do for deploy keys and tokens); a server that doesn't check up front counts
 * the user as a writer until a real push is rejected (PLAN.md §3.11).
 */
export async function keyRole(repo: GitRepo, branch: string, random: Random, signal?: AbortSignal): Promise<Role> {
  try {
    // A dry run runs no server hooks, so a new branch is never rejected: any answer means writing is allowed.
    await repo.push({ branch, remoteBranch: accessCheckBranch(random), dryRun: true }, signal ? { signal } : {});
    return 'maintainer';
  } catch (error) {
    if (isAppError(error) && (error.code === 'git.forbidden' || error.code === 'git.authFailed')) return 'viewer';
    throw error;
  }
}
