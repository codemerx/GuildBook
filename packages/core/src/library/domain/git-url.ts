// Git URLs (PLAN.md §3.1, §3.15). Only `https://` and the SSH forms (`ssh://…`, `user@host:path`) are accepted, and they
// are checked before anything runs: no other transport (`ext::`, `file://`, `git://`, `http://`), nothing starting with
// `-`, no local paths, no credentials in the URL, no whitespace or control characters, no query or fragment.
// Two URLs name the same library when their keys are equal: the host in lowercase and the path, ignoring the scheme,
// the user name, the port, a trailing `.git` and a trailing slash.
import type { Branded } from '../../shared/brand.ts';
import { err, ok, type Result } from '../../shared/result.ts';

export type GitUrlKey = Branded<string, 'GitUrlKey'>;

export type GitUrlProblem =
  | 'gitUrl.empty'
  | 'gitUrl.leadingDash'
  | 'gitUrl.transport'
  | 'gitUrl.localPath'
  | 'gitUrl.characters'
  | 'gitUrl.credentials'
  | 'gitUrl.host'
  | 'gitUrl.port'
  | 'gitUrl.user'
  | 'gitUrl.path';

export interface GitUrl {
  /** The URL as given, trimmed. Git gets exactly this. */
  readonly url: string;
  readonly transport: 'https' | 'ssh';
  /** The host in lowercase, e.g. `github.com`. */
  readonly host: string;
  readonly port: number | null;
  readonly user: string | null;
  /** The repository's path without a trailing `.git` or slashes, e.g. `acme/agent-library`. */
  readonly path: string;
  /** The first part of the path: the organization or group, e.g. `acme` (PLAN.md §3.16 default library folder). */
  readonly owner: string;
  /** The last part of the path, e.g. `agent-library`. */
  readonly name: string;
  /** host/path: equal for every form of the same repository. */
  readonly key: GitUrlKey;
}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/;
const USER = /^[A-Za-z0-9._~+-]+$/;
// Characters a repository path may hold; `%` only as an escape of two hex digits.
const PATH_SEGMENT = /^(?:[A-Za-z0-9._~@+-]|%[0-9A-Fa-f]{2})+$/;

export function parseGitUrl(input: string): Result<GitUrl, GitUrlProblem> {
  const url = input.trim();
  if (url === '') return err('gitUrl.empty');
  if (url.startsWith('-')) return err('gitUrl.leadingDash');
  // eslint-disable-next-line no-control-regex -- control characters are refused
  if (/[\s\x00-\x1f\x7f\\]/.test(url)) return err('gitUrl.characters');
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) return err('gitUrl.transport');

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme) {
    const name = (scheme[1] ?? '').toLowerCase();
    if (name !== 'https' && name !== 'ssh') return err('gitUrl.transport');
    return parseHierarchical(url, name, url.slice(scheme[0].length));
  }
  // The scp-like form `[user@]host:path`. Git reads a colon after a slash, or a one-letter "host" (a Windows drive),
  // as a local path.
  const colon = url.indexOf(':');
  if (colon < 0 || url.slice(0, colon).includes('/') || /^[A-Za-z]:/.test(url)) return err('gitUrl.localPath');
  const authority = url.slice(0, colon);
  const at = authority.lastIndexOf('@');
  const user = at >= 0 ? authority.slice(0, at) : null;
  const host = at >= 0 ? authority.slice(at + 1) : authority;
  return build(url, 'ssh', host, null, user, url.slice(colon + 1));
}

function parseHierarchical(url: string, transport: 'https' | 'ssh', rest: string): Result<GitUrl, GitUrlProblem> {
  if (/[?#]/.test(rest)) return err('gitUrl.characters');
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '' : rest.slice(slash + 1);
  const at = authority.lastIndexOf('@');
  const userInfo = at >= 0 ? authority.slice(0, at) : null;
  if (userInfo !== null && userInfo.includes(':')) return err('gitUrl.credentials');
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  let host = hostPort;
  let port: number | null = null;
  const bracket = hostPort.startsWith('[') ? hostPort.indexOf(']') : -1;
  const portStart = bracket >= 0 ? hostPort.indexOf(':', bracket) : hostPort.lastIndexOf(':');
  if (portStart >= 0) {
    host = hostPort.slice(0, portStart);
    const digits = hostPort.slice(portStart + 1);
    if (!/^\d{1,5}$/.test(digits) || Number(digits) < 1 || Number(digits) > 65535) return err('gitUrl.port');
    port = Number(digits);
  }
  return build(url, transport, host, port, userInfo, path);
}

function build(
  url: string,
  transport: 'https' | 'ssh',
  rawHost: string,
  port: number | null,
  user: string | null,
  rawPath: string,
): Result<GitUrl, GitUrlProblem> {
  // A user name starting with `-` would reach ssh as an option.
  if (user !== null && (!USER.test(user) || user.startsWith('-'))) return err('gitUrl.user');
  const host = rawHost.toLowerCase();
  const validHost = IPV6.test(host) || (host.length <= 253 && host.split('.').every((label) => HOST_LABEL.test(label)));
  if (!validHost) return err('gitUrl.host');
  let path = rawPath.replace(/\/+$/, '');
  if (path.toLowerCase().endsWith('.git')) path = path.slice(0, -4).replace(/\/+$/, '');
  path = path.replace(/^\/+/, '');
  const segments = path.split('/');
  if (
    path === '' ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment)) ||
    segments[0]?.startsWith('-')
  ) {
    return err('gitUrl.path');
  }
  return ok({
    url,
    transport,
    host,
    port,
    user,
    path,
    owner: segments[0] ?? path,
    name: segments.at(-1) ?? path,
    key: `${host}/${path}` as GitUrlKey,
  });
}

/** Whether two URLs name the same repository (PLAN.md §3.1). */
export function sameRepository(a: GitUrl, b: GitUrl): boolean {
  return a.key === b.key;
}
