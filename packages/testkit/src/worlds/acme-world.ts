// Step 5's worlds (TESTING.md §4): `acme-basic`, the Acme library with 10 skills, joined, with Claude Code and Codex
// enabled; and `taken-names`, which adds the user's own folders on company skill paths (S2), a real folder replacing a
// link (S4) and a foreign link (S5). The library is a repo on the `hosts` world's plain server. The app's state comes
// from the app's own use cases: the join runs the setup flow, and the tools are enabled with the confirmed plan.
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestRoot } from '../harness/test-root.ts';

export const ACME_LIBRARY_ID = `lib_${'ac'.repeat(16)}`;
export const ACME_REPO = 'acme/basic-library';

/** PLAN.md's example skills (§3.0, §3.6), each with tags. */
export const ACME_SKILLS: ReadonlyArray<{
  readonly name: string;
  readonly description: string;
  readonly tags: string;
}> = [
  { name: 'acme-api-design', description: 'Use when designing or reviewing an HTTP API at Acme.', tags: 'backend' },
  { name: 'acme-caching', description: 'Use when adding a cache to an Acme service.', tags: 'backend' },
  {
    name: 'acme-code-review',
    description: 'Reviews code the Acme way. Use it before every merge request.',
    tags: 'general',
  },
  {
    name: 'acme-db-migrations',
    description: 'Use when writing or reviewing database migrations.',
    tags: 'backend database',
  },
  { name: 'acme-k8s-deploy', description: 'Use when deploying an Acme service to Kubernetes.', tags: 'backend' },
  { name: 'acme-load-testing', description: 'Use when load testing an Acme service before a launch.', tags: 'backend' },
  {
    name: 'acme-onboarding',
    description: 'Use when a new person joins Acme and asks how things work.',
    tags: 'general',
  },
  { name: 'acme-react-guidelines', description: 'Use when writing React code in an Acme web app.', tags: 'frontend' },
  { name: 'acme-release-checklist', description: 'Use before cutting an Acme release.', tags: 'general' },
  {
    name: 'acme-release-notes',
    description: 'Writes release notes from merged changes. Use it when a release is cut.',
    tags: 'general',
  },
];

export function acmeSkillMd(skill: (typeof ACME_SKILLS)[number], body?: string): string {
  return [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    'metadata:',
    `  tags: "${skill.tags}"`,
    '---',
    '',
    `# ${skill.name.replace(/^acme-/, '').replace(/-/g, ' ')}`,
    '',
    body ?? 'Follow the Acme way.',
    '',
  ].join('\n');
}

/** The library's files, as the world's first commit has them. */
export function acmeLibraryFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'library.yaml': `id: ${ACME_LIBRARY_ID}\nprefix: acme\nformat: 1\n`,
    'instructions/AGENTS.md': '# Acme\n\nWe write tests first.\n',
    '.gitattributes': '* text=auto eol=lf\n*.bat text eol=crlf\n*.cmd text eol=crlf\n',
    '.gitignore': 'node_modules/\n__pycache__/\n.venv/\n.DS_Store\nThumbs.db\n',
  };
  for (const skill of ACME_SKILLS) files[`skills/${skill.name}/SKILL.md`] = acmeSkillMd(skill);
  files['skills/acme-code-review/scripts/check.sh'] = '#!/bin/sh\necho ok\n';
  return files;
}

/** The user's own skill on a company skill path (S2): its text must never be read (TESTING.md §9.4). */
export const CANARY_TAKEN_NAME = 'canary-2b7f41 my own onboarding notes';

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * `taken-names` before the app runs: the user's own folder at `~/.claude/skills/acme-onboarding` (S2), and a file at
 * `~/.agents/skills/acme-release-checklist`. Both exist before the first health check, so they're skipped.
 */
export function plantTakenNames(root: TestRoot): void {
  write(
    path.join(root.home, '.claude', 'skills', 'acme-onboarding', 'SKILL.md'),
    `---\nname: acme-onboarding\ndescription: My own onboarding notes.\n---\n${CANARY_TAKEN_NAME}\n`,
  );
  write(path.join(root.home, '.agents', 'skills', 'acme-release-checklist'), `${CANARY_TAKEN_NAME} (a file)\n`);
}

/**
 * `taken-names` after the app linked everything: a real folder with changed content replaces a link (S4 DIVERGED), a
 * copy of the company version replaces another (S4 DETACHED), and another tool's link replaces a third (S5).
 */
export function replaceLinks(root: TestRoot): void {
  const claude = path.join(root.home, '.claude', 'skills');
  const agents = path.join(root.home, '.agents', 'skills');
  const review = ACME_SKILLS.find((s) => s.name === 'acme-code-review')!;
  unlinkSync(path.join(claude, 'acme-code-review'));
  write(path.join(claude, 'acme-code-review', 'SKILL.md'), acmeSkillMd(review, 'Be kind, specific and quick.'));
  const notes = ACME_SKILLS.find((s) => s.name === 'acme-release-notes')!;
  unlinkSync(path.join(claude, 'acme-release-notes'));
  write(path.join(claude, 'acme-release-notes', 'SKILL.md'), acmeSkillMd(notes));
  const manager = path.join(root.home, '.skills-manager', 'acme-api-design');
  write(path.join(manager, 'SKILL.md'), '---\nname: acme-api-design\ndescription: An old copy.\n---\n');
  rmSync(path.join(agents, 'acme-api-design'), { force: true });
  symlinkSync(manager, path.join(agents, 'acme-api-design'), 'junction');
}
