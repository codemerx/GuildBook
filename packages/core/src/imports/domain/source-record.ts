// Where an imported skill came from, as `metadata.source` records it (PLAN.md §3.18): the repo, the commit and the path
// in the repo, e.g. `github.com/acme/old-skills@3f2a1c9:plugins/eng/skills/code-review`. A local path is never recorded,
// because it would put a device-specific path into the company's repo: a folder without a remote records nothing.
import { parseGitUrl } from '../../library/index.ts';

export interface SourceFacts {
  /** The repo's remote URL (the URL cloned, or a local clone's `origin`), or null. */
  readonly remote: string | null;
  /** The commit the skill was read from, or null when the repo has none. */
  readonly commit: string | null;
  /** The skill's folder relative to the repo's top, with forward slashes; '' for the top itself. */
  readonly path: string;
}

/** How many characters of the commit id are kept, as git's short ids show them. */
export const SHORT_COMMIT = 7;

/** `host/owner/repo` for a remote URL, without its scheme, user, password, port or `.git`; null for a local one. */
export function repoOf(remote: string): string | null {
  // Credentials in a URL are dropped before it's read: they must never reach the library.
  const withoutUser = remote.trim().replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@/, '$1');
  const parsed = parseGitUrl(withoutUser);
  return parsed.ok ? parsed.value.key : null;
}

/** The `metadata.source` value, or null when the source has no remote to name. */
export function sourceRecord(facts: SourceFacts): string | null {
  if (facts.remote === null) return null;
  const repo = repoOf(facts.remote);
  if (repo === null) return null;
  const commit = facts.commit === null ? '' : `@${facts.commit.slice(0, SHORT_COMMIT)}`;
  const path = facts.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return `${repo}${commit}${path === '' ? '' : `:${path}`}`;
}
