// The fake host server (TESTING.md §5): git over HTTPS through `git http-backend` from the bundled git (dugite), for
// any number of bare repos, with a certificate from the test certificate authority. As a `github` or `gitlab` host it
// poses as a GitHub Enterprise Server or a self-managed GitLab, with the API subsets the app uses (fake-host-api.ts),
// and git checks each request's token against the user's permission on the repo; a `plain` host has git only. Server
// hooks refuse pushes to protected branches with each host's own messages. Tests drive it through `state`, the admin
// API (fake-host-state.ts). Without a flavor it's Step 3's skeleton: repos are public unless `tokens` guards them.
import { exec, resolveGitExecPath } from 'dugite';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import { type Authority, createAuthority } from './certs.ts';
import { answerApi } from './fake-host-api.ts';
import { FakeHostState, type HostFlavor, type ProtectionStyle } from './fake-host-state.ts';

export { FakeHostState, type HostFlavor, type ProtectionStyle } from './fake-host-state.ts';

export interface FakeHostRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Whether the request carried a token that the repo accepts (never the header itself). */
  readonly authorized: boolean;
}

export interface FakeHost {
  /** e.g. https://127.0.0.1:53211, or https://github.acme.example for a host with a name. */
  readonly url: string;
  /** What URLs show as the host: its name, or `127.0.0.1:53211`. */
  readonly host: string;
  /** `127.0.0.1:53211`, where the server really listens: for the recording proxy. */
  readonly hostPort: string;
  /** The name of the GitHub API, when the host has one besides its own (`apiHostname`). */
  readonly apiHost: string | undefined;
  /** The server at its real address, for git that a test runs itself, without the proxy. */
  readonly directUrl: string;
  readonly flavor: HostFlavor | null;
  /** The users, tokens, permissions and protections, and the admin API that changes them. */
  readonly state: FakeHostState;
  /** The test certificate authority's certificate: what a client adds to its trusted certificates. */
  readonly caPem: string;
  readonly requests: readonly FakeHostRequest[];
  /** Creates an empty bare repo, e.g. `acme/agent-library`, and returns its clone URL. */
  createRepo(name: string): Promise<string>;
  /** Serves a bare repo a world already built under the host's folder, and returns its clone URL. */
  adoptRepo(name: string): string;
  /** The bare repo's folder. */
  repoPath(name: string): string;
  /** The repo's clone URL. */
  repoUrl(name: string): string;
  deleteRepo(name: string): void;
  /**
   * Protects a branch: the server's hook then rejects pushes to it with that host's own messages (TESTING.md §5
   * "Server hooks"). `github` uses classic branch protection (GH006), `github-rules` a ruleset (GH013) that `bypass`
   * may skip. On a flavored host, the users the host lets through still push.
   */
  protectBranch(repo: string, branch: string, style: ProtectionStyle, bypass?: readonly string[]): void;
  unprotectBranch(repo: string, branch: string): void;
  close(): Promise<void>;
}

/** What GitHub and GitLab print when a push to a protected branch is refused (as of 2026). */
export function protectedBranchMessage(style: ProtectionStyle, branch: string): string[] {
  switch (style) {
    case 'github':
      return [
        `error: GH006: Protected branch update failed for refs/heads/${branch}.`,
        'error: Changes must be made through a pull request.',
      ];
    case 'github-rules':
      return [
        `error: GH013: Repository rule violations found for refs/heads/${branch}.`,
        'Review all repository rules at https://github.com/acme/agent-library/rules?ref=refs%2Fheads%2Fmain',
        '',
        '- Changes must be made through a pull request.',
      ];
    case 'gitlab':
      return ['GitLab: You are not allowed to push code to protected branches on this project.'];
  }
}

const shQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** What GitHub and GitLab print when a push has commits without a verified signature (as of 2026). */
export function unsignedMessage(flavor: HostFlavor, branch: string): string[] {
  switch (flavor) {
    case 'gitlab':
      return ['GitLab: Commit must be signed with a GPG key'];
    case 'github':
      return [
        `error: GH013: Repository rule violations found for refs/heads/${branch}.`,
        '',
        '- Commits must have verified signatures.',
      ];
    case 'plain':
      return [`error: refusing an unsigned commit on ${branch}`];
  }
}

/**
 * The part of the hook that refuses commits without a signature by a registered key: every new commit is checked with
 * `git verify-commit` against the host's allowed signers (its users' signing keys).
 */
