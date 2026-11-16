// The `hosts` world (TESTING.md §4, Step 4): fake GitHub, GitLab and plain git servers with set-up, empty and
// non-empty repos, a repo the user can't see, and one where the GitHub App isn't installed. The repos are built on disk
// with the world (synchronously, like every world); `startWorldHosts` then serves them, with the world's users,
// permissions and installations, over HTTPS with one test certificate authority for all three.
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestRoot } from '../harness/test-root.ts';
import { createAuthority } from '../hosts/certs.ts';
import { type FakeHost, startFakeHost } from '../hosts/fake-host.ts';
import type { HostFlavor } from '../hosts/fake-host-state.ts';
import { testGitSync } from '../hosts/test-git.ts';
import { ACME_LIBRARY_ID, ACME_REPO, acmeLibraryFiles } from './acme-world.ts';
import { GLOBEX_LIBRARY_ID, GLOBEX_REPO, globexLibraryFiles } from './companies-world.ts';
import { AYSE, JOHN, JOHN_LOGIN } from './git-worlds.ts';
import { LABS_LIBRARY_ID, LABS_REPO, labsLibraryFiles, type WorldFile } from './prefix-world.ts';
import { largeLibraryFiles, placementLibraryFiles, REPOS_LIBRARY_ID, REPOS_LIBRARY_REPO } from './repos-world.ts';

/** The `large` world's library (TESTING.md §4), built only for that world. */
export const LARGE_LIBRARY_REPO = 'acme/large-library';
export const LARGE_LIBRARY_ID = `lib_${'cd'.repeat(16)}`;

export const DENIZ = { name: 'Deniz Kaya', email: 'deniz@acme.test' };

/** Library ids of the set-up repos: one library per host, and the GitHub mirror shares the GitHub library's id. */
export const HOSTS_LIBRARY_IDS = {
  github: `lib_${'a1'.repeat(16)}`,
  gitlab: `lib_${'b2'.repeat(16)}`,
  plain: `lib_${'c3'.repeat(16)}`,
  globex: `lib_${'d4'.repeat(16)}`,
} as const;

type RepoContent =
  | 'library'
  | 'empty'
  | 'readme'
  | 'other'
  | 'notSetUp'
  | 'newerFormat'
  | 'newerApp'
  | 'acme'
  | 'placement'
  | 'large'
  | 'globex'
  | 'labs';

export interface WorldRepo {
  readonly flavor: HostFlavor;
  readonly name: string;
  readonly content: RepoContent;
  readonly libraryId?: string;
}

export const hostsWorldRepos: readonly WorldRepo[] = [
  { flavor: 'github', name: 'acme/agent-library', content: 'library', libraryId: HOSTS_LIBRARY_IDS.github },
  { flavor: 'github', name: 'acme/agent-library-mirror', content: 'library', libraryId: HOSTS_LIBRARY_IDS.github },
  { flavor: 'github', name: 'acme/empty-library', content: 'empty' },
  { flavor: 'github', name: 'acme/readme-only', content: 'readme' },
  { flavor: 'github', name: 'acme/old-skills', content: 'other' },
  { flavor: 'github', name: 'acme/not-set-up', content: 'notSetUp' },
  { flavor: 'github', name: 'acme/newer-format', content: 'newerFormat', libraryId: `lib_${'e5'.repeat(16)}` },
  { flavor: 'github', name: 'acme/newer-app', content: 'newerApp', libraryId: `lib_${'f6'.repeat(16)}` },
  { flavor: 'github', name: 'acme/secret', content: 'library', libraryId: `lib_${'07'.repeat(16)}` },
  { flavor: 'github', name: 'globex/agent-library', content: 'library', libraryId: HOSTS_LIBRARY_IDS.globex },
  { flavor: 'gitlab', name: 'acme/agent-library', content: 'library', libraryId: HOSTS_LIBRARY_IDS.gitlab },
  { flavor: 'gitlab', name: 'acme/empty-library', content: 'empty' },
  { flavor: 'plain', name: 'acme/agent-library', content: 'library', libraryId: HOSTS_LIBRARY_IDS.plain },
  { flavor: 'plain', name: 'acme/empty-library', content: 'empty' },
  // Step 5's Acme library with 10 skills (the `acme-basic` world).
  { flavor: 'plain', name: ACME_REPO, content: 'acme', libraryId: ACME_LIBRARY_ID },
  // Step 6's library of PLAN.md §3.6's example (the `repos-and-tags` world).
  { flavor: 'plain', name: REPOS_LIBRARY_REPO, content: 'placement', libraryId: REPOS_LIBRARY_ID },
  // Step 7's second company (the `two-companies` world).
  { flavor: 'plain', name: GLOBEX_REPO, content: 'globex', libraryId: GLOBEX_LIBRARY_ID },
  // Step 8's second library with the prefix acme (the `same-prefix` world).
  { flavor: 'plain', name: LABS_REPO, content: 'labs', libraryId: LABS_LIBRARY_ID },
  // Step 6's 1,000 skills (the `large` world): built only for that world.
  { flavor: 'plain', name: LARGE_LIBRARY_REPO, content: 'large', libraryId: LARGE_LIBRARY_ID },
];

