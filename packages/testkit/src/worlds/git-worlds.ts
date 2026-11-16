// Step 3's worlds (TESTING.md §4): `messy-gitconfig`, a device whose global git config is full of personal settings
// that change git's output or behaviour, and the git repos the developer git page shows. Repos are built with the
// bundled git, isolated from this computer's configuration, with a history by named people on fixed dates.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { testGitSync } from '../hosts/test-git.ts';
import type { TestRoot } from '../harness/test-root.ts';
import { type FixtureLibrary, validLibrary, writeFixtureLibrary } from './libraries.ts';

export const AYSE = { name: 'Ayşe Yılmaz', email: 'ayse@acme.test' };
/** The person who uses the app in the worlds, in the tests and in the pictures and videos of the README. */
export const JOHN = { name: 'John Smith', email: 'john@acme.test' };
/** The login of JOHN on the fake hosts. */
export const JOHN_LOGIN = 'john';

/** The script `diff.external` names: if git ever ran it for the app, its marker would show up in the results. */
export const EXTERNAL_DIFF_MARKER = 'external-diff-ran-3f9c';

/** The personal settings (TESTING.md §4): each would change what the app reads, or make git wait. */
export function messyGitconfig(tools: string): string {
  const editor = path.join(tools, 'never-exits.sh');
  const external = path.join(tools, 'external-diff.sh');
  return [
    '[user]',
    '\tname = Messy Person',
    '\temail = messy@example.invalid',
    '\tuseConfigOnly = true',
    '[init]',
    '\tdefaultBranch = trunk',
    '[color]',
    '\tui = always',
    '\tstatus = always',
    '\tdiff = always',
    '\tbranch = always',
    '[log]',
    '\tshowSignature = true',
    '\tdecorate = full',
    '\tfollow = true',
    '\tabbrevCommit = true',
    '\tdate = relative',
    '[format]',
    '\tpretty = oneline',
    '[diff]',
    `\texternal = ${external}`,
    '\trenames = false',
    '\tnoprefix = true',
    '[status]',
    '\tshowUntrackedFiles = no',
    '\trenames = false',
    '\tshort = true',
    '\tbranch = true',
    '[merge]',
    '\tconflictStyle = zdiff3',
    '\tff = only',
    '\tautoStash = true',
    '[pull]',
    '\trebase = true',
    '\tff = only',
    '[rebase]',
    '\tautoStash = true',
    '\tautoSquash = true',
    '[push]',
    '\tdefault = nothing',
    '\tfollowTags = true',
    '[core]',
    `\teditor = ${editor}`,
    '\tpager = less -FRX',
    '[sequence]',
    `\teditor = ${editor}`,
    '[commit]',
    '\tverbose = true',
    '[submodule]',
    '\trecurse = true',
    '[alias]',
    '\tst = status',
    '',
  ].join('\n');
}

/** Writes the messy global git config into a test root (its GIT_CONFIG_GLOBAL), with its two scripts. */
export function writeMessyGitconfig(root: TestRoot): void {
  const tools = root.at('tools');
  mkdirSync(tools, { recursive: true });
  // An editor that never exits: a command that opens one would hang.
  writeFileSync(path.join(tools, 'never-exits.sh'), '#!/bin/sh\nwhile :; do sleep 1; done\n');
  writeFileSync(path.join(tools, 'external-diff.sh'), `#!/bin/sh\necho ${EXTERNAL_DIFF_MARKER}\n`);
  chmodSync(path.join(tools, 'never-exits.sh'), 0o755);
  chmodSync(path.join(tools, 'external-diff.sh'), 0o755);
  writeFileSync(root.gitconfig, messyGitconfig(tools));
}

/** git for building a world: its own empty config, never the world's or this computer's. */
function worldGit(root: TestRoot) {
  const home = root.at('world-builder');
  return (args: readonly string[], cwd: string, who = AYSE, date = '2026-01-10T10:00:00Z', ok?: readonly number[]) =>
    testGitSync(args, cwd, {
      home,
      author: who,
      env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_EDITOR: ':', LC_ALL: 'C' },
      ...(ok ? { ok } : {}),
    }).stdout;
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * A remote with history and two clones of it, for the developer git page:
 * - `home/libraries/acme-git`: one commit not pushed yet, one incoming, an edited file and a new one
 * - `home/libraries/acme-conflict`: in the middle of a merge that stopped on conflicts
 */
export function buildGitLibraries(root: TestRoot, fixture: FixtureLibrary = validLibrary): void {
  const git = worldGit(root);
  const bare = path.join(root.remotes, 'acme', 'agent-library.git');
  mkdirSync(path.dirname(bare), { recursive: true });
  git(['init', '--bare', '--initial-branch=main', bare], root.path);

  const seed = root.at('world-builder', 'seed');
  git(['clone', bare, seed], root.path);
  writeFixtureLibrary(fixture, seed, { caseSensitive: false });
  git(['add', '-A'], seed);
  git(['commit', '-m', 'Add the Acme skills'], seed, AYSE, '2026-01-10T10:00:00Z');
  const notes = path.join(seed, 'skills', 'acme-release-notes', 'SKILL.md');
  write(notes, `${readText(notes)}Mention breaking changes first.\n`);
  git(['commit', '-am', 'Release notes: breaking changes first'], seed, JOHN, '2026-01-12T14:30:00Z');
  git(['push', 'origin', 'main'], seed);

  const library = root.at('home', 'libraries', 'acme-git');
  const conflict = root.at('home', 'libraries', 'acme-conflict');
  git(['clone', bare, library], root.path);
  git(['clone', bare, conflict], root.path);

  // Incoming: Ayşe changes the release notes' last line after both clones.
  write(notes, readText(notes).replace('Mention breaking changes first.', 'List breaking changes first, then fixes.'));
  git(['commit', '-am', 'Release notes: then fixes'], seed, AYSE, '2026-01-14T09:15:00Z');
  git(['push', 'origin', 'main'], seed);

  // acme-git: a commit not pushed yet, an edited file and a new one, and the incoming commit fetched.
  const guide = path.join(library, 'skills', 'acme-release-notes', 'references', 'guide.md');
  write(guide, `${readText(guide)}\nKeep each entry to one line.\n`);
  git(['commit', '-am', 'Guide: one line per entry'], library, JOHN, '2026-01-14T16:00:00Z');
  write(path.join(library, 'README.md'), '# Acme agent library\n\nAsk #agents for help.\n');
  write(path.join(library, 'skills', 'acme-release-notes', 'checklist.md'), '- [ ] Breaking changes\n');
  git(['fetch', 'origin'], library);

  // acme-conflict: the same line changed on this device, then a merge of the incoming commit that stops.
  const theirs = path.join(conflict, 'skills', 'acme-release-notes', 'SKILL.md');
  write(theirs, readText(theirs).replace('Mention breaking changes first.', 'Start with the highlights.'));
  git(['commit', '-am', 'Release notes: highlights first'], conflict, JOHN, '2026-01-14T17:00:00Z');
  git(['fetch', 'origin'], conflict);
  git(['merge', '--no-edit', 'origin/main'], conflict, JOHN, '2026-01-15T08:30:00Z', [1]);
}

function readText(file: string): string {
  return readFileSync(file, 'utf8');
}
