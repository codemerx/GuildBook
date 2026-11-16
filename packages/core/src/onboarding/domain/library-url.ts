// The first wizard page (PLAN.md §3.17 step 1, §3.15): the git URL is checked before anything runs, the host and the
// repo path are shown before cloning (A4.12), and another form of an already-connected URL says so (A4.4).
import { brand } from '@app/brand';
import { type GitUrl, type GitUrlProblem, parseGitUrl } from '../../library/index.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import { err, ok, type Result } from '../../shared/result.ts';

export interface ConnectedLibrary {
  readonly id: string;
  readonly name: string;
  readonly gitUrl: string | null;
}

export type LibraryUrlProblem =
  | { readonly code: GitUrlProblem }
  | { readonly code: 'gitUrl.alreadyConnected'; readonly instanceId: string; readonly name: string };

export interface CheckedLibraryUrl {
  readonly url: GitUrl;
  /** What the page shows: the host (with its port, if any) and the repo path, e.g. `github.com` and `acme/agent-library`. */
  readonly host: string;
  readonly repo: string;
}

export function checkLibraryUrl(
  input: string,
  connected: readonly ConnectedLibrary[],
): Result<CheckedLibraryUrl, LibraryUrlProblem> {
  const parsed = parseGitUrl(input);
  if (!parsed.ok) return err({ code: parsed.error });
  const url = parsed.value;
  for (const library of connected) {
    if (library.gitUrl === null) continue;
    const other = parseGitUrl(library.gitUrl);
    if (other.ok && other.value.key === url.key) {
      return err({ code: 'gitUrl.alreadyConnected', instanceId: library.id, name: library.name });
    }
  }
  return ok({ url, host: url.port === null ? url.host : `${url.host}:${url.port}`, repo: url.path });
}

/** What the UI calls a new library before it has one of its own: the organization in its URL, e.g. "Acme". */
export function libraryName(url: GitUrl): string {
  const owner = decodeURIComponentSafe(url.owner);
  return owner.charAt(0).toUpperCase() + owner.slice(1);
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The default library folder (PLAN.md §3.16, §3.17 step 3): `~/<brand.defaultLibraryFolderName>/<owner>`, named after the organization in
 * the URL, with a number added when that folder exists (`acme-2`, `acme-3`, …). `taken` says whether a path exists.
 */
export function defaultLibraryFolder(
  home: string,
  url: GitUrl,
  paths: PathFlavour,
  taken: (path: string) => boolean,
): string {
  const owner = folderSafe(decodeURIComponentSafe(url.owner));
  const base = paths.join(home, brand.defaultLibraryFolderName);
  for (let n = 1; ; n++) {
    const candidate = paths.join(base, n === 1 ? owner : `${owner}-${n}`);
    if (!taken(candidate)) return candidate;
  }
}

/** A folder name from an organization name: lowercase, with characters no OS allows in names replaced. */
function folderSafe(name: string): string {
  const safe = name
    .toLowerCase()
    // eslint-disable-next-line no-control-regex -- control characters are replaced
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/^\.+/, '');
  return safe === '' ? 'library' : safe;
}
