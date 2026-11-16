// The `roles` world (TESTING.md §4, Step 12): one library seen as Viewer, Member, Maintainer and Admin on GitHub-,
// GitLab- and plain-style hosts, and a GitHub library whose main is protected the classic way (its rules only admins
// can read). The people, as PLAN.md §3.11's table maps them:
// - Vera reads (GitHub Read, GitLab Reporter, a read-only token on the plain server): a Viewer.
// - John writes, but main needs a review (GitHub Write with a ruleset, GitLab Developer with main protected): a Member.
// - Mert writes and may push to main (GitHub Write as the ruleset's bypass actor, GitLab Maintainer): a Maintainer.
// - Ayşe administers (GitHub Admin, GitLab Owner): an Admin.
import type { RoleName } from '@app/schemas';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestRoot } from '../harness/test-root.ts';
import type { HostFlavor } from '../hosts/fake-host-state.ts';
import { testGit } from '../hosts/test-git.ts';
import { AYSE, JOHN, JOHN_LOGIN } from './git-worlds.ts';
import { buildBareRepo, type WorldHosts } from './hosts-world.ts';

export const VERA = { name: 'Vera Koç', email: 'vera@acme.test' };
export const MERT = { name: 'Mert Arslan', email: 'mert@acme.test' };

/** The library every role sees: the `hosts` world's `acme/agent-library` on each host. */
export const ROLES_REPO = 'acme/agent-library';
/** A GitHub library whose main is protected the classic way: John writes there (A12.9). */
export const CLASSIC_REPO = 'acme/classic-library';
export const CLASSIC_LIBRARY_ID = `lib_${'c1'.repeat(16)}`;

/** Who has each role, by login. */
export const ROLE_LOGINS: Readonly<Record<RoleName, string>> = {
  viewer: 'vera',
  member: JOHN_LOGIN,
  maintainer: 'mert',
  admin: 'ayse',
};

export const ROLE_PEOPLE: Readonly<Record<string, { name: string; email: string }>> = {
  vera: VERA,
  john: JOHN,
  mert: MERT,
  ayse: AYSE,
};

/** The classic-protection library, built with the world. */
export function buildRolesRepos(root: TestRoot): void {
  buildBareRepo(root, { flavor: 'github', name: CLASSIC_REPO, content: 'library', libraryId: CLASSIC_LIBRARY_ID });
}

/** The people and what each host lets them do (PLAN.md §3.11 "How roles map to the host"). */
export function setUpRoles(hosts: WorldHosts): void {
  const gh = hosts.github.state;
  for (const [login, person] of Object.entries(ROLE_PEOPLE)) {
    for (const state of [gh, hosts.gitlab.state, hosts.plain.state]) {
      if (!state.users.has(login)) state.addUser(login, person.name, person.email);
    }
  }
  gh.setPermission(ROLES_REPO, 'vera', 'read');
  gh.setPermission(ROLES_REPO, JOHN_LOGIN, 'write');
  gh.setPermission(ROLES_REPO, 'mert', 'write');
  gh.setPermission(ROLES_REPO, 'ayse', 'admin');
  hosts.github.protectBranch(ROLES_REPO, 'main', 'github-rules', ['mert']);
  hosts.github.adoptRepo(CLASSIC_REPO);
  gh.setPermission(CLASSIC_REPO, JOHN_LOGIN, 'write');
  gh.setPermission(CLASSIC_REPO, 'ayse', 'admin');
  hosts.github.protectBranch(CLASSIC_REPO, 'main', 'github');

  const gl = hosts.gitlab.state;
  gl.setPermission(ROLES_REPO, 'vera', 20);
  gl.setPermission(ROLES_REPO, JOHN_LOGIN, 30);
  gl.setPermission(ROLES_REPO, 'mert', 40);
  gl.setPermission(ROLES_REPO, 'ayse', 50);

  const pl = hosts.plain.state;
  pl.setPermission(ROLES_REPO, 'vera', 'read');
  pl.setPermission(ROLES_REPO, 'mert', 'write');
  pl.setPermission(ROLES_REPO, 'ayse', 'write');
}

/**
 * Gives `login` a role on a host's library, as an admin would there: on GitHub a permission (and the ruleset's
 * bypass list for a Maintainer), on GitLab an access level, on the plain server read or write.
 */
export function giveRole(
  hosts: WorldHosts,
  flavor: HostFlavor,
  login: string,
  role: RoleName,
  repo = ROLES_REPO,
): void {
  if (flavor === 'github') {
    const permission = role === 'viewer' ? 'read' : role === 'admin' ? 'admin' : 'write';
    hosts.github.state.setPermission(repo, login, permission);
    const bypass = [...(hosts.github.state.protections.get(repo)?.get('main')?.bypass ?? [])].filter(
      (l) => l !== login,
    );
    hosts.github.protectBranch(repo, 'main', 'github-rules', role === 'maintainer' ? [...bypass, login] : bypass);
  } else if (flavor === 'gitlab') {
    hosts.gitlab.state.setPermission(repo, login, { viewer: 20, member: 30, maintainer: 40, admin: 50 }[role]);
    hosts.gitlab.protectBranch(repo, 'main', 'gitlab');
  } else {
    hosts.plain.state.setPermission(repo, login, role === 'viewer' ? 'read' : 'write');
  }
}

/** A token of `login` on a host that doesn't expire: what a person types in at sign-in (PLAN.md §3.17). */
export function personalToken(hosts: WorldHosts, flavor: HostFlavor, login: string): string {
  return hosts[flavor].state.issueToken(login, { lifetimeSeconds: null }).token;
}

/**
 * Another person's push to the host, as their own git would make it: a clone of the bare repo, the files changed on the
 * branch (a new one starts at main), one commit, and the push, which the server's hook checks as for that person.
 */
export async function pushBranchAs(
  root: TestRoot,
  hosts: WorldHosts,
  flavor: HostFlavor,
  login: string,
  branch: string,
  files: Readonly<Record<string, string>>,
  message: string,
  repo = ROLES_REPO,
): Promise<void> {
  const who = ROLE_PEOPLE[login] ?? { name: login, email: `${login}@acme.test` };
  const dir = root.at('people', login, `${branch.replaceAll('/', '-')}-${Date.now()}`);
  const home = root.at('people', login, 'git-home');
  // The server's hook knows who pushes by REMOTE_USER, as git http-backend tells it.
  const git = async (args: readonly string[], cwd: string) => {
    const result = await testGit(args, cwd, { home, author: who, env: { REMOTE_USER: login } });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };
  await git(['clone', '--quiet', hosts[flavor].repoPath(repo), dir], root.path);
  await git(['switch', '--quiet', '-C', branch], dir);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  await git(['add', '-A'], dir);
  await git(['commit', '--quiet', '-m', message], dir);
  await git(['push', '--quiet', 'origin', branch], dir);
}
