// Worlds (TESTING.md §4): named fixtures, described as data and built into a test root. Every level uses the same
// worlds. Later steps add the remote library, code repos, hosts and the app state to start from.
import { brand } from '@app/brand';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestRoot } from '../harness/test-root.ts';
import { ACME_REPO, CANARY_TAKEN_NAME, plantTakenNames, replaceLinks } from './acme-world.ts';
import { CANARY_INSTRUCTIONS, GLOBEX_REPO, INSTRUCTION_TOOLS, plantInstructionFiles } from './companies-world.ts';
import { buildGitLibraries, JOHN, JOHN_LOGIN, writeMessyGitconfig } from './git-worlds.ts';
import type { TestApiClient } from './test-api-client.ts';
import { buildHostRepos, LARGE_LIBRARY_REPO, type WorldHosts } from './hosts-world.ts';
import {
  appToken,
  buildImportSources,
  CANARY_CODE,
  CANARY_CREDENTIALS,
  IMPORT_LIBRARY_REPO,
  setUpImportHosts,
} from './import-world.ts';
import { buildCodeRepos, buildLargeRepos, CANARY_SOURCE, REPOS_LIBRARY_REPO } from './repos-world.ts';
import { invalidLibrary, validLibrary, writeFixtureLibrary } from './libraries.ts';
import { buildPrefixRepos, CANARY_NEWCO, PREFIX_REPO, setUpPrefixHosts } from './prefix-change-world.ts';
import { buildRolesRepos, personalToken, ROLES_REPO, setUpRoles } from './roles-world.ts';
import { makeConflicts, pushIncomingChanges, seedConflictFiles } from './sync-world.ts';

export interface World {
  readonly name: string;
  readonly description: string;
  /** Unique strings planted in the user's own files: they must never show up where they shouldn't (TESTING.md §9.4). */
  readonly canaries: readonly string[];
  /** The world's fake hosts must run while the app does (`startWorldHosts`). */
  readonly hosts?: boolean;
  /** The fake GitHub serves as github.com and api.github.com, as the real service, not as a self-hosted server. */
  readonly githubDotCom?: boolean;
  /** What the world adds to its hosts (people, permissions), each time they start. */
  setUpHosts?(hosts: WorldHosts): void;
  /** Variables for the app, made from the started hosts: e.g. the client id that the app carries for github.com. */
  appEnv?(hosts: WorldHosts): Readonly<Record<string, string>>;
  build(root: TestRoot): void;
  /**
   * The app state to start from, made in the running app through its own use cases (TESTING.md §4): e.g. a library
   * joined and tools enabled. Runs once, after the first start in a fresh test root.
   */
  prepare?(app: WorldApp): Promise<void>;
}

/** What a world's `prepare` works with. */
export interface WorldApp {
  readonly root: TestRoot;
  readonly test: TestApiClient;
  readonly hosts: WorldHosts | undefined;
}

