// Code repos (PLAN.md §3.6 "Adding repos"): what the app calls a repo, which tag suggestions match it, and which tools
// may see a skill twice in nested repos. Remotes name repos because they're the same on every computer, while folder
// paths differ.
import { parseGitUrl } from '../../library/index.ts';
import type { PathFlavour } from '../../shared/paths.ts';

/** `owner/name` from a remote, e.g. `acme/backend-api`, or null when there's none or it can't be read. */
export function remoteSlug(remote: string | null): string | null {
  if (remote === null) return null;
  const parsed = parseGitUrl(remote);
  return parsed.ok ? parsed.value.path : null;
}

/** What the UI calls a repo: its remote's last part, else its folder's name. */
export function repoName(remote: string | null, folder: string, paths: PathFlavour): string {
  const slug = remoteSlug(remote);
  const last = slug?.split('/').pop();
  return last && last.length > 0 ? last : paths.basename(folder);
}

/** A `suggest` pattern from library.yaml, e.g. `acme/backend-*`: `*` stands for any characters, letter case ignored. */
export function matchesPattern(slug: string, pattern: string): boolean {
  const escaped = pattern
    .trim()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(slug);
}

/** The tags library.yaml suggests for a repo's remote (§3.6 "Optional suggestion hints"), sorted. */
export function suggestedTags(
  suggest: Readonly<Record<string, readonly string[]>> | undefined,
  remote: string | null,
): string[] {
  const slug = remoteSlug(remote);
  if (!suggest || slug === null) return [];
  return Object.entries(suggest)
    .filter(([, patterns]) => patterns.some((pattern) => matchesPattern(slug, pattern)))
    .map(([tag]) => tag)
    .sort();
}

export interface NestedPair {
  readonly outer: string;
  readonly inner: string;
}

/** Repos inside other added repos (§3.6 "Nested repos are independent"), by id. */
export function nestedRepos(
  repos: ReadonlyArray<{ readonly id: string; readonly path: string }>,
  paths: PathFlavour,
): NestedPair[] {
  const pairs: NestedPair[] = [];
  for (const outer of repos) {
    for (const inner of repos) {
      if (outer.id !== inner.id && !paths.same(outer.path, inner.path) && paths.isInside(outer.path, inner.path)) {
        pairs.push({ outer: outer.id, inner: inner.id });
      }
    }
  }
  return pairs;
}

export interface NestedRepoWarning extends NestedPair {
  readonly tool: string;
  /** `past-git-root`: it reads the outer repo's links too; `unknown`: not verified yet (§3.4). */
  readonly lookup: 'past-git-root' | 'unknown';
}

/**
 * The placement analysis for nested repos (A6.12): each enabled tool whose `repo_lookup` reads past the git root, or
 * isn't known, may list a skill placed in both repos twice in the inner one. The Doctor shows it (Step 7).
 */
export function nestedRepoWarnings(
  pairs: readonly NestedPair[],
  tools: ReadonlyArray<{ readonly id: string; readonly repoLookup: 'to-git-root' | 'past-git-root' | 'unknown' }>,
  enabled: readonly string[],
): NestedRepoWarning[] {
  const warnings: NestedRepoWarning[] = [];
  for (const pair of pairs) {
    for (const tool of tools) {
      if (!enabled.includes(tool.id) || tool.repoLookup === 'to-git-root') continue;
      warnings.push({ ...pair, tool: tool.id, lookup: tool.repoLookup });
    }
  }
  return warnings;
}