const SKILLS: Record<string, string> = {
  'skills/acme-code-review/SKILL.md':
    '---\nname: acme-code-review\ndescription: Reviews code the Acme way. Use it before every merge request.\n---\n\n# Code review\n\nBe kind and specific.\n',
  'skills/acme-release-notes/SKILL.md':
    '---\nname: acme-release-notes\ndescription: Writes release notes from merged changes. Use it when a release is cut.\n---\n\n# Release notes\n\nMention breaking changes first.\n',
  'instructions/AGENTS.md': '# Acme\n\nWe write tests first.\n',
  '.gitattributes': '* text=auto eol=lf\n*.bat text eol=crlf\n*.cmd text eol=crlf\n',
  '.gitignore': 'node_modules/\n__pycache__/\n.venv/\n.DS_Store\nThumbs.db\n',
};

export function contentOf(repo: WorldRepo): Record<string, WorldFile> {
  const yaml = (extra = '') => `id: ${repo.libraryId ?? ''}\nprefix: acme\nformat: 1\n${extra}`;
  switch (repo.content) {
    case 'library':
      return { 'library.yaml': yaml(), ...SKILLS };
    case 'empty':
      return {};
    case 'readme':
      return { 'README.md': '# Agent library\n', LICENSE: 'MIT License\n', '.gitignore': '*.log\n' };
    case 'other':
      return {
        'README.md': '# Old skills\n',
        'code-review/SKILL.md': SKILLS['skills/acme-code-review/SKILL.md'] ?? '',
      };
    case 'notSetUp':
      return { 'library.yaml': `id: lib_${'08'.repeat(16)}\nformat: 1\n`, ...SKILLS };
    case 'newerFormat':
      return { 'library.yaml': `id: ${repo.libraryId ?? ''}\nprefix: acme\nformat: 2\n`, ...SKILLS };
    case 'newerApp':
      return { 'library.yaml': yaml('minAppVersion: "99.0.0"\n'), ...SKILLS };
    case 'acme':
      return acmeLibraryFiles();
    case 'placement':
      return placementLibraryFiles();
    case 'large':
      return largeLibraryFiles();
    case 'globex':
      return globexLibraryFiles();
    case 'labs':
      return labsLibraryFiles();
  }
}

/** Where a host's bare repos live in the test root. */
export function hostRoot(root: TestRoot, flavor: HostFlavor): string {
  return path.join(root.remotes, flavor);
}

/** Builds every repo of the world as a bare repo, with one commit by Ayşe on a fixed date. */
export function buildHostRepos(root: TestRoot, options: { large?: boolean } = {}): void {
  for (const repo of hostsWorldRepos) {
    if (repo.content === 'large' && !options.large) continue;
    buildBareRepo(root, repo);
  }
}

/** One repo of a world as a bare repo on its host, with one commit by Ayşe on a fixed date; `files` replace its content. */
export function buildBareRepo(root: TestRoot, repo: WorldRepo, content?: Readonly<Record<string, WorldFile>>): void {
  const home = root.at('world-builder');
  const date = '2026-01-10T10:00:00Z';
  const git = (args: readonly string[], cwd: string) =>
    testGitSync(args, cwd, {
      home,
      author: AYSE,
      env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, LC_ALL: 'C' },
    });
  {
    const bare = path.join(hostRoot(root, repo.flavor), `${repo.name}.git`);
    mkdirSync(path.dirname(bare), { recursive: true });
    git(['init', '--bare', '--initial-branch=main', bare], root.path);
    const files = content ?? contentOf(repo);
    if (Object.keys(files).length === 0) return;
    const work = root.at('world-builder', 'work', repo.flavor, repo.name);
    git(['init', '--initial-branch=main', work], root.path);
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(work, ...name.split('/'));
      mkdirSync(path.dirname(file), { recursive: true });
      // A link inside a skill is committed as a link (git stores its target).
      if (typeof content === 'string') writeFileSync(file, content);
      else symlinkSync(content.link, file);
    }
    git(['add', '-A'], work);
    git(
      [
        'commit',
        '-m',
        repo.content === 'library' || repo.content === 'acme' || repo.content === 'globex' || repo.content === 'labs'
          ? 'Set up the library'
          : 'First commit',
      ],
      work,
    );
    git(['push', bare, 'main'], work);
    rmSync(work, { recursive: true, force: true });
  }
}

/** The names the world's hosts serve as, like self-hosted servers: stable in every run and in every screenshot. */
export const HOST_NAMES = {
  github: 'github.acme.example',
  gitlab: 'gitlab.acme.example',
  plain: 'git.acme.example',
} as const;

/** The names of the real GitHub, for a world whose fake GitHub serves as the real service (`githubDotCom`). */
export const GITHUB_DOT_COM = 'github.com';
export const GITHUB_API_NAME = 'api.github.com';

