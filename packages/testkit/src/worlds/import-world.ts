// The `import-sources` world (TESTING.md §4, Step 13): old skills repos in every known layout of PLAN.md §3.18 on the
// fake GitHub, one of them where the GitHub App isn't installed; a local clone of that one; the user's own skill in
// Claude Code's folder with a link inside it; and good and malicious zips in Downloads. The library is a GitHub library
// joined with the app's sign-in, so the sign-in reaches only repos the app is installed on (PLAN.md §3.17).
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestRoot } from '../harness/test-root.ts';
import { testGitSync } from '../hosts/test-git.ts';
import { zipBytes, type ZipItem } from '../zip.ts';
import { AYSE, JOHN_LOGIN } from './git-worlds.ts';
import { buildBareRepo, hostRoot, type WorldHosts } from './hosts-world.ts';
import type { WorldFile } from './prefix-world.ts';

/** The library skills are imported into: John is its admin, and its main isn't protected. */
export const IMPORT_LIBRARY_REPO = 'acme/team-library';
export const IMPORT_LIBRARY_ID = `lib_${'1e'.repeat(16)}`;

/** A Claude Code plugin marketplace (`plugins/<plugin>/skills/<skill>/`), with commands, agents, hooks and MCP. */
export const MARKETPLACE_REPO = 'acme/claude-marketplace';
/** A plain skills repo, as `npx skills add` installs from (`skills/<skill>/`). */
export const SKILLS_REPO = 'acme/agent-skills';
/** A dotagents project (`agents.toml`, `.agents/skills/<skill>/`). */
export const DOTAGENTS_REPO = 'acme/dotagents-project';
/** A code repo with skills committed in `.claude/skills/` and `.agents/skills/`, and source code next to them. */
export const CODE_REPO = 'acme/backend-api';
/** An old repo of another organization, where the app isn't installed (A13.8): readable only through a local clone. */
export const PRIVATE_REPO = 'oldco/private-skills';

/** Strings that must never be read, copied or sent: source code, and the file a link inside a skill points to. */
export const CANARY_CODE = 'canary-3b8f41 backend source that an import must never read';
export const CANARY_CREDENTIALS = 'canary-a77c02 aws_secret_access_key=never-follow-this-link';

