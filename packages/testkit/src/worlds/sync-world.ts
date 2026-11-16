// Step 11's worlds (TESTING.md §4): `incoming-changes`, where the remote is ahead with a new skill, a re-tag, a rename,
// a deletion, a `scripts/` change and an `allowed-tools` change; and `conflict-ready`, with local and remote edits on
// the same lines, a binary conflict, and edit vs delete. Ayşe works in her own clone and pushes; John's local commits
// are made in the library folder with git, as the user would with a terminal. The app joins first, through its own
// use cases; everything after that is other people's and other tools' work.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestRoot } from '../harness/test-root.ts';
import { testGitSync } from '../hosts/test-git.ts';
import { ACME_REPO, ACME_SKILLS, acmeSkillMd } from './acme-world.ts';
import { AYSE, JOHN } from './git-worlds.ts';
import { hostRoot } from './hosts-world.ts';

type Person = { name: string; email: string };

/** A small PNG-like binary file: a NUL byte makes git treat it as binary. */
export const logoBytes = (variant: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, variant]);

export interface WorldClone {
  readonly dir: string;
  write(file: string, content: string | Buffer): void;
  remove(file: string): void;
  /** Commits everything as this person on a fixed date, and pushes when it's a clone of the remote. */
  commit(message: string, date: string, push?: boolean): void;
  git(args: readonly string[], ok?: readonly number[]): string;
}

function clone(root: TestRoot, dir: string, who: Person): WorldClone {
  const home = root.at('world-builder', who === AYSE ? 'ayse-home' : 'john-home');
  const git = (args: readonly string[], cwd: string, date?: string, ok?: readonly number[]) =>
    testGitSync(args, cwd, {
      home,
      author: who,
      env: { LC_ALL: 'C', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
      ...(ok ? { ok } : {}),
    }).stdout;
  return {
    dir,
    write(file, content) {
      const full = path.join(dir, ...file.split('/'));
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    remove(file) {
      rmSync(path.join(dir, ...file.split('/')), { recursive: true, force: true });
    },
    commit(message, date, push = true) {
      git(['add', '-A'], dir);
      git(['commit', '--quiet', '-m', message], dir, date);
      if (push) git(['push', '--quiet', 'origin', 'HEAD'], dir);
    },
    git: (args, ok) => git(args, dir, undefined, ok),
  };
}

/** The Acme library's bare repo on the plain server. */
export const acmeRemote = (root: TestRoot, repo = ACME_REPO) => path.join(hostRoot(root, 'plain'), `${repo}.git`);

/** Ayşe's clone of a world repo, up to date with the remote. */
export function ayseClone(root: TestRoot, repo = ACME_REPO): WorldClone {
  const dir = root.at('world-builder', 'ayse', repo);
  const remote = acmeRemote(root, repo);
  const ayse = clone(root, dir, AYSE);
  if (!existsSync(dir)) {
    mkdirSync(path.dirname(dir), { recursive: true });
    testGitSync(['clone', '--quiet', remote, dir], root.path, {
      home: root.at('world-builder', 'ayse-home'),
      author: AYSE,
    });
  } else ayse.git(['pull', '--quiet', '--no-rebase']);
  return ayse;
}

/** John's library folder, as a terminal there works on it. */
export function johnLibrary(root: TestRoot, library: string): WorldClone {
  return clone(root, library, JOHN);
}

const skill = (name: string) => ACME_SKILLS.find((s) => s.name === name)!;

/** The new skill of `incoming-changes`: tagged backend (PLAN.md §3.6 Day 5). */
export const NEW_SKILL = 'acme-caching-v2';

/**
 * `incoming-changes`: Ayşe pushes six commits after John joined. A new skill, a re-tag, a rename, a deletion, a
 * `scripts/` change and an `allowed-tools` change.
 */
export function pushIncomingChanges(root: TestRoot): void {
  const ayse = ayseClone(root);
  ayse.write(
    `skills/${NEW_SKILL}/SKILL.md`,
    acmeSkillMd({ name: NEW_SKILL, description: 'Use when caching responses in an Acme service.', tags: 'backend' }),
  );
  ayse.commit(`Add ${NEW_SKILL}`, '2026-01-14T09:10:00Z');
  ayse.write('skills/acme-api-design/SKILL.md', acmeSkillMd({ ...skill('acme-api-design'), tags: 'backend api' }));
  ayse.commit('Tag acme-api-design with api', '2026-01-14T09:20:00Z');
  ayse.remove('skills/acme-release-notes');
  ayse.write('skills/acme-changelog/SKILL.md', acmeSkillMd({ ...skill('acme-release-notes'), name: 'acme-changelog' }));
  ayse.commit('Rename acme-release-notes to acme-changelog', '2026-01-14T09:30:00Z');
  ayse.remove('skills/acme-load-testing');
  ayse.commit('Remove acme-load-testing', '2026-01-14T09:40:00Z');
  ayse.write('skills/acme-code-review/scripts/check.sh', '#!/bin/sh\necho checked\nexit 0\n');
  ayse.commit('Code review: the check says what it checked', '2026-01-14T09:50:00Z');
  const onboarding = acmeSkillMd(skill('acme-onboarding')).replace(
    '\nmetadata:',
    '\nallowed-tools: Bash(git log:*)\nmetadata:',
  );
  ayse.write('skills/acme-onboarding/SKILL.md', onboarding);
  ayse.commit('Onboarding may read the git log', '2026-01-14T10:00:00Z');
}

/** The lines both sides change in `conflict-ready`. */
export const CONFLICT_LINE = {
  base: 'Follow the Acme way.',
  mine: 'Follow the Acme way, and explain each comment.',
  theirs: 'Follow the Acme way, and keep each comment short.',
} as const;

/** What `conflict-ready` adds before John joins: a binary file and notes both sides will change. */
export function seedConflictFiles(root: TestRoot): void {
  const ayse = ayseClone(root);
  ayse.write('skills/acme-code-review/assets/logo.png', logoBytes(1));
  ayse.write('skills/acme-release-checklist/notes.md', '- Tag the release\n');
  ayse.commit('Add the logo and the checklist notes', '2026-01-12T09:00:00Z');
}

/**
 * `conflict-ready` after John joined: his commits change the review line, the logo and the checklist notes; Ayşe's
 * change the same line and the logo, and delete the release checklist. A pull stops with three conflicts: contents,
 * binary, and edit vs delete.
 */
export function makeConflicts(root: TestRoot, library: string): void {
  const john = johnLibrary(root, library);
  john.write('skills/acme-code-review/SKILL.md', acmeSkillMd(skill('acme-code-review'), CONFLICT_LINE.mine));
  john.write('skills/acme-code-review/assets/logo.png', logoBytes(2));
  john.write('skills/acme-release-checklist/notes.md', '- Tag the release\n- Write the notes\n');
  john.commit('Review: explain comments; new logo; more checklist notes', '2026-01-14T15:00:00Z', false);

  const ayse = ayseClone(root);
  ayse.write('skills/acme-code-review/SKILL.md', acmeSkillMd(skill('acme-code-review'), CONFLICT_LINE.theirs));
  ayse.write('skills/acme-code-review/assets/logo.png', logoBytes(3));
  ayse.remove('skills/acme-release-checklist');
  ayse.commit('Review: short comments; another logo; drop the release checklist', '2026-01-14T16:00:00Z');
}