export interface WorldHosts {
  readonly github: FakeHost;
  readonly gitlab: FakeHost;
  readonly plain: FakeHost;
  /** The one certificate authority all three use: what the app trusts through its extra certificates. */
  readonly caPem: string;
  /** Each name and where it really listens, for the recording proxy (`RecordingProxy.alias`). */
  readonly routes: ReadonlyArray<{ readonly name: string; readonly target: string }>;
  readonly clientIds: { readonly github: string; readonly gitlab: string };
  /** Tokens for the plain server: a read-only deploy token, and John's token that may write. */
  readonly tokens: { readonly plainRead: string; readonly plainWrite: string };
  url(flavor: HostFlavor, repo: string): string;
  /** The repo at the host's real address, for git a test runs itself without the proxy. */
  directUrl(flavor: HostFlavor, repo: string): string;
  close(): Promise<void>;
}

/** Serves the world's repos: who may do what is described here, as data (TESTING.md §4). */
export async function startWorldHosts(
  root: TestRoot,
  options: { now?: () => number; githubDotCom?: boolean } = {},
): Promise<WorldHosts> {
  const authority = createAuthority('Hosts world certificate authority');
  // With `githubDotCom` the fake GitHub is github.com and api.github.com: the app takes it for the real service.
  const asRealGithub = (flavor: HostFlavor) => flavor === 'github' && options.githubDotCom === true;
  const start = (flavor: HostFlavor) =>
    startFakeHost({
      root: hostRoot(root, flavor),
      flavor,
      authority,
      hostname: asRealGithub(flavor) ? GITHUB_DOT_COM : HOST_NAMES[flavor],
      ...(asRealGithub(flavor) ? { apiHostname: GITHUB_API_NAME } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  const [github, gitlab, plain] = await Promise.all([start('github'), start('gitlab'), start('plain')]);
  for (const repo of hostsWorldRepos) {
    if (!existsSync(path.join(hostRoot(root, repo.flavor), `${repo.name}.git`))) continue;
    ({ github, gitlab, plain })[repo.flavor].adoptRepo(repo.name);
  }

  // GitHub: John writes to the library, whose main needs a review (a Member); Ayşe is an admin. The app is installed
  // on acme's repos, not on globex's.
  const gh = github.state;
  gh.addUser(JOHN_LOGIN, JOHN.name, JOHN.email);
  gh.addUser('ayse', AYSE.name, AYSE.email);
  for (const repo of hostsWorldRepos.filter((r) => r.flavor === 'github')) {
    if (repo.name === 'acme/secret') gh.setPermission(repo.name, 'ayse', 'admin');
    else if (repo.name.startsWith('acme/agent-library')) {
      gh.setPermission(repo.name, JOHN_LOGIN, 'write');
      gh.setPermission(repo.name, 'ayse', 'admin');
      github.protectBranch(repo.name, 'main', 'github-rules');
    } else gh.setPermission(repo.name, JOHN_LOGIN, 'admin');
  }
  gh.installApp('acme');

  // GitLab: Deniz is a Guest whose custom role can view code (a Viewer); John a Developer with main protected.
  const gl = gitlab.state;
  gl.addUser(JOHN_LOGIN, JOHN.name, JOHN.email);
  gl.addUser('deniz', DENIZ.name, DENIZ.email);
  gl.setPermission('acme/agent-library', 'deniz', 10, { readCode: true });
  gl.setPermission('acme/agent-library', JOHN_LOGIN, 30);
  gitlab.protectBranch('acme/agent-library', 'main', 'gitlab');
  gl.setPermission('acme/empty-library', JOHN_LOGIN, 40);

  // Plain: no API; a read-only deploy token, and John's token that may write.
  const pl = plain.state;
  pl.addUser(JOHN_LOGIN, JOHN.name, JOHN.email);
  pl.setPermission('acme/agent-library', JOHN_LOGIN, 'write');
  pl.setPermission('acme/empty-library', JOHN_LOGIN, 'write');
  pl.setPermission(ACME_REPO, JOHN_LOGIN, 'write');
  pl.setPermission(REPOS_LIBRARY_REPO, JOHN_LOGIN, 'write');
  pl.setPermission(LARGE_LIBRARY_REPO, JOHN_LOGIN, 'write');
  pl.setPermission(GLOBEX_REPO, JOHN_LOGIN, 'write');
  pl.setPermission(LABS_REPO, JOHN_LOGIN, 'write');
  const plainRead = pl.deployToken('acme/agent-library', false).token;
  const plainWrite = pl.issueToken(JOHN_LOGIN, { lifetimeSeconds: null }).token;

  const hosts = { github, gitlab, plain };
  return {
    github,
    gitlab,
    plain,
    caPem: authority.certPem,
    routes: [github, gitlab, plain].flatMap((host) => [
      { name: `${host.host}:443`, target: host.hostPort },
      ...(host.apiHost ? [{ name: `${host.apiHost}:443`, target: host.hostPort }] : []),
    ]),
    clientIds: { github: gh.registerApp(), gitlab: gl.registerApp() },
    tokens: { plainRead, plainWrite },
    url: (flavor, repo) => hosts[flavor].repoUrl(repo),
    directUrl: (flavor, repo) => `${hosts[flavor].directUrl}/${repo}.git`,
    close: async () => {
      await Promise.all([github.close(), gitlab.close(), plain.close()]);
    },
  };
}
