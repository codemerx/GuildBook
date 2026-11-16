// The API subsets the app uses (TESTING.md §5), as a GitHub Enterprise Server (`/api/v3`, OAuth at the root) and as a
// self-managed GitLab (`/api/v4`, `/oauth`). Shapes follow the hosts' documented JSON, reduced to the fields the
// adapters read. The nightly live tests compare them with the real hosts (postponed with the test organizations).
import type { FakeHostState, FakeToken, FakeUser } from './fake-host-state.ts';

export interface ApiAnswer {
  readonly status: number;
  readonly body: unknown;
}

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  /** The server's own address, for the verification URI. */
  readonly origin: string;
}

const json = (status: number, body: unknown): ApiAnswer => ({ status, body });

/** The form or JSON body of an OAuth request. */
function fields(request: ApiRequest): URLSearchParams {
  const type = String(request.headers['content-type'] ?? '');
  if (type.includes('json')) {
    try {
      return new URLSearchParams(JSON.parse(request.body) as Record<string, string>);
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(request.body);
}

function bearer(state: FakeHostState, request: ApiRequest): FakeToken | undefined {
  const header = String(request.headers.authorization ?? '');
  const match = /^(?:Bearer|token) (.+)$/i.exec(header);
  return state.validToken(match?.[1]);
}

/** Answers an API or OAuth request, or returns undefined when the path is git's. */
export async function answerApi(state: FakeHostState, request: ApiRequest): Promise<ApiAnswer | undefined> {
  if (state.flavor === 'github') return github(state, request);
  if (state.flavor === 'gitlab') return gitlab(state, request);
  return undefined;
}

function bodyJson(request: ApiRequest): Record<string, unknown> {
  try {
    const parsed = JSON.parse(request.body) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

// ---- Device flow, shared by both ---------------------------------------------------------------------------------

function startDevice(state: FakeHostState, request: ApiRequest, verificationPath: string): ApiAnswer {
  const clientId = fields(request).get('client_id') ?? '';
  if (!state.knowsClient(clientId)) {
    return state.flavor === 'github'
      ? json(404, { message: 'Not Found' })
      : json(401, { error: 'invalid_client', error_description: 'Client authentication failed' });
  }
  const device = state.startDevice(clientId);
  return json(200, {
    device_code: device.deviceCode,
    user_code: device.userCode,
    verification_uri: `${request.origin}${verificationPath}`,
    ...(state.flavor === 'gitlab'
      ? { verification_uri_complete: `${request.origin}${verificationPath}?user_code=${device.userCode}` }
      : {}),
    expires_in: Math.round((device.expiresAt - state.now()) / 1000),
    interval: state.pollInterval,
  });
}

/** GitHub answers OAuth errors with 200, GitLab with 400. */
function oauthError(state: FakeHostState, error: string): ApiAnswer {
  return json(state.flavor === 'github' ? 200 : 400, { error, error_description: error });
}

function tokenAnswer(state: FakeHostState, token: FakeToken): ApiAnswer {
  const expiresIn = token.expiresAt === null ? undefined : Math.round((token.expiresAt - state.now()) / 1000);
  return json(200, {
    access_token: token.token,
    token_type: state.flavor === 'github' ? 'bearer' : 'Bearer',
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
    ...(token.refreshToken ? { refresh_token: token.refreshToken } : {}),
    ...(state.flavor === 'github' && token.refreshToken ? { refresh_token_expires_in: 15_897_600 } : {}),
    scope: state.flavor === 'gitlab' ? 'api' : '',
  });
}

function exchange(state: FakeHostState, request: ApiRequest): ApiAnswer {
  const form = fields(request);
  const clientId = form.get('client_id') ?? '';
  const grant = form.get('grant_type');
  if (grant === 'refresh_token') {
    const renewed = state.refresh(form.get('refresh_token') ?? '', clientId);
    return renewed
      ? tokenAnswer(state, renewed)
      : oauthError(state, state.flavor === 'github' ? 'bad_refresh_token' : 'invalid_grant');
  }
  if (grant !== 'urn:ietf:params:oauth:grant-type:device_code') return oauthError(state, 'unsupported_grant_type');
  const device = state.devices.get(form.get('device_code') ?? '');
  if (!device || device.clientId !== clientId) return oauthError(state, 'incorrect_device_code');
  device.polls++;
  if (device.expiresAt <= state.now()) return oauthError(state, 'expired_token');
  if (device.denied) return oauthError(state, 'access_denied');
  if (!device.approvedBy) return oauthError(state, 'authorization_pending');
  state.devices.delete(device.deviceCode);
  return tokenAnswer(state, state.issueToken(device.approvedBy, { clientId }));
}

// ---- GitHub ------------------------------------------------------------------------------------------------------

const GITHUB_ROLES = ['none', 'read', 'write', 'maintain', 'admin'];

async function github(state: FakeHostState, request: ApiRequest): Promise<ApiAnswer | undefined> {
  const { method, path } = request;
  if (method === 'POST' && path === '/login/device/code') return startDevice(state, request, '/login/device');
  if (method === 'POST' && path === '/login/oauth/access_token') return exchange(state, request);
  if (!path.startsWith('/api/v3/')) return undefined;
  const api = path.slice('/api/v3'.length);
  if (api === '/meta') return json(200, { installed_version: '3.17.0', verifiable_password_authentication: false });
  const token = bearer(state, request);
  if (!token?.login) return json(401, { message: 'Bad credentials', status: '401' });
  const user = state.users.get(token.login);
  if (!user) return json(401, { message: 'Bad credentials', status: '401' });
  const notFound = json(404, { message: 'Not Found', status: '404' });

  if (api === '/user') return json(200, { login: user.login, id: user.id, name: user.name, email: null });
  if (api === '/user/ssh_signing_keys') {
    if (method === 'POST') {
      const body = bodyJson(request);
      const key = str(body.key).trim();
      if (!/^(ssh-|ecdsa-|sk-)\S+ \S+/.test(key)) return json(422, { message: 'Validation Failed' });
      const known = (state.signingKeys.get(user.login) ?? []).some((k) => k.key.split(' ')[1] === key.split(' ')[1]);
      if (known) return json(422, { message: 'Validation Failed', errors: [{ message: 'key is already in use' }] });
      const added = state.addSigningKey(user.login, str(body.title), key);
      return json(201, { id: added.id, title: added.title, key: added.key });
    }
    return json(
      200,
      (state.signingKeys.get(user.login) ?? []).map((k) => ({ id: k.id, title: k.title, key: k.key })),
    );
  }
  if (api === '/user/emails') {
    const visibility = user.privateEmail ? 'private' : 'public';
    return json(200, [{ email: user.email, primary: true, verified: true, visibility }]);
  }
  if (api === '/user/installations') {
    const installations = [...state.installations.values()].filter((i) =>
      [...state.permissions].some(([repo, logins]) => repo.split('/')[0] === i.owner && logins.has(user.login)),
    );
    return json(200, {
      total_count: installations.length,
      installations: installations.map((i) => ({
        id: i.id,
        account: { login: i.owner, type: 'Organization' },
        repository_selection: i.repos === null ? 'all' : 'selected',
      })),
    });
  }
  const installationRepos = /^\/user\/installations\/(\d+)\/repositories$/.exec(api);
  if (installationRepos) {
    const installation = [...state.installations.values()].find((i) => String(i.id) === installationRepos[1]);
    if (!installation) return notFound;
    const names =
      installation.repos ??
      [...state.permissions.keys()]
        .filter((r) => r.startsWith(`${installation.owner}/`))
        .map((r) => r.split('/')[1] ?? '');
    const visible = names.filter((name) => state.access(`${installation.owner}/${name}`, user.login).read);
    return json(200, {
      total_count: visible.length,
      repositories: visible.map((name) => ({ name, full_name: `${installation.owner}/${name}` })),
    });
  }

  const repoRoute = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(api);
  if (!repoRoute) return notFound;
  const repo = `${decodeURIComponent(repoRoute[1] ?? '')}/${decodeURIComponent(repoRoute[2] ?? '')}`;
  const rest = repoRoute[3] ?? '';
  // A GitHub App's user token reaches only repos the app is installed on, and only those the user can see.
  if (!state.permissions.has(repo) || !state.access(repo, user.login).read || !state.appReaches(repo)) return notFound;
  const permission = state.permission(repo, user.login);
  const rank = GITHUB_ROLES.indexOf(String(permission));
  if (rest === '') {
    return json(200, {
      name: repo.split('/')[1],
      full_name: repo,
      private: true,
      default_branch: state.defaultBranch(repo),
      size: 12,
      permissions: { admin: rank >= 4, maintain: rank >= 3, push: rank >= 2, triage: rank >= 2, pull: rank >= 1 },
    });
  }
  const rules = /^\/rules\/branches\/(.+)$/.exec(rest);
  if (rules) {
    const protection = state.protections.get(repo)?.get(decodeURIComponent(rules[1] ?? ''));
    const signing = state.signing.get(repo)?.readable
      ? [{ type: 'required_signatures', ruleset_source_type: 'Repository', ruleset_source: repo, ruleset_id: 999 }]
      : [];
    // Only rulesets can be read here; classic branch protection needs "Administration: read" (PLAN.md §3.11).
    if (!protection || protection.style !== 'github-rules') return json(200, signing);
    return json(200, [
      {
        type: 'pull_request',
        ruleset_source_type: 'Repository',
        ruleset_source: repo,
        ruleset_id: protection.rulesetId,
        parameters: { required_approving_review_count: 1 },
      },
      ...signing,
    ]);
  }
  const branch = /^\/branches\/(.+)$/.exec(rest);
  if (branch) {
    const name = decodeURIComponent(branch[1] ?? '');
    return json(200, { name, protected: state.protections.get(repo)?.has(name) ?? false });
  }
  const ruleset = /^\/rulesets\/(\d+)$/.exec(rest);
  if (ruleset) {
    const protection = [...(state.protections.get(repo)?.values() ?? [])].find(
      (p) => String(p.rulesetId) === ruleset[1],
    );
    if (!protection) return notFound;
    return json(200, {
      id: protection.rulesetId,
      name: 'Protect main',
      target: 'branch',
      enforcement: 'active',
      current_user_can_bypass: protection.bypass.includes(user.login) ? 'always' : 'never',
    });
  }
  return notFound;
}

async function gitlab(state: FakeHostState, request: ApiRequest): Promise<ApiAnswer | undefined> {
  const { method, path } = request;
  if (method === 'POST' && path === '/oauth/authorize_device') return startDevice(state, request, '/oauth/device');
  if (method === 'POST' && path === '/oauth/token') return exchange(state, request);
  if (!path.startsWith('/api/v4/')) return undefined;
  const api = path.slice('/api/v4'.length);
  const token = bearer(state, request);
  const unauthorized = json(401, { message: '401 Unauthorized' });
  if (!token?.login) return unauthorized;
  const user = state.users.get(token.login);
  if (!user) return unauthorized;
  if (api === '/version') return json(200, { version: '18.4.0', revision: 'fake' });
  if (api === '/user') {
    return json(200, {
      id: user.id,
      username: user.login,
      name: user.name,
      email: user.email,
      commit_email: user.email,
      public_email: '',
    });
  }
  const projects = [...state.permissions.keys()];
  const projectById = (id: string) => projects.find((_, index) => String(index + 1) === id);
  const notFound = json(404, { message: '404 Project Not Found' });
  if (api === '/user/keys') {
    if (method === 'POST') {
      const body = bodyJson(request);
      const key = str(body.key).trim();
      const known = (state.signingKeys.get(user.login) ?? []).some((k) => k.key.split(' ')[1] === key.split(' ')[1]);
      if (known) return json(400, { message: { key: ['has already been taken'] } });
      if (str(body.usage_type) !== 'signing' && str(body.usage_type) !== 'auth_and_signing') {
        return json(201, {
          id: 0,
          title: str(body.title),
          key,
          usage_type: str(body.usage_type) || 'auth_and_signing',
        });
      }
      const added = state.addSigningKey(user.login, str(body.title), key);
      return json(201, { id: added.id, title: added.title, key: added.key, usage_type: 'signing' });
    }
    return json(
      200,
      (state.signingKeys.get(user.login) ?? []).map((k) => ({
        id: k.id,
        title: k.title,
        key: k.key,
        usage_type: 'signing',
      })),
    );
  }
  const nested = /^\/projects\/([^/]+)(\/.+)$/.exec(api);
  if (nested && !/^\d+$/.test(decodeURIComponent(nested[1] ?? '')) && !nested[2]?.startsWith('/members/')) {
    const key = decodeURIComponent(nested[1] ?? '');
    const repo = projects.includes(key) ? key : undefined;
    if (repo) {
      const answer = await gitlabProject(state, request, repo, nested[2] ?? '', user);
      if (answer) return answer;
    }
  } else if (nested) {
    const repo = projectById(decodeURIComponent(nested[1] ?? ''));
    if (repo && !nested[2]?.startsWith('/members/') && !nested[2]?.startsWith('/repository/')) {
      const answer = await gitlabProject(state, request, repo, nested[2] ?? '', user);
      if (answer) return answer;
    }
  }

  const project = /^\/projects\/([^/]+)$/.exec(api);
  if (project) {
    const key = decodeURIComponent(project[1] ?? '');
    const repo = projects.includes(key) ? key : projectById(key);
    if (!repo) return notFound;
    const level = state.permission(repo, user.login);
    const numeric = typeof level === 'number' ? level : 0;
    if (numeric < 10) return notFound;
    return json(200, {
      id: projects.indexOf(repo) + 1,
      path_with_namespace: repo,
      default_branch: state.defaultBranch(repo),
      // GitLab shows a Guest's access level here; the custom role is on the member.
      permissions: { project_access: { access_level: numeric, notification_level: 3 }, group_access: null },
    });
  }
  const member = /^\/projects\/(\d+)\/members\/all\/(\d+)$/.exec(api);
  if (member) {
    const repo = projectById(member[1] ?? '');
    const target = [...state.users.values()].find((u) => String(u.id) === member[2]);
    if (!repo || !target) return notFound;
    const level = state.permission(repo, target.login);
    if (typeof level !== 'number' || level < 10) return json(404, { message: '404 Not found' });
    const readCode = state.readCode.get(repo)?.has(target.login) ?? false;
    return json(200, {
      id: target.id,
      username: target.login,
      access_level: level,
      member_role: readCode ? { id: 7, name: 'Code reader', base_access_level: 10, read_code: true } : null,
    });
  }
  const branch = /^\/projects\/(\d+)\/repository\/branches\/(.+)$/.exec(api);
  if (branch) {
    const repo = projectById(branch[1] ?? '');
    if (!repo || !state.access(repo, user.login).read) return json(403, { message: '403 Forbidden' });
    const name = decodeURIComponent(branch[2] ?? '');
    const protectedBranch = state.protections.get(repo)?.has(name) ?? false;
    const canPush = state.access(repo, user.login).write && state.mayPushProtected(repo, name, user.login);
    return json(200, { name, protected: protectedBranch, developers_can_push: !protectedBranch, can_push: canPush });
  }
  return notFound;
}

/** The push rule (TESTING.md §5 "The GitLab API subset"). */
async function gitlabProject(
  state: FakeHostState,
  _request: ApiRequest,
  repo: string,
  rest: string,
  user: FakeUser,
): Promise<ApiAnswer | undefined> {
  const level = state.permission(repo, user.login);
  const numeric = typeof level === 'number' ? level : 0;
  if (numeric < 10) return json(404, { message: '404 Project Not Found' });
  if (rest === '/push_rule') {
    // Push rules are for Maintainers to read.
    if (numeric < 40) return json(403, { message: '403 Forbidden' });
    const rule = state.signing.get(repo);
    return rule ? json(200, { id: 1, reject_unsigned_commits: true }) : json(404, { message: '404 Not Found' });
  }
  return undefined;
}