const skill = (name: string, description: string, body: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}${extra}\n---\n\n${body}`;

/** The skills of each layout, as `found at → becomes` (A13.1), for the tests' expectations. */
export const IMPORT_LAYOUTS = {
  [MARKETPLACE_REPO]: [
    ['plugins/eng/skills/code-review', 'acme-code-review'],
    ['plugins/eng/skills/release-notes', 'acme-release-notes'],
    ['plugins/ops/skills/Deploy_Helper', 'acme-deploy-helper'],
  ],
  [SKILLS_REPO]: [
    ['skills/pdf-tools', 'acme-pdf-tools'],
    ['skills/sql-style', 'acme-sql-style'],
  ],
  [DOTAGENTS_REPO]: [['.agents/skills/triage', 'acme-triage']],
  [CODE_REPO]: [
    ['.agents/skills/api-style', 'acme-api-style'],
    ['.claude/skills/db-migrations', 'acme-db-migrations'],
  ],
  [PRIVATE_REPO]: [
    ['onboarding-buddy', 'acme-onboarding-buddy'],
    ['skills/incident-review', 'acme-incident-review'],
  ],
} as const;

/** What isn't imported from the marketplace and the code repo (PLAN.md §3.18), as the report lists it. */
export const NOT_IMPORTED = {
  [MARKETPLACE_REPO]: [
    ['mcp', 'plugins/eng/.mcp.json'],
    ['agent', 'plugins/eng/agents/reviewer.md'],
    ['command', 'plugins/eng/commands/deploy.md'],
    ['hook', 'plugins/eng/hooks/hooks.json'],
  ],
  [CODE_REPO]: [
    ['command', '.claude/commands/fix-tests.md'],
    ['mcp', '.mcp.json'],
  ],
} as const;

function importRepoFiles(): Record<string, Record<string, WorldFile>> {
  return {
    [IMPORT_LIBRARY_REPO]: {
      'library.yaml': `id: ${IMPORT_LIBRARY_ID}\nprefix: acme\nformat: 1\n`,
      'skills/acme-onboarding/SKILL.md': skill(
        'acme-onboarding',
        'Explains how a new person gets started at Acme. Use it in the first week.',
        '# Onboarding\n\nAsk your buddy first.\n',
      ),
      'skills/acme-style-guide/SKILL.md': skill(
        'acme-style-guide',
        'The Acme writing style. Use it for every document.',
        '# Style guide\n\nShort sentences.\n',
      ),
      'instructions/AGENTS.md': '# Acme\n\nWe write tests first.\n',
      '.gitattributes': '* text=auto eol=lf\n',
      '.gitignore': 'node_modules/\n.DS_Store\n',
    },
    [MARKETPLACE_REPO]: {
      'README.md': '# Acme marketplace\n',
      '.claude-plugin/marketplace.json':
        '{"name":"acme","plugins":[{"name":"eng","source":"./plugins/eng"},{"name":"ops","source":"./plugins/ops"}]}\n',
      'plugins/eng/.claude-plugin/plugin.json': '{"name":"eng"}\n',
      'plugins/eng/skills/code-review/SKILL.md': skill(
        'code-review',
        'Reviews code the Acme way. Use it before every merge request.',
        '# Code review\n\nRun scripts/check.sh first, then use release-notes for the summary.\n',
        '\nallowed-tools: Bash(sh:*)',
      ),
      'plugins/eng/skills/code-review/scripts/check.sh': '#!/bin/sh\necho "checked"\n',
      'plugins/eng/skills/release-notes/SKILL.md': skill(
        'release-notes',
        'Writes release notes from merged changes. Use it when a release is cut.',
        '# Release notes\n\nMention breaking changes first. code-review must have passed.\n',
      ),
      'plugins/eng/commands/deploy.md': '# /deploy\n\nDeploys the service.\n',
      'plugins/eng/agents/reviewer.md': '# reviewer\n\nA sub-agent that reviews.\n',
      'plugins/eng/hooks/hooks.json': '{"hooks":{}}\n',
      'plugins/eng/.mcp.json': '{"mcpServers":{}}\n',
      'plugins/ops/skills/Deploy_Helper/SKILL.md': skill(
        'Deploy_Helper',
        'Helps with deployments. Use it before a release.',
        '# Deploy helper\n\nCheck the dashboards.\n',
      ),
    },
    [SKILLS_REPO]: {
      'README.md': '# Agent skills\n\nInstall with npx skills add acme/agent-skills.\n',
      'skills/pdf-tools/SKILL.md': skill(
        'pdf-tools',
        'Fills and reads PDF forms. Use it for any PDF.',
        '# PDF tools\n\nSee references/forms.md.\n',
      ),
      'skills/pdf-tools/references/forms.md': '# Forms\n',
      'skills/sql-style/SKILL.md': skill('sql-style', 'The SQL style. Use it for queries.', '# SQL style\n'),
    },
    [DOTAGENTS_REPO]: {
      'agents.toml': '[[skills]]\nname = "triage"\n',
      '.agents/skills/triage/SKILL.md': skill('triage', 'Triages new issues. Use it every morning.', '# Triage\n'),
    },
    [CODE_REPO]: {
      'README.md': '# Backend API\n',
      'src/main.ts': `// ${CANARY_CODE}\nexport const answer = 42;\n`,
      '.claude/skills/db-migrations/SKILL.md': skill(
        'db-migrations',
        'Writes database migrations. Use it for schema changes.',
        '# Migrations\n',
      ),
      '.agents/skills/api-style/SKILL.md': skill('api-style', 'The API style. Use it for endpoints.', '# API style\n'),
      '.claude/commands/fix-tests.md': '# /fix-tests\n',
      '.mcp.json': '{"mcpServers":{}}\n',
    },
    [PRIVATE_REPO]: {
      'README.md': '# Old private skills\n',
      'onboarding-buddy/SKILL.md': skill(
        'onboarding-buddy',
        'Pairs a new person with a buddy. Use it on day one.',
        '# Onboarding buddy\n',
      ),
      'skills/incident-review/SKILL.md': skill(
        'incident-review',
        'Runs an incident review. Use it after an outage.',
        '# Incident review\n',
      ),
    },
  };
}

/** The repos on the fake GitHub, built with the world. */
export const IMPORT_REPOS = Object.keys(importRepoFiles());

