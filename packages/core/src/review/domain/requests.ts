// Change requests (PLAN.md §3.11, ADR 0032): ordinary branches that the person pushes; the request itself is made,
// reviewed and merged on the host's website. The app only finds the page that makes it: the link the server sent with
// the push, or the page the host kind gives.

export const REQUEST_PREFIX = 'requests/';

export function isRequestBranch(name: string): boolean {
  return name.startsWith(REQUEST_PREFIX) && name.length > REQUEST_PREFIX.length;
}

/** A branch name part: lower case letters, digits and dashes. */
export function slug(text: string): string {
  const cleaned = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return cleaned === '' ? 'changes' : cleaned;
}

/**
 * The branch [Commit to a new branch] suggests (PLAN.md §3.11 step 1): `requests/<who>/<first skill>`, e.g.
 * `requests/john/acme-code-review`, with `-2`, `-3`, … when the name is taken here or on the server.
 */
export function suggestBranch(who: string, skills: readonly string[], taken: ReadonlySet<string>): string {
  const base = `${REQUEST_PREFIX}${slug(who)}/${slug(skills[0] ?? 'changes')}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base}-${n}`;
    if (!taken.has(name)) return name;
  }
}

const ASKS_FOR_REQUEST = /\b(pull|merge) request\b/i;
const ADDRESS = /https?:\/\/[^\s'"<>]+/i;

/**
 * The page to make a change request, from the server's lines of a push (`remote: …`, ADR 0032): the first address on
 * a line that names a pull or merge request, or on the line after it. GitHub, GitLab, Gitea, Forgejo and Bitbucket send
 * one, e.g. "Create a pull request for 'x' on GitHub by visiting:" and the address on the next line. The server's text
 * is untrusted: only an `https:` or `http:` address on the library's own server counts.
 */
export function requestLinkFrom(remoteMessage: string, serverHost: string): string | null {
  const lines = remoteMessage.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!ASKS_FOR_REQUEST.test(lines[i] ?? '')) continue;
    for (const line of [lines[i] ?? '', lines[i + 1] ?? '']) {
      const found = ADDRESS.exec(line)?.[0];
      if (found !== undefined && onServer(found, serverHost)) return found;
    }
  }
  return null;
}

function onServer(address: string, serverHost: string): boolean {
  try {
    const url = new URL(address);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname === serverHost.toLowerCase();
  } catch {
    return false;
  }
}
