// The `prefix-change` world (TESTING.md §4, Step 14): the Acme library on the `hosts` world's plain server, seen from
// three devices: John's (plain: no local prefix), Ayşe's (Acme Labs, which also says `prefix: acme`, was joined there
// first, so Acme has the local prefix `acmeco`) and Deniz's (an open request: the branch `requests/deniz/acme-onboarding`
// changes acme-onboarding and adds acme-incident-review). The texts mention skill names, which a prefix change never
// rewrites. A second library, set up but without a skill, still has its prefix unlocked (with a typo, `acmee`).
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestRoot } from '../harness/test-root.ts';
import { testGitSync } from '../hosts/test-git.ts';
import { ACME_SKILLS, acmeLibraryFiles, acmeSkillMd } from './acme-world.ts';
import { JOHN_LOGIN } from './git-worlds.ts';
import { buildBareRepo, DENIZ, hostRoot, type WorldHosts } from './hosts-world.ts';
import { buildCodeRepo } from './repos-world.ts';
import { ayseClone } from './sync-world.ts';

export const PREFIX_LIBRARY_ID = `lib_${'9e'.repeat(16)}`;
export const PREFIX_REPO = 'acme/prefix-library';
/** A library set up with a typo in its prefix, and no skill pushed yet: the prefix isn't locked. */
export const FRESH_LIBRARY_ID = `lib_${'8f'.repeat(16)}`;
export const FRESH_REPO = 'acme/fresh-library';
export const FRESH_PREFIX = 'acmee';
/** The prefix the Admin changes to in the tests (PLAN.md §3.2: `acme` → `newco`). */
export const NEW_PREFIX = 'newco';
export const REQUEST_BRANCH = 'requests/deniz/acme-onboarding';
/** The skill Deniz's request adds under the old prefix (PLAN.md §3.2 step 4). */
export const REQUEST_SKILL = 'acme-incident-review';
/** John's code repo, where the tag `backend` places skills (exclude entries follow the prefix, PLAN.md §3.6). */
export const PREFIX_CODE_REPO = 'work/backend-api';
/** John's own folder that starts with the new prefix: the change clashes on his device (A14.4). */
export const NEWCO_FOLDER = '.claude/skills/newco-notes';

const RELEASE_CHECKLIST = ACME_SKILLS.find((skill) => skill.name === 'acme-release-checklist');

/** The library: the Acme skills, with texts that name other skills. */
export function prefixLibraryFiles(): Record<string, string> {
  const files = acmeLibraryFiles();
  files['library.yaml'] = `id: ${PREFIX_LIBRARY_ID}\nprefix: acme\nformat: 1\n`;
  if (RELEASE_CHECKLIST) {
    files['skills/acme-release-checklist/SKILL.md'] = acmeSkillMd(
      RELEASE_CHECKLIST,
      'Check the tests, then use acme-release-notes for the notes.',
    );
  }
  files['instructions/AGENTS.md'] = '# Acme\n\nWe write tests first. Ask acme-code-review before every merge.\n';
  return files;
}

export function freshLibraryFiles(): Record<string, string> {
  return {
    'library.yaml': `id: ${FRESH_LIBRARY_ID}\nprefix: ${FRESH_PREFIX}\nformat: 1\n`,
    'instructions/AGENTS.md': '# Acme\n\nWe write tests first.\n',
    '.gitattributes': '* text=auto eol=lf\n',
  };
}

/** Deniz's request: acme-onboarding changed, and a new skill under the old prefix. */
export function requestFiles(): Record<string, string> {
  const onboarding = ACME_SKILLS.find((skill) => skill.name === 'acme-onboarding');
  return {
    ...(onboarding
      ? { 'skills/acme-onboarding/SKILL.md': acmeSkillMd(onboarding, 'Start with the team page, then the wiki.') }
      : {}),
    [`skills/${REQUEST_SKILL}/SKILL.md`]: [
      '---',
      `name: ${REQUEST_SKILL}`,
      'description: Use after an incident, to review what happened at Acme.',
      'metadata:',
      '  tags: "general"',
      '---',
      '',
      '# incident review',
      '',
      'Blameless, with a timeline.',
      '',
    ].join('\n'),
  };
}

/** The bare repos on the plain server, and Deniz's request branch pushed there. */
export function buildPrefixRepos(root: TestRoot): void {
  buildBareRepo(root, { flavor: 'plain', name: PREFIX_REPO, content: 'library' }, prefixLibraryFiles());
  buildBareRepo(root, { flavor: 'plain', name: FRESH_REPO, content: 'library' }, freshLibraryFiles());
  const bare = path.join(hostRoot(root, 'plain'), `${PREFIX_REPO}.git`);
  const work = root.at('world-builder', 'work', 'request');
  const date = '2026-01-12T14:00:00Z';
  const git = (args: readonly string[], cwd: string) =>
    testGitSync(args, cwd, {
      home: root.at('world-builder'),
      author: DENIZ,
      env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, LC_ALL: 'C' },
    });
  git(['clone', '--quiet', bare, work], root.path);
  git(['switch', '--quiet', '-c', REQUEST_BRANCH], work);
  for (const [name, text] of Object.entries(requestFiles())) {
    const file = path.join(work, ...name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  git(['add', '-A'], work);
  git(['commit', '--quiet', '-m', 'Clarify onboarding and add incident review'], work);
  git(['push', '--quiet', 'origin', REQUEST_BRANCH], work);
  rmSync(work, { recursive: true, force: true });
  // John's code repo, where the tests tick `backend`.
  buildCodeRepo(root, path.join(root.home, ...PREFIX_CODE_REPO.split('/')), 'acme/backend-api');
}

/** John's own folder named with the new prefix (PLAN.md §3.3 "Detection"): its text is never read. */
export function plantNewcoFolder(root: TestRoot): void {
  const dir = path.join(root.home, ...NEWCO_FOLDER.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: newco-notes\ndescription: ${CANARY_NEWCO}\n---\n`);
}

export const CANARY_NEWCO = 'canary-5c0e17 my own newco notes';

/**
 * Ayşe, an Admin, changes the prefix with her own git (as another git tool would): every `acme-` folder and its
 * `name:` line, and library.yaml, in one commit pushed to the plain server. John's app gets it with a fetch.
 */
export function pushPrefixChange(root: TestRoot, to = NEW_PREFIX): void {
  const ayse = ayseClone(root, PREFIX_REPO);
  const skills = path.join(ayse.dir, 'skills');
  for (const folder of readdirSync(skills).sort()) {
    if (!folder.startsWith('acme-')) continue;
    const name = `${to}${folder.slice('acme'.length)}`;
    renameSync(path.join(skills, folder), path.join(skills, name));
    const file = path.join(skills, name, 'SKILL.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(`\nname: ${folder}\n`, `\nname: ${name}\n`));
  }
  const yaml = path.join(ayse.dir, 'library.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace('prefix: acme\n', `prefix: ${to}\n`));
  ayse.commit(`Change the prefix from acme to ${to}`, '2026-01-14T09:00:00Z');
}

/** What the world adds to its plain server: its two repos, which John's token may write. */
export function setUpPrefixHosts(hosts: WorldHosts): void {
  for (const repo of [PREFIX_REPO, FRESH_REPO]) {
    hosts.plain.adoptRepo(repo);
    hosts.plain.state.setPermission(repo, JOHN_LOGIN, 'write');
  }
}