/** The user's own skill in Claude Code's folder (B), with a script and a link to a credentials file. */
export const OWN_SKILL = 'code-review';
export const ownSkillFolder = (root: TestRoot) => path.join(root.home, '.claude', 'skills', OWN_SKILL);
/** A local clone of the repo the app can't read (A13.8). */
export const localCloneFolder = (root: TestRoot) => path.join(root.home, 'old-private-skills');
export const downloads = (root: TestRoot) => path.join(root.home, 'Downloads');

/** The zips in Downloads: good ones, and ones the app must refuse (A13.4). */
export const ZIPS: Readonly<Record<string, readonly ZipItem[]>> = {
  'writing-coach.skill': [
    { name: 'writing-coach/', dir: true },
    {
      name: 'writing-coach/SKILL.md',
      data: skill('writing-coach', 'Coaches clear writing. Use it for every draft.', '# Writing coach\n'),
    },
    { name: 'writing-coach/references/tips.md', data: '# Tips\n\nOne idea in each sentence.\n' },
  ],
  'team-skills.zip': [
    { name: 'skills/standup/SKILL.md', data: skill('standup', 'Runs a standup. Use it daily.', '# Standup\n') },
    { name: 'skills/retro/SKILL.md', data: skill('retro', 'Runs a retro. Use it every sprint.', '# Retro\n') },
  ],
  'zip-slip.zip': [
    { name: 'evil/SKILL.md', data: skill('evil', 'x', '# x\n') },
    { name: '../../.claude/skills/evil/SKILL.md', data: 'escaped\n' },
  ],
  'absolute.zip': [{ name: '/tmp/evil-skill/SKILL.md', data: 'absolute\n' }],
  'symlink.zip': [
    { name: 'linked/SKILL.md', data: skill('linked', 'x', '# x\n') },
    { name: 'linked/creds', link: '../../../.aws/credentials' },
  ],
  'bomb.zip': [
    { name: 'bomb/SKILL.md', data: skill('bomb', 'x', '# x\n') },
    { name: 'bomb/huge.bin', data: 'a', declaredSize: 60 * 1024 * 1024 },
  ],
};

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function buildImportSources(root: TestRoot): void {
  for (const [name, files] of Object.entries(importRepoFiles())) {
    buildBareRepo(root, { flavor: 'github', name, content: 'other' }, files);
  }
  // The user's own skill (PLAN.md §3.18 B): a script, and a link to a file outside it (PLAN.md §3.15).
  const own = ownSkillFolder(root);
  write(
    path.join(own, 'SKILL.md'),
    skill(
      'code-review',
      'My own code review notes. Use it before I push.',
      '# My code review\n\nRun scripts/lint.sh.\n',
    ),
  );
  write(path.join(own, 'scripts', 'lint.sh'), '#!/bin/sh\necho lint\n');
  write(path.join(root.home, '.aws', 'credentials'), `[default]\n${CANARY_CREDENTIALS}\n`);
  mkdirSync(path.join(own, 'references'), { recursive: true });
  symlinkSync(path.join(root.home, '.aws', 'credentials'), path.join(own, 'references', 'aws-credentials'));
  // A local clone of the repo the app can't read, as the user's own git made it (with the host's URL as origin).
  const clone = localCloneFolder(root);
  const bare = path.join(hostRoot(root, 'github'), `${PRIVATE_REPO}.git`);
  const git = (args: readonly string[], cwd: string) =>
    testGitSync(args, cwd, { home: root.at('world-builder'), author: AYSE, env: { LC_ALL: 'C' } });
  git(['clone', '--quiet', bare, clone], root.path);
  git(['remote', 'set-url', 'origin', `https://github.acme.example/${PRIVATE_REPO}.git`], clone);
  for (const [name, items] of Object.entries(ZIPS)) {
    const file = path.join(downloads(root), name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, zipBytes(items));
  }
}

/** Who may read what: John administers the library and reads every old repo; the app is installed on acme only. */
export function setUpImportHosts(hosts: WorldHosts): void {
  const gh = hosts.github.state;
  for (const name of IMPORT_REPOS) {
    hosts.github.adoptRepo(name);
    gh.setPermission(name, JOHN_LOGIN, name === IMPORT_LIBRARY_REPO ? 'admin' : 'read');
  }
}

/** John's token from the app's sign-in (a GitHub App's user token): it reaches only repos the app is installed on. */
export function appToken(hosts: WorldHosts, login = JOHN_LOGIN): string {
  return hosts.github.state.issueToken(login, { clientId: hosts.clientIds.github, lifetimeSeconds: null }).token;
}