function worldHosts(app: WorldApp): WorldHosts {
  if (!app.hosts) throw new Error('this world needs its hosts');
  return app.hosts;
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export const CANARY_PRIVATE_SKILL = 'canary-7d1e9b private note that must never be read';

/** `empty`: a device with Claude Code and Codex folders, no instance (TESTING.md §4). */
export const emptyWorld: World = {
  name: 'empty',
  description: 'A device with Claude Code and Codex folders, no instance',
  canaries: [CANARY_PRIVATE_SKILL],
  build(root) {
    // The user's own skill in Claude Code's folder: never touched, never opened (PLAN.md §3.0).
    write(
      path.join(root.home, '.claude', 'skills', 'my-private-notes', 'SKILL.md'),
      `---\nname: my-private-notes\ndescription: My own notes.\n---\n${CANARY_PRIVATE_SKILL}\n`,
    );
    write(path.join(root.home, '.codex', 'config.toml'), '# the user own Codex settings\n');
    mkdirSync(path.join(root.home, '.agents', 'skills'), { recursive: true });
    // A folder the tests can pick as a test library (Step 1's thin slice).
    mkdirSync(path.join(root.home, 'libraries', 'acme'), { recursive: true });
    mkdirSync(path.join(root.home, 'libraries', 'globex'), { recursive: true });
    write(path.join(root.home, 'libraries', 'acme', 'README.md'), '# Acme test library\n');
  },
};

/**
 * `fixture-libraries` (Step 2): `empty`, plus two library folders built from the fixture corpus, to add as test
 * libraries: home/libraries/acme-valid, without a single issue, and home/libraries/acme-invalid, where every validation
 * rule fires.
 */
export const fixtureLibrariesWorld: World = {
  name: 'fixture-libraries',
  description: 'The empty world, plus a valid and an invalid library folder built from the fixture corpus',
  canaries: emptyWorld.canaries,
  build(root) {
    emptyWorld.build(root);
    writeFixtureLibrary(validLibrary, path.join(root.home, 'libraries', 'acme-valid'));
    writeFixtureLibrary(invalidLibrary, path.join(root.home, 'libraries', 'acme-invalid'));
  },
};

/**
 * `messy-gitconfig` (Step 3): `empty`, with a global git config full of personal settings that change git's output or
 * behaviour (TESTING.md §4), and two library clones of a remote with history: home/libraries/acme-git (a commit to
 * push, one incoming, local changes) and home/libraries/acme-conflict (a merge stopped on conflicts).
 */
export const messyGitconfigWorld: World = {
  name: 'messy-gitconfig',
  description: 'A device whose global git config is full of personal settings, and library clones with history',
  canaries: emptyWorld.canaries,
  build(root) {
    emptyWorld.build(root);
    writeMessyGitconfig(root);
    buildGitLibraries(root);
  },
};

/**
 * `hosts` (Step 4): `empty`, plus fake GitHub, GitLab and plain git servers with set-up, empty and non-empty repos, a
 * repo the user can't see, and one without the GitHub App installed. Their repos are built with the world; the hosts
 * run while the test does (`startWorldHosts`).
 */
export const hostsWorld: World = {
  name: 'hosts',
  description: 'Fake GitHub, GitLab and plain servers with set-up, empty and non-empty repos',
  canaries: emptyWorld.canaries,
  hosts: true,
  build(root) {
    emptyWorld.build(root);
    buildHostRepos(root);
  },
};

/**
 * `github-com`: `hosts`, with the fake GitHub as github.com, and the app carrying its own client id for it, as the
 * released app does. A person signs in without a client id, as on the real github.com (the video of the normal sign-in).
 */
export const githubComWorld: World = {
  ...hostsWorld,
  name: 'github-com',
  description: 'The hosts world, with the fake GitHub as github.com and its client id built into the app',
  githubDotCom: true,
  appEnv: (hosts) => ({ APP_TEST_CLIENT_ID_GITHUB: hosts.clientIds.github }),
};

/** Joins the Acme library as John, with a token on the plain server, and enables Claude Code and Codex. */
async function joinAcme(
  app: WorldApp,
  repo: string = ACME_REPO,
  tools: readonly string[] = ['claude-code', 'codex'],
): Promise<string> {
  const hosts = worldHosts(app);
  const { instanceId } = await app.test.command('joinLibrary', {
    url: hosts.url('plain', repo),
    token: hosts.tokens.plainWrite,
    identity: JOHN,
  });
  await app.test.command('enableTools', { instance: instanceId, tools: [...tools] });
  await app.test.command('waitForIdle', {});
  return instanceId;
}

/** `acme-basic` (Step 5): the Acme library with 10 skills, joined, Claude Code and Codex enabled (TESTING.md §4). */
export const acmeBasicWorld: World = {
  name: 'acme-basic',
  description: 'The Acme library with 10 skills, joined, Claude Code and Codex enabled',
  canaries: emptyWorld.canaries,
  hosts: true,
  build(root) {
    hostsWorld.build(root);
  },
  async prepare(app) {
    await joinAcme(app);
  },
};

/**
 * `taken-names` (Step 5): `acme-basic`, plus the user's own folders on company skill paths (S2), a real folder replacing
 * a link (S4) and a foreign link (S5).
 */
export const takenNamesWorld: World = {
  name: 'taken-names',
  description: "acme-basic, plus the user's own folders on company skill paths, a real folder and a foreign link",
  canaries: [...emptyWorld.canaries, CANARY_TAKEN_NAME],
  hosts: true,
  build(root) {
    hostsWorld.build(root);
  },
  async prepare(app) {
    // The user's own folders appear after the setup: before it, a folder that starts with acme- asks for a local
    // prefix (PLAN.md §3.3, Step 8). They are there before the tools are enabled, so their names are taken (S2).
    await joinAcme(app, ACME_REPO, []);
    plantTakenNames(app.root);
    await app.test.command('enableTools', { instance: 'Acme', tools: ['claude-code', 'codex'] });
    await app.test.command('waitForIdle', {});
    // After the app linked everything: another program replaces some links (PLAN.md §3.8 S4, S5).
    replaceLinks(app.root);
    await app.test.command('windowFocus', {});
    await app.test.command('waitForIdle', {});
  },
};

/**
 * `repos-and-tags` (Step 6): the library of PLAN.md §3.6's example (tagged skills, suggestions, a repo-only tag),
 * joined with Claude Code and Codex enabled, and 3 code repos (backend-api, backend-billing, web-app) in `home/work`,
 * with a worktree of backend-api outside it, and a nested repo (TESTING.md §4). No repo is
 * added yet: each test adds what it needs, as the user would.
 */
export const reposAndTagsWorld: World = {
  name: 'repos-and-tags',
  description: '3 code repos with worktrees, a nested repo, tagged skills and repo-only tags',
  canaries: [...emptyWorld.canaries, CANARY_SOURCE],
  hosts: true,
  build(root) {
    hostsWorld.build(root);
    buildCodeRepos(root);
  },
  async prepare(app) {
    await joinAcme(app, REPOS_LIBRARY_REPO);
  },
};

/**
 * `two-companies` (Step 7): the Acme and Globex libraries, both joined with every instruction tool enabled, and the
 * instruction files of every supported tool with the user's own text (TESTING.md §4). Acme was joined first, so only
 * its instructions are linked (PLAN.md §3.12).
 */
export const twoCompaniesWorld: World = {
  name: 'two-companies',
  description: "The Acme and Globex libraries; instruction files of every supported tool with the user's own text",
  canaries: [...emptyWorld.canaries, CANARY_INSTRUCTIONS],
  hosts: true,
  build(root) {
    hostsWorld.build(root);
    plantInstructionFiles(root);
  },
  async prepare(app) {
    await joinAcme(app, ACME_REPO, INSTRUCTION_TOOLS);
    await joinAcme(app, GLOBEX_REPO, INSTRUCTION_TOOLS);
  },
};

/**
 * `same-prefix` (Step 8): two libraries that both use the prefix `acme` (TESTING.md §4). Acme's library is joined with
 * Claude Code and Codex enabled; Acme Labs' library waits on the plain server, and joining it asks for a local prefix
 * (PLAN.md §3.3). The tests join it, as the user would.
 */
export const samePrefixWorld: World = {
  name: 'same-prefix',
  description: 'Two libraries that both use the prefix acme',
  canaries: emptyWorld.canaries,
  hosts: true,
  build(root) {
    hostsWorld.build(root);
  },
  async prepare(app) {
    await joinAcme(app);
  },
};

/** Where the app downloads the Acme library in a world: the default folder (PLAN.md §3.17 step 3). */
export const acmeLibraryFolder = (root: TestRoot) => path.join(root.home, brand.defaultLibraryFolderName, 'acme');

/** After other people's pushes: the app fetches, as it does on focus (PLAN.md §3.10). */
async function fetchNow(app: WorldApp): Promise<void> {
  await app.test.command('windowFocus', {});
  await app.test.command('waitForIdle', {});
}

/**
 * `incoming-changes` (Step 11): `acme-basic`, and the remote is ahead with a new skill, a re-tag, a rename, a
 * deletion, a `scripts/` change and an `allowed-tools` change (TESTING.md §4). The app has fetched them.
 */
export const incomingChangesWorld: World = {
  name: 'incoming-changes',
  description: 'The remote is ahead: a new skill, a re-tag, a rename, a deletion, scripts/ and allowed-tools changes',
  canaries: emptyWorld.canaries,
  hosts: true,
  build(root) {
    hostsWorld.build(root);
  },
  async prepare(app) {
    await joinAcme(app);
    pushIncomingChanges(app.root);
    await fetchNow(app);
  },
};

/**
 * `conflict-ready` (Step 11): `acme-basic`, with John's unpushed commit and Ayşe's pushed one changing the same line,
 * the same binary file, and a file one side edited and the other deleted (TESTING.md §4). The app has fetched; a pull
 * stops on three conflicts.
 */
export const conflictReadyWorld: World = {
  name: 'conflict-ready',
  description: 'Local and remote edits on the same lines; a binary conflict; edit vs delete',
  canaries: emptyWorld.canaries,
  hosts: true,
  build(root) {
    hostsWorld.build(root);
    seedConflictFiles(root);
  },
  async prepare(app) {
    await joinAcme(app);
    makeConflicts(app.root, acmeLibraryFolder(app.root));
    await fetchNow(app);
  },
};

/**
 * `roles` (Step 12): the `hosts` world's library seen as Viewer, Member, Maintainer and Admin on the GitHub-, GitLab- and
 * plain-style hosts, and a GitHub library protected the classic way (TESTING.md §4, roles-world.ts). The GitHub
 * library is joined as John, a Member, with a token; tests change the role on the host, or join another library.
 */
export const rolesWorld: World = {
  name: 'roles',
  description: 'One library seen as Viewer, Member, Maintainer and Admin on GitHub-, GitLab- and plain-style hosts',
  canaries: emptyWorld.canaries,
  hosts: true,
  build(root) {
    hostsWorld.build(root);
    buildRolesRepos(root);
  },
  setUpHosts: setUpRoles,
  async prepare(app) {
    const hosts = worldHosts(app);
    const { instanceId } = await app.test.command('joinLibrary', {
      url: hosts.url('github', ROLES_REPO),
      token: personalToken(hosts, 'github', JOHN_LOGIN),
      identity: JOHN,
    });
    await app.test.command('enableTools', { instance: instanceId, tools: ['claude-code', 'codex'] });
    await app.test.command('waitForIdle', {});
  },
};

/**
 * `import-sources` (Step 13): old skills repos in every known layout on the fake GitHub, one where the GitHub App isn't
 * installed, with a local clone of it; the user's own skill with a link inside; good and malicious zips (TESTING.md
 * §4, import-world.ts). A GitHub library is joined as John, its admin, with the app's sign-in.
 */
export const importSourcesWorld: World = {
  name: 'import-sources',
  description: "Old skills repos in every layout, one the GitHub App isn't installed on; skills with links; zips",
  canaries: [...emptyWorld.canaries, CANARY_CODE, CANARY_CREDENTIALS],
  hosts: true,
  build(root) {
    hostsWorld.build(root);
    buildImportSources(root);
  },
  setUpHosts: setUpImportHosts,
  async prepare(app) {
    const hosts = worldHosts(app);
    const { instanceId } = await app.test.command('joinLibrary', {
      url: hosts.url('github', IMPORT_LIBRARY_REPO),
      token: appToken(hosts),
      identity: JOHN,
    });
    await app.test.command('enableTools', { instance: instanceId, tools: ['claude-code', 'codex'] });
    await app.test.command('waitForIdle', {});
  },
};

/**
 * `prefix-change` (Step 14): the Acme library seen from three devices (TESTING.md §4, prefix-change-world.ts): one
 * plain, one with a local prefix, one with an open request. The app runs as John's plain device, with the library
 * joined, Claude Code and Codex enabled; the scenarios start the other two. A second library on the server is set up
 * without a skill, so its prefix isn't locked yet.
 */
export const prefixChangeWorld: World = {
  name: 'prefix-change',
  description: 'Three devices: one plain, one with a local prefix, one with an open request',
  canaries: [...emptyWorld.canaries, CANARY_NEWCO],
  hosts: true,
  build(root) {
    hostsWorld.build(root);
    buildPrefixRepos(root);
  },
  setUpHosts: setUpPrefixHosts,
  async prepare(app) {
    await joinAcme(app, PREFIX_REPO);
  },
};

/** `large` (Step 6): 1,000 skills, 50 repos and 200 worktrees, for the performance measurements (TESTING.md §9.8). */
export const largeWorld: World = {
  name: 'large',
  description: '1,000 skills, 50 repos, 200 worktrees',
  canaries: emptyWorld.canaries,
  hosts: true,
  build(root) {
    emptyWorld.build(root);
    buildHostRepos(root, { large: true });
    buildLargeRepos(root);
  },
  async prepare(app) {
    await joinAcme(app, LARGE_LIBRARY_REPO);
  },
};

export const worlds = {
  empty: emptyWorld,
  'fixture-libraries': fixtureLibrariesWorld,
  'messy-gitconfig': messyGitconfigWorld,
  hosts: hostsWorld,
  'github-com': githubComWorld,
  'acme-basic': acmeBasicWorld,
  'taken-names': takenNamesWorld,
  'repos-and-tags': reposAndTagsWorld,
  'two-companies': twoCompaniesWorld,
  'same-prefix': samePrefixWorld,
  'incoming-changes': incomingChangesWorld,
  'conflict-ready': conflictReadyWorld,
  roles: rolesWorld,
  'import-sources': importSourcesWorld,
  'prefix-change': prefixChangeWorld,
  large: largeWorld,
} as const;
export type WorldName = keyof typeof worlds;

export function buildWorld(name: WorldName, root: TestRoot): World {
  const world = worlds[name];
  world.build(root);
  return world;
}

export * from './acme-world.ts';
export * from './companies-world.ts';
export * from './git-worlds.ts';
export * from './hosts-world.ts';
export * from './import-world.ts';
export * from './libraries.ts';
export * from './prefix-change-world.ts';
export * from './prefix-world.ts';
export * from './repos-world.ts';
export * from './roles-world.ts';
export * from './sync-world.ts';
