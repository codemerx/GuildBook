// GitHub as a GitHub App (PLAN.md §3.17 step 2, ADR 0016), on github.com and on GitHub Enterprise Server. Sign-in is
// the device flow; user tokens expire after 8 hours and are renewed with their refresh token, which needs no client
// secret for the device flow. The role facts come from the repository API's permission flags and the branch rules
// API, which anyone who can read the repo may call (PLAN.md §3.11). An anti-corruption layer: GitHub's JSON stays here.
import {
  AppError,
  type DeviceCode,
  type DevicePoll,
  type GithubFacts,
  type Host,
  type HostAccount,
  type HostCallOptions,
  type HostCapabilities,
  type HostEndpoint,
  type HostSigningKey,
  type HostTokens,
  type RepoAccess,
} from '@app/core';
import { basicAuthHeader } from '../git/git-env.ts';
import { formBody, type HttpClient, type HttpResponse, jsonBody } from '../network/http-client.ts';
import { field, numberField, oauthError, record, safeJson, stringField, textField, tokensFrom } from './json.ts';

export const githubCapabilities: HostCapabilities = {
  deviceFlow: true,
  readableBranchRules: true,
  signingKeyRegistration: true,
};

export class GithubHost implements Host {
  readonly endpoint: HostEndpoint;
  readonly #http: HttpClient;
  readonly #now: () => number;

  constructor(endpoint: HostEndpoint, http: HttpClient, now: () => number) {
    this.endpoint = endpoint;
    this.#http = http;
    this.#now = now;
  }

  capabilities(): HostCapabilities {
    return githubCapabilities;
  }

  async startDeviceFlow(clientId: string, options: HostCallOptions = {}): Promise<DeviceCode> {
    const response = await this.#oauth('/login/device/code', { client_id: clientId }, options);
    if (response.status === 404) throw new AppError('host.notSupported', { feature: 'deviceFlow' });
    const body = record(jsonBody(response));
    const error = oauthError(body);
    if (error || response.status !== 200) {
      throw new AppError('host.requestFailed', { status: response.status, message: error ?? 'device code refused' });
    }
    return {
      deviceCode: stringField(body, 'device_code'),
      userCode: stringField(body, 'user_code'),
      verificationUri: stringField(body, 'verification_uri'),
      intervalMs: (numberField(body, 'interval') ?? 5) * 1000,
      expiresAt: this.#now() + (numberField(body, 'expires_in') ?? 900) * 1000,
    };
  }

