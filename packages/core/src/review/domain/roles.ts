// Roles (PLAN.md §3.11): the host decides, the app mirrors it. A role is a pure function of what the host says about
// the signed-in user and the company branch (IMPLEMENTATION.md §2.9). The adapters only collect these facts.

import type { HostFacts } from '../../ports/host.ts';

export type Role = 'viewer' | 'member' | 'maintainer' | 'admin';

export const roles: readonly Role[] = ['viewer', 'member', 'maintainer', 'admin'];

export const GITLAB_GUEST = 10;
export const GITLAB_REPORTER = 20;
export const GITLAB_DEVELOPER = 30;
export const GITLAB_MAINTAINER = 40;
export const GITLAB_OWNER = 50;

/**
 * The app's role for these facts, or null when the user can't read the library. Member exists only where the host can
 * make a writer go through review; elsewhere writers push directly (PLAN.md §3.11 "Hosts without protection").
 */
export function roleFrom(facts: HostFacts): Role | null {
  switch (facts.kind) {
    case 'github': {
      const { permissions, branch } = facts;
      if (permissions.admin) return 'admin';
      if (permissions.maintain || permissions.push) {
        return branch.reviewRequired && !branch.canBypass ? 'member' : 'maintainer';
      }
      return permissions.pull ? 'viewer' : null;
    }
    case 'gitlab': {
      const level = facts.accessLevel;
      if (level >= GITLAB_OWNER) return 'admin';
      if (level >= GITLAB_MAINTAINER) return 'maintainer';
      if (level >= GITLAB_DEVELOPER) return facts.canPushDefault ? 'maintainer' : 'member';
      if (level >= GITLAB_REPORTER) return 'viewer';
      // A Guest reads code only through a custom role that allows it; it uses no paid seat (PLAN.md §3.11).
      return level >= GITLAB_GUEST && facts.readCode ? 'viewer' : null;
    }
    case 'plain':
      // A plain server has no review step and no separate admin level: writers push directly (A4.3). They also get
      // the prefix change (PLAN.md §3.11), which Step 14 asks about through `adminActions`.
      return facts.canWrite ? 'maintainer' : 'viewer';
  }
}

/** Whether the role may run Admin actions (the prefix change) on this host. Plain servers give them to writers. */
export function adminActions(role: Role | null, host: HostFacts['kind']): boolean {
  if (role === 'admin') return true;
  return host === 'plain' && role === 'maintainer';
}

/** Whether the role may push at all (a branch for a change request, or the company branch). */
export function canPush(role: Role | null): boolean {
  return role === 'member' || role === 'maintainer' || role === 'admin';
}

/** What a role may do on a host (PLAN.md §3.11 "Roles"): the UI shows only these actions. */
export interface RoleActions {
  /** The company branch: pushed directly, through a change request, or not at all (Viewers: "Local only"). */
  readonly companyBranch: 'push' | 'request' | 'none';
  /** Push a branch and open a change request on the host's website (ADR 0032). */
  readonly requests: boolean;
  /** Admin actions: the prefix change (Step 14). */
  readonly admin: boolean;
}

export function actionsFor(role: Role | null, host: HostFacts['kind']): RoleActions {
  const writer = canPush(role);
  return {
    companyBranch: role === 'maintainer' || role === 'admin' ? 'push' : role === 'member' ? 'request' : 'none',
    requests: writer,
    admin: adminActions(role, host),
  };
}

/**
 * The role, with what a rejected push taught (PLAN.md §3.11): on a GitHub branch protected the classic way the rules
 * can't be read, so a Write user counts as a Maintainer until the host refuses a direct push, and as a Member from
 * then on. The lesson stays while the branch is protected that way.
 */
export function roleWithRefusal(role: Role | null, facts: HostFacts, directPushRefused: boolean): Role | null {
  if (!directPushRefused || role !== 'maintainer') return role;
  return classicProtection(facts) ? 'member' : role;
}

/** GitHub only: the company branch is protected, but no readable rule says how (classic branch protection). */
export function classicProtection(facts: HostFacts): boolean {
  return facts.kind === 'github' && facts.branch.protected && !facts.branch.reviewRequired;
}