function signingCheck(flavor: HostFlavor, signers: string): string {
  // The branch is the shell's: each line is quoted, with the variable left out of the quotes.
  const echo = unsignedMessage(flavor, '\0')
    .map((line) => `      echo ${shQuote(line).replaceAll('\0', `'"$branch"'`)} >&2`)
    .join('\n');
  return [
    'zero=0000000000000000000000000000000000000000',
    'while read old new ref; do',
    '  [ "$new" = "$zero" ] && continue',
    '  branch=${ref#refs/heads/}',
    '  for commit in $(git rev-list "$new" --not --all); do',
    `    if ! git -c gpg.ssh.allowedSignersFile=${shQuote(signers)} verify-commit "$commit" >/dev/null 2>&1; then`,
    echo,
    '      exit 1',
    '    fi',
    '  done',
    'done',
  ].join('\n');
}

/**
 * A post-receive hook (POSIX sh) that sends the link to make a change request with the push of a new branch, in the
 * host's own words (ADR 0032, as of 2026): GitHub's, GitLab's, and on a plain host Gitea's.
 */
export function postReceiveHook(flavor: HostFlavor, repoWeb: string, defaultBranch: string): string {
  const say = (line: string) => `  echo "${line}"`;
  const message =
    flavor === 'github'
      ? [
          say(''),
          say(`Create a pull request for '$branch' on GitHub by visiting:`),
          say(`     ${repoWeb}/pull/new/$branch`),
          say(''),
        ]
      : flavor === 'gitlab'
        ? [
            say(''),
            say('To create a merge request for $branch, visit:'),
            say(`  ${repoWeb}/-/merge_requests/new?merge_request%5Bsource_branch%5D=$encoded`),
            say(''),
          ]
        : [
            say(''),
            say(`Create a new pull request for '$branch':`),
            say(`  ${repoWeb}/compare/${defaultBranch}...$branch`),
            say(''),
          ];
  return [
    '#!/bin/sh',
    '# Written by the fake host server: the change request link (ADR 0032).',
    'zero=0000000000000000000000000000000000000000',
    'while read old new ref; do',
    '  [ "$new" = "$zero" ] && continue',
    '  branch=${ref#refs/heads/}',
    `  [ "$branch" = ${shQuote(defaultBranch)} ] && continue`,
    `  encoded=$(printf %s "$branch" | sed 's#/#%2F#g')`,
    ...message,
    'done',
    '',
  ].join('\n');
}

/** A pre-receive hook (POSIX sh) that refuses pushes to the protected branches, except by the users allowed. */
function preReceiveHook(rules: ReadonlyArray<{ branch: string; style: ProtectionStyle; allowed: readonly string[] }>) {
  const cases = rules
    .map(({ branch, style, allowed }) => {
      const lines = protectedBranchMessage(style, branch).map((line) => `        echo ${shQuote(line)} >&2`);
      return [
        `    ${shQuote(`refs/heads/${branch}`)})`,
        `      case ${shQuote(` ${allowed.join(' ')} `)} in`,
        `        *" $REMOTE_USER "*) ;;`,
        `        *)`,
        ...lines,
        `        status=1 ;;`,
        `      esac ;;`,
      ].join('\n');
    })
    .join('\n');
  return `status=0\nwhile read old new ref; do\n  case "$ref" in\n${cases}\n  esac\ndone <"$input"\n[ $status -eq 0 ] || exit $status\n`;
}

export interface FakeHostOptions {
  /** The folder the bare repos live in. */
  readonly root: string;
  /** github or gitlab: the API and per-user git access; plain: tokens and deploy tokens for git only. */
  readonly flavor?: HostFlavor;
  /** Step 3's skeleton: a path prefix (e.g. `/acme/`) → the Authorization header its repos require. */
  readonly tokens?: Readonly<Record<string, string>>;
  readonly authority?: Authority;
  /** The host's clock, for token expiry: tests pass the test clock (TESTING.md §6). */
  readonly now?: () => number;
  /**
   * A name to serve as, e.g. `github.acme.example`: clients reach it through the recording proxy, which connects the
   * name to the real port (`RecordingProxy.alias`). Its certificate covers the name.
   */
  readonly hostname?: string;
  /**
   * A second name for the GitHub API, e.g. `api.github.com`. A request to it is an API request without the `/api/v3`
   * prefix, as github.com has it. With `hostname: 'github.com'` the host then serves as the real service, so that the
   * app takes it for github.com and not for a self-hosted server.
   */
  readonly apiHostname?: string;
}

/** Git on the server side, isolated from this computer's git configuration. */
function serverGitEnv(root: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    GIT_EXEC_PATH: resolveGitExecPath(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, '.server-gitconfig'),
  };
}

