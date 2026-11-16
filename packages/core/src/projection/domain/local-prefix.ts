// Choosing a local prefix (PLAN.md §3.3): when the git prefix is in use on this device already, by another instance or
// by the user's own folders, this library's skills get another prefix here. It follows the rules of §3.2, isn't used
// by any other instance or by the user's own folders, and the app suggests one from the library's URL. A local prefix
// longer than the git prefix makes every name longer: the skills that would go over 64 characters are listed, with a
// shorter suggestion.
import { prefixProblems, type PrefixProblem, SKILL_NAME_MAX } from '@app/schemas';
import { localName, type Prefix } from '../../library/index.ts';

/** Why a local prefix can't be used. */
export type LocalPrefixProblem =
  | { readonly code: 'rules'; readonly problem: PrefixProblem }
  /** The git prefix itself: that's no local prefix, but dropping it. */
  | { readonly code: 'git-prefix' }
  | { readonly code: 'instance'; readonly name: string }
  | { readonly code: 'folders' };

/** What a local prefix is checked against: the other instances, and whether the user's own folders use it. */
export interface LocalPrefixContext {
  readonly gitPrefix: string;
  /** The other instances on the device and their effective prefixes. */
  readonly instances: ReadonlyArray<{ readonly prefix: string; readonly name: string }>;
  /** Whether a folder in a tool's skills folder starts with `<prefix>-` (PLAN.md §3.3 "Detection"). */
  readonly folderUses: (prefix: string) => boolean;
}

/** Why the git prefix needs a local one here: null when it's free on this device. */
export function clashOf(
  context: LocalPrefixContext,
): { readonly kind: 'instance'; readonly name: string } | { readonly kind: 'folders' } | null {
  const instance = context.instances.find((other) => other.prefix === context.gitPrefix);
  if (instance) return { kind: 'instance', name: instance.name };
  return context.folderUses(context.gitPrefix) ? { kind: 'folders' } : null;
}

export function localPrefixProblem(candidate: string, context: LocalPrefixContext): LocalPrefixProblem | null {
  const [problem] = prefixProblems(candidate);
  if (problem) return { code: 'rules', problem };
  if (candidate === context.gitPrefix) return { code: 'git-prefix' };
  const instance = context.instances.find((other) => other.prefix === candidate);
  if (instance) return { code: 'instance', name: instance.name };
  if (context.folderUses(candidate)) return { code: 'folders' };
  return null;
}

/** A skill's name under a local prefix; undefined when its folder doesn't start with the git prefix (§3.2). */
export function projectedName(folder: string, gitPrefix: string, localPrefix: string): string | undefined {
  return localName(folder, gitPrefix as Prefix, localPrefix as Prefix);
}

/** The skills whose names would go over 64 characters under the local prefix. */
export function tooLongUnder(folders: readonly string[], gitPrefix: string, localPrefix: string): string[] {
  return folders.filter((folder) => {
    const name = projectedName(folder, gitPrefix, localPrefix);
    return name !== undefined && [...name].length > SKILL_NAME_MAX;
  });
}

/** The longest local prefix that keeps every name within 64 characters. */
export function longestFitting(folders: readonly string[], gitPrefix: string): number {
  let longest = Infinity;
  for (const folder of folders) {
    if (!folder.startsWith(`${gitPrefix}-`)) continue;
    longest = Math.min(longest, SKILL_NAME_MAX - [...folder.slice(gitPrefix.length)].length);
  }
  return longest;
}

/** Host and path words that say nothing about the company. */
const GENERIC_WORDS = new Set([
  'www',
  'git',
  'gitlab',
  'github',
  'bitbucket',
  'gitea',
  'forgejo',
  'code',
  'scm',
  'src',
  'source',
  'repo',
  'repos',
  'dev',
  'com',
  'org',
  'net',
  'io',
  'co',
  'example',
  'localhost',
  'local',
  'internal',
  'corp',
  'ai',
  'skills',
  'skill',
  'agent',
  'agents',
  'library',
  'libraries',
  'shared',
  'team',
  'teams',
]);

/** The URL's words that may name the company, in order: the host's labels, then the path's groups. */
function urlWords(url: { readonly host: string; readonly path: string }): string[] {
  const host = url.host.replace(/:\d+$/, '');
  const labels = /^[0-9.]+$/.test(host) ? [] : host.split('.').slice(0, -1);
  const groups = url.path
    .replace(/\.git$/, '')
    .split('/')
    .slice(0, -1);
  const words: string[] = [];
  for (const part of [...labels, ...groups]) {
    const letters = part.toLowerCase().replace(/[^a-z]/g, '');
    if (letters !== '' && !GENERIC_WORDS.has(letters) && !words.includes(letters)) words.push(letters);
  }
  return words;
}

/**
 * The candidates in the order they're suggested: words of the URL (`gitlab.acme-labs.io` gives `acmelabs`), the git
 * prefix with one of them added, then the git prefix with a short word or a letter added. Each is cut to the longest
 * length allowed; candidates that break the rules of §3.2 are left out.
 */
export function localPrefixCandidates(
  gitPrefix: string,
  url: { readonly host: string; readonly path: string },
  maxLength = 16,
): string[] {
  const words = urlWords(url);
  const raw = [
    ...words,
    ...words.filter((word) => !word.startsWith(gitPrefix)).map((word) => `${gitPrefix}${word}`),
    `${gitPrefix}local`,
    `${gitPrefix}two`,
    ...'bcdefghjkmnpqrstvwxyz'.split('').map((letter) => `${gitPrefix}${letter}`),
  ];
  const out: string[] = [];
  for (const candidate of raw) {
    const cut = candidate.slice(0, Math.max(0, Math.min(16, maxLength)));
    if (cut === gitPrefix || out.includes(cut) || prefixProblems(cut).length > 0) continue;
    out.push(cut);
  }
  return out;
}

/** The first candidate that's free on this device, or null. */
export function suggestLocalPrefix(candidates: readonly string[], context: LocalPrefixContext): string | null {
  return candidates.find((candidate) => localPrefixProblem(candidate, context) === null) ?? null;
}

/**
 * A shorter free prefix when `candidate` pushes names past 64 characters: the URL's candidates cut to the longest
 * length that fits, or null when even the shortest allowed one doesn't.
 */
export function shorterSuggestion(
  candidate: string,
  folders: readonly string[],
  context: LocalPrefixContext,
  url: { readonly host: string; readonly path: string },
): string | null {
  const fits = longestFitting(folders, context.gitPrefix);
  if ([...candidate].length <= fits) return null;
  const cut = candidate.slice(0, fits);
  const options = [cut, ...localPrefixCandidates(context.gitPrefix, url, fits)];
  return options.find((option) => [...option].length <= fits && localPrefixProblem(option, context) === null) ?? null;
}