  async pollDeviceFlow(clientId: string, deviceCode: string, options: HostCallOptions = {}): Promise<DevicePoll> {
    const response = await this.#oauth(
      '/login/oauth/access_token',
      { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
      options,
    );
    const body = record(jsonBody(response));
    switch (oauthError(body)) {
      case undefined:
        return { kind: 'token', tokens: tokensFrom(body, this.#now()) };
      case 'authorization_pending':
        return { kind: 'pending' };
      case 'slow_down':
        return { kind: 'slowDown', intervalMs: (numberField(body, 'interval') ?? 10) * 1000 };
      case 'access_denied':
        return { kind: 'denied' };
      case 'expired_token':
      case 'token_expired':
        return { kind: 'expired' };
      default:
        throw new AppError('host.requestFailed', { status: response.status, message: oauthError(body) ?? '' });
    }
  }

  async refresh(clientId: string, refreshToken: string, options: HostCallOptions = {}): Promise<HostTokens> {
    const response = await this.#oauth(
      '/login/oauth/access_token',
      { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken },
      options,
    );
    const body = record(jsonBody(response));
    if (oauthError(body) || response.status !== 200) throw new AppError('host.signInAgain', { host: 'github' });
    return tokensFrom(body, this.#now());
  }

  async account(token: string, options: HostCallOptions = {}): Promise<HostAccount> {
    const user = await this.#api('GET', '/user', token, options);
    if (user.status === 401) throw new AppError('host.unauthorized');
    if (user.status !== 200) throw new AppError('host.requestFailed', { status: user.status });
    const body = record(jsonBody(user));
    let email = field(body, 'email');
    if (typeof email !== 'string' || email === '') {
      // A GitHub App reads emails only with the "Email addresses" permission. Only a public address is used: GitHub's
      // email privacy setting refuses a push whose commits carry a private one (PLAN.md §3.10 "Author").
      const emails = await this.#api('GET', '/user/emails', token, options);
      const list = emails.status === 200 ? jsonBody(emails) : [];
      const primary = Array.isArray(list)
        ? list.map(record).find((e) => field(e, 'primary') === true && field(e, 'verified') === true)
        : undefined;
      email = primary && field(primary, 'visibility') !== 'private' ? field(primary, 'email') : null;
    }
    const name = field(body, 'name');
    const login = stringField(body, 'login');
    const id = numberField(body, 'id');
    // The account's no-reply address otherwise: `<id>+<login>@users.noreply.github.com`, or the server's own name on
    // GitHub Enterprise Server.
    const noreply = id === undefined ? null : `${id}+${login}@users.noreply.${new URL(this.endpoint.origin).hostname}`;
    return {
      login,
      name: typeof name === 'string' && name !== '' ? name : null,
      email: typeof email === 'string' && email !== '' ? email : noreply,
    };
  }

  async repoAccess(token: string, repoPath: string, options: HostCallOptions = {}): Promise<RepoAccess> {
    const [owner = '', name = ''] = repoPath.split('/');
    const repo = await this.#api('GET', `/repos/${enc(owner)}/${enc(name)}`, token, options);
    if (repo.status === 401) return { kind: 'unauthorized' };
    if (repo.status === 404 || repo.status === 403) return this.#whyNotFound(token, owner, name, options);
    if (repo.status !== 200) throw new AppError('host.requestFailed', { status: repo.status });
    const body = record(jsonBody(repo));
    const permissions = record(field(body, 'permissions') ?? {});
    const flag = (key: string) => field(permissions, key) === true;
    const defaultBranch =
      typeof field(body, 'default_branch') === 'string' ? stringField(body, 'default_branch') : null;
    const facts: GithubFacts = {
      kind: 'github',
      permissions: { admin: flag('admin'), maintain: flag('maintain'), push: flag('push'), pull: flag('pull') },
      branch: defaultBranch
        ? await this.#branchRules(token, owner, name, defaultBranch, options)
        : { reviewRequired: false, canBypass: false, protected: false, signaturesRequired: false },
    };
    const sizeKb = numberField(body, 'size');
    return { kind: 'ok', facts, defaultBranch, sizeBytes: sizeKb === undefined ? null : sizeKb * 1024 };
  }

  gitHeader(token: string): string {
    return basicAuthHeader('x-access-token', token);
  }

  /**
   * A GitHub App's token reaches only the repos the app is installed on, so a 404 can mean either "no access" or "not
   * installed" (PLAN.md §3.17 step 2). The user's installations tell them apart.
   */
  async #whyNotFound(token: string, owner: string, name: string, options: HostCallOptions): Promise<RepoAccess> {
    const listed = await this.#api('GET', '/user/installations?per_page=100', token, options);
    if (listed.status === 401) return { kind: 'unauthorized' };
    if (listed.status !== 200) return { kind: 'notFound' };
    const installations = field(record(jsonBody(listed)), 'installations');
    const forOwner = (Array.isArray(installations) ? installations : []).map(record).find((i) => {
      const login = field(record(field(i, 'account') ?? {}), 'login');
      return typeof login === 'string' && login.toLowerCase() === owner.toLowerCase();
    });
    if (!forOwner) return { kind: 'appNotInstalled' };
    if (field(forOwner, 'repository_selection') !== 'selected') return { kind: 'notFound' };
    const repos = await this.#api(
      'GET',
      `/user/installations/${String(field(forOwner, 'id'))}/repositories?per_page=100`,
      token,
      options,
    );
    const list = repos.status === 200 ? field(record(jsonBody(repos)), 'repositories') : [];
    const included = (Array.isArray(list) ? list : [])
      .map(record)
      .some((r) => String(field(r, 'name')).toLowerCase() === name.toLowerCase());
    return included ? { kind: 'notFound' } : { kind: 'appNotInstalled' };
  }