/** Splits a CGI response into its status, headers and the start of its body. */
function parseCgiHead(head: Buffer): { status: number; headers: Record<string, string>; body: Buffer } | undefined {
  const crlf = head.indexOf('\r\n\r\n');
  const lf = head.indexOf('\n\n');
  const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf;
  if (end < 0) return undefined;
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of head.subarray(0, end).toString('latin1').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
    else headers[name] = value;
  }
  return { status, headers, body: head.subarray(end + (end === crlf ? 4 : 2)) };
}

/** The token in an Authorization header: Basic's password (any user name), or a Bearer token. */
function tokenFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const basic = /^Basic (.+)$/i.exec(header);
  if (basic) {
    const decoded = Buffer.from(basic[1] ?? '', 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  return /^Bearer (.+)$/i.exec(header)?.[1];
}

/** `/acme/agent-library.git/info/refs` → `acme/agent-library`. */
function repoOf(pathname: string): string | undefined {
  const match = /^\/(.+?)\.git(\/|$)/.exec(decodeURIComponent(pathname));
  return match?.[1];
}

export async function startFakeHost(options: FakeHostOptions): Promise<FakeHost> {
  const authority = options.authority ?? createAuthority();
  const root = path.resolve(options.root);
  const flavor = options.flavor ?? null;
  const state = new FakeHostState(flavor ?? 'plain');
  if (options.now) state.now = options.now;
  const repoPath = (name: string) => path.join(root, `${name}.git`);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, '.server-gitconfig'), '');
  const backend = path.join(
    resolveGitExecPath(),
    process.platform === 'win32' ? 'git-http-backend.exe' : 'git-http-backend',
  );
  const requests: FakeHostRequest[] = [];
  const signers = path.join(root, '.allowed-signers');
  /** The address the app reaches the server at: set once it listens. The request links name it. */
  let publicUrl = '';
  const writeHooks = () => {
    writeFileSync(signers, state.allowedSigners());
    for (const repo of state.permissions.keys()) {
      const hook = path.join(repoPath(repo), 'hooks', 'post-receive');
      if (!existsSync(path.dirname(hook))) continue;
      if (state.requestLinks && publicUrl !== '') {
        const lines = postReceiveHook(state.flavor, `${publicUrl}/${repo}`, state.defaultBranch(repo));
        writeFileSync(hook, lines, { mode: 0o755 });
      } else rmSync(hook, { force: true });
    }
    const repos = new Set([...state.protections.keys(), ...state.signing.keys()]);
    for (const repo of repos) {
      const rules = [...(state.protections.get(repo) ?? [])].map(([branch, protection]) => ({
        branch,
        style: protection.style,
        allowed: [...state.users.keys()].filter(
          (login) => flavor !== null && state.access(repo, login).write && state.mayPushProtected(repo, branch, login),
        ),
      }));
      const parts = [
        '#!/bin/sh',
        '# Written by the fake host server: protected branches and signed commits.',
        // The ref updates are read twice: kept in a file.
        'input=$(mktemp)',
        'trap \'rm -f "$input"\' EXIT',
        'cat >"$input"',
        preReceiveHook(rules),
        ...(state.signing.has(repo) ? [`${signingCheck(state.flavor, signers)} <"$input"`] : []),
        'exit 0',
        '',
      ];
      const hook = path.join(repoPath(repo), 'hooks', 'pre-receive');
      mkdirSync(path.dirname(hook), { recursive: true });
      writeFileSync(hook, parts.join('\n'), { mode: 0o755 });
    }
  };
  state.onChange = writeHooks;
  /** Who this git request is, and whether it may go on; a refusal is the status to answer. */
  const gitAccess = (
    pathname: string,
    search: string,
    header: string | undefined,
  ): { status: 200; user: string } | { status: 401 | 403 | 404 } => {
    if (flavor === null) {
      const prefix = Object.keys(options.tokens ?? {}).find((p) => pathname.startsWith(p));
      const required = prefix === undefined ? undefined : options.tokens?.[prefix];
      return required === undefined || header === required ? { status: 200, user: 'fake-host' } : { status: 401 };
    }
    const repo = repoOf(pathname);
    const token = state.validToken(tokenFrom(header));
    if (!token) return { status: 401 };
    const pushing = pathname.endsWith('/git-receive-pack') || /(^|&)service=git-receive-pack(&|$)/.test(search);
    let read: boolean;
    let write: boolean;
    if (token.deploy) {
      read = token.deploy.repo === repo;
      write = read && token.deploy.write;
    } else {
      const login = token.login ?? '';
      const access = repo === undefined ? { read: false, write: false } : state.access(repo, login);
      // A GitHub App's token reaches only repos the app is installed on; a personal token isn't an app's.
      const reaches = token.clientId === null || repo === undefined || state.appReaches(repo);
      read = access.read && reaches;
      write = access.write && reaches;
    }
    if (!read) return { status: 404 };
    if (pushing && !write) return { status: 403 };
    return { status: 200, user: token.login ?? 'deploy' };
  };

  const sockets = new Set<Socket>();
  const { certPem, keyPem } = authority.issue([
    '127.0.0.1',
    'localhost',
    ...(options.hostname ? [options.hostname] : []),
    ...(options.apiHostname ? [options.apiHostname] : []),
  ]);
  const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://fake-host.invalid');
    if (state.offline) {
      req.socket.destroy();
      return;
    }
    const failure = state.takeFailure(url.pathname);
    if (failure !== undefined) {
      requests.push({ method: req.method ?? '', path: url.pathname, status: failure, authorized: false });
      res.writeHead(failure, { 'content-type': 'application/json' }).end('{"message":"injected failure"}');
      return;
    }
    const chunks: Buffer[] = [];
    const isGit = repoOf(url.pathname) !== undefined;
    if (!isGit) {
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const asked = (req.headers.host ?? '').split(':')[0];
        const apiPath =
          options.apiHostname !== undefined && asked === options.apiHostname ? `/api/v3${url.pathname}` : url.pathname;
        void answerApi(state, {
          method: req.method ?? 'GET',
          path: apiPath,
          query: url.searchParams,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          origin: `https://${req.headers.host ?? '127.0.0.1'}`,
        })
          .catch((error: unknown) => ({ status: 500, body: { message: String(error) } }))
          .then((found) => {
            const answer = found ?? { status: 404, body: { message: 'Not Found' } };
            requests.push({ method: req.method ?? '', path: url.pathname, status: answer.status, authorized: true });
            res.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(answer.body));
          });
      });
      return;
    }

    req.pause();
    void state.whenGitAllowed().then(() => serveGit(req, res, url));
  });

  // The request stays paused until it's piped to git (or drained when it's refused), so no body is lost while held.
  const serveGit = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const access = gitAccess(url.pathname, url.search.slice(1), req.headers.authorization);
    const record = (status: number) =>
      requests.push({ method: req.method ?? '', path: url.pathname, status, authorized: access.status === 200 });
    if (access.status !== 200) {
      record(access.status);
      req.resume();
      if (access.status === 401) res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake host"' });
      else res.writeHead(access.status, { 'content-type': 'text/plain' });
      res.end(access.status === 403 ? 'Write access to this repository is not granted.\n' : 'Repository not found.\n');
      return;
    }

    const cgi = spawn(backend, [], {
      env: {
        ...serverGitEnv(root),
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
        // A user name turns on pushes (receive-pack) in git http-backend; the hooks see who pushes.
        REMOTE_USER: access.user,
        REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
      },
    });
    cgi.on('error', () => {
      record(500);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (started) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const parsed = parseCgiHead(head);
      if (!parsed) return;
      started = true;
      record(parsed.status);
      res.writeHead(parsed.status, parsed.headers);
      if (parsed.body.length > 0) res.write(parsed.body);
    });
    cgi.stdout.on('end', () => res.end());
    cgi.stderr.resume();
  };
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const directUrl = `https://127.0.0.1:${port}`;
  const url = options.hostname ? `https://${options.hostname}` : directUrl;
  publicUrl = url;
  return {
    url,
    host: options.hostname ?? `127.0.0.1:${port}`,
    hostPort: `127.0.0.1:${port}`,
    apiHost: options.apiHostname,
    directUrl,
    flavor,
    state,
    caPem: authority.certPem,
    requests,
    repoPath,
    repoUrl: (name) => `${url}/${name}.git`,
    async createRepo(name) {
      mkdirSync(path.dirname(repoPath(name)), { recursive: true });
      const result = await exec(['init', '--bare', '--initial-branch=main', repoPath(name)], root, {
        env: serverGitEnv(root),
      });
      if (result.exitCode !== 0) throw new Error(`git init --bare failed: ${result.stderr}`);
      if (!state.permissions.has(name)) state.permissions.set(name, new Map());
      writeHooks();
      return `${url}/${name}.git`;
    },
    adoptRepo(name) {
      if (!state.permissions.has(name)) state.permissions.set(name, new Map());
      writeHooks();
      return `${url}/${name}.git`;
    },
    deleteRepo(name) {
      rmSync(repoPath(name), { recursive: true, force: true });
      state.permissions.delete(name);
    },
    protectBranch(repo, branch, style, bypass = []) {
      state.protect(repo, branch, style, bypass);
    },
    unprotectBranch(repo, branch) {
      state.unprotect(repo, branch);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
