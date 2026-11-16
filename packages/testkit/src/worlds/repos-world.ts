// Step 6's worlds (TESTING.md §4): `repos-and-tags`, the library of PLAN.md §3.6's example with tagged skills,
// suggestions and repo-only tags, and code repos (backend-api, backend-billing, web-app) with a worktree, and a nested
// repo; `large`, 1,000 skills, 50 repos and 200 worktrees, for the performance measurements (TESTING.md §9.8). Code repos have remotes on a host nobody fetches from: the app reads
// only the remote's URL (PLAN.md §3.7 rule 4).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestRoot } from '../harness/test-root.ts';
import { testGitSync } from '../hosts/test-git.ts';
import { JOHN } from './git-worlds.ts';

export const REPOS_LIBRARY_ID = `lib_${'ab'.repeat(16)}`;
export const REPOS_LIBRARY_REPO = 'acme/placement-library';

/** PLAN.md §3.6's skills before the timeline starts. acme-caching arrives on Day 5. */
export const PLACEMENT_SKILLS: Readonly<Record<string, string>> = {
  'acme-api-design': 'backend',
  'acme-code-review': 'general',
  'acme-db-migrations': 'backend database',
  'acme-k8s-deploy': 'backend',
  'acme-load-testing': 'testing',
  'acme-onboarding': 'general',
  'acme-react-guidelines': 'frontend',
  'acme-release-checklist': 'general',
};

export function placementSkillMd(name: string, tags: string, body = 'Follow the Acme way.'): string {
  return [
    '---',
    `name: ${name}`,
    `description: Use it for ${name.replace(/^acme-/, '').replace(/-/g, ' ')} at Acme.`,
    'metadata:',
    `  tags: "${tags}"`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

export const PLACEMENT_LIBRARY_YAML = [
  `id: ${REPOS_LIBRARY_ID}`,
  'prefix: acme',
  'format: 1',
  'suggest: { backend: ["acme/backend-*"], frontend: ["acme/web-*"] }',
  'repoOnlyTags: [mobile]',
  '',
].join('\n');

export function placementLibraryFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'library.yaml': PLACEMENT_LIBRARY_YAML,
    '.gitattributes': '* text=auto eol=lf\n',
    '.gitignore': 'node_modules/\n.DS_Store\n',
  };
  for (const [name, tags] of Object.entries(PLACEMENT_SKILLS))
    files[`skills/${name}/SKILL.md`] = placementSkillMd(name, tags);
  return files;
}

/** Source code in the user's repos: the app must never read it (PLAN.md §3.7 rule 4, TESTING.md §9.4). */
export const CANARY_SOURCE = 'canary-5c09e2 private source code';

export const CODE_REMOTE_HOST = 'https://git.acme.test';

/** The code repos of `repos-and-tags`, relative to the home folder. */
export const CODE_REPOS = {
  api: 'work/backend-api',
  billing: 'work/backend-billing',
  web: 'work/web-app',
  /** A repo with a repo inside it (PLAN.md §3.6 "Nested repos are independent"). */
  platform: 'work/platform',
  inner: 'work/platform/services/billing',
  /** A worktree of backend-api outside its folder, as agent tools make them. */
  apiWorktree: 'agent-worktrees/backend-api-review',
  /** Another library's folder inside the parent folder (built by `buildLibraryInWork`): never a code repo (A6.13). */
  library: 'work/team-library',
} as const;

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** One code repo with a commit, its `origin` remote, and a canary in its source. */
export function buildCodeRepo(root: TestRoot, folder: string, slug: string): void {
  const home = root.at('world-builder');
  const date = '2026-01-12T10:00:00Z';
  const git = (args: readonly string[], cwd: string) =>
    testGitSync(args, cwd, {
      home,
      author: JOHN,
      env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, LC_ALL: 'C' },
    });
  mkdirSync(folder, { recursive: true });
  git(['init', '--initial-branch=main', folder], root.path);
  write(path.join(folder, 'README.md'), `# ${slug}\n`);
  write(path.join(folder, 'src', 'main.ts'), `// ${CANARY_SOURCE}\nexport const answer = 42;\n`);
  git(['add', '-A'], folder);
  git(['commit', '-m', 'First commit'], folder);
  git(['remote', 'add', 'origin', `${CODE_REMOTE_HOST}/${slug}.git`], folder);
}

/** Adds a worktree of a code repo, as an agent tool does. */
export function addWorktree(root: TestRoot, repo: string, worktree: string, branch: string): void {
  testGitSync(['worktree', 'add', '-b', branch, worktree], repo, { home: root.at('world-builder'), author: JOHN });
}

/** The code repos of `repos-and-tags` in the test root's home folder. */
export function buildCodeRepos(root: TestRoot): void {
  const at = (relative: string) => path.join(root.home, ...relative.split('/'));
  buildCodeRepo(root, at(CODE_REPOS.api), 'acme/backend-api');
  buildCodeRepo(root, at(CODE_REPOS.billing), 'acme/backend-billing');
  buildCodeRepo(root, at(CODE_REPOS.web), 'acme/web-app');
  buildCodeRepo(root, at(CODE_REPOS.platform), 'acme/platform');
  buildCodeRepo(root, at(CODE_REPOS.inner), 'acme/billing-service');
  addWorktree(root, at(CODE_REPOS.api), at(CODE_REPOS.apiWorktree), 'review');
}

/** Another library's folder inside the parent folder: a git repo with a library.yaml (A6.13). */
export function buildLibraryInWork(root: TestRoot): string {
  const library = path.join(root.home, ...CODE_REPOS.library.split('/'));
  buildCodeRepo(root, library, 'acme/team-library');
  write(path.join(library, 'library.yaml'), `id: lib_${'0a'.repeat(16)}\nprefix: team\nformat: 1\n`);
  return library;
}

/** The `large` world's sizes (TESTING.md §4). */
export const LARGE = { skills: 1000, repos: 50, worktrees: 200 } as const;

/** The large library: 1,000 skills, each with one of 20 tags. */
export function largeLibraryFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'library.yaml': `id: lib_${'cd'.repeat(16)}\nprefix: acme\nformat: 1\n`,
    '.gitattributes': '* text=auto eol=lf\n',
  };
  for (let i = 0; i < LARGE.skills; i++) {
    const name = `acme-skill-${String(i).padStart(4, '0')}`;
    files[`skills/${name}/SKILL.md`] = placementSkillMd(name, `team${i % 20}`);
  }
  return files;
}

/** 50 code repos in `home/large`, with 4 worktrees each in `home/large-worktrees`. */
export function buildLargeRepos(root: TestRoot): void {
  for (let r = 0; r < LARGE.repos; r++) {
    const name = `service-${String(r).padStart(2, '0')}`;
    const repo = path.join(root.home, 'large', name);
    buildCodeRepo(root, repo, `acme/${name}`);
    for (let w = 0; w < LARGE.worktrees / LARGE.repos; w++) {
      addWorktree(root, repo, path.join(root.home, 'large-worktrees', `${name}-${w}`), `work-${w}`);
    }
  }
}