  /** Whether the company branch needs a pull request, from its readable rules, and whether this user may bypass them. */
  async #branchRules(
    token: string,
    owner: string,
    name: string,
    branch: string,
    options: HostCallOptions,
  ): Promise<GithubFacts['branch']> {
    const rules = await this.#api(
      'GET',
      `/repos/${enc(owner)}/${enc(name)}/rules/branches/${enc(branch)}`,
      token,
      options,
    );
    const list = (() => {
      const body = rules.status === 200 ? jsonBody(rules) : [];
      return (Array.isArray(body) ? body : []).map(record);
    })();
    const signaturesRequired = list.some((rule) => field(rule, 'type') === 'required_signatures');
    // The branch API's flag shows classic protection too, whose rules only admins can read (PLAN.md §3.11).
    const branchInfo = await this.#api(
      'GET',
      `/repos/${enc(owner)}/${enc(name)}/branches/${enc(branch)}`,
      token,
      options,
    );
    const isProtected = branchInfo.status === 200 && field(record(jsonBody(branchInfo)), 'protected') === true;
    const pullRequestRules = list.filter((rule) => field(rule, 'type') === 'pull_request');
    if (pullRequestRules.length === 0) {
      return { reviewRequired: false, canBypass: false, protected: isProtected, signaturesRequired };
    }
    const rulesets = [...new Set(pullRequestRules.map((rule) => field(rule, 'ruleset_id')))];
    let canBypass = true;
    for (const id of rulesets) {
      const ruleset = await this.#api(
        'GET',
        `/repos/${enc(owner)}/${enc(name)}/rulesets/${String(id)}`,
        token,
        options,
      );
      const bypass = ruleset.status === 200 ? field(record(jsonBody(ruleset)), 'current_user_can_bypass') : 'never';
      if (bypass !== 'always' && bypass !== 'exempt') canBypass = false;
    }
    return { reviewRequired: true, canBypass, protected: isProtected, signaturesRequired };
  }

  // ---- Change requests: made on GitHub's website (ADR 0032) -----------------------------------------------------

  /** GitHub's own page for a new pull request from a branch, as its push message gives it. */
  newRequestUrl(repoPath: string, branch: string): string | null {
    return `${this.endpoint.origin}/${repoPath}/pull/new/${branch.split('/').map(enc).join('/')}`;
  }

  async signingKeys(token: string, options: HostCallOptions = {}): Promise<HostSigningKey[]> {
    const response = await this.#api('GET', '/user/ssh_signing_keys?per_page=100', token, options);
    const list = this.#ok(response, 200);
    return (Array.isArray(list) ? list : [])
      .map(record)
      .map((k) => ({ title: textField(k, 'title'), key: textField(k, 'key') }));
  }

  async addSigningKey(token: string, key: HostSigningKey, options: HostCallOptions = {}): Promise<void> {
    const response = await this.#api('POST', '/user/ssh_signing_keys', token, options, {
      title: key.title,
      key: key.key,
    });
    // 422: the key is there already.
    if (response.status !== 422) this.#ok(response, 201);
  }

  /** The answer's JSON when the status is the expected one; otherwise the failure, with the host's message. */
  #ok(response: HttpResponse, expected: number): unknown {
    if (response.status === expected || (expected === 200 && response.status === 201)) return jsonBody(response);
    if (response.status === 401) throw new AppError('host.unauthorized');
    const message = textField(record(safeJson(response.text)), 'message');
    throw new AppError('host.requestFailed', { status: response.status, message: message.slice(0, 300) });
  }

  #oauth(pathname: string, fields: Record<string, string>, options: HostCallOptions): Promise<HttpResponse> {
    return this.#http.request({
      method: 'POST',
      url: `${this.endpoint.origin}${pathname}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: formBody(fields),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  #api(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    pathname: string,
    token: string,
    options: HostCallOptions,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<HttpResponse> {
    return this.#http.request({
      method,
      url: `${this.endpoint.apiBase ?? ''}${pathname}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}

const enc = encodeURIComponent;
