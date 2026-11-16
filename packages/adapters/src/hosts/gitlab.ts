// GitLab with OAuth (PLAN.md §3.17 step 2, ADR 0016), on gitlab.com and on self-managed servers. Sign-in is the
// device flow with the `api` scope (needed for merge requests); tokens expire after 2 hours and are renewed with their
// refresh token. The role facts are the user's access level, a Guest's custom role ("View repository code") and
// whether the user may push to the company branch (PLAN.md §3.11).
import {
  AppError,
  type DeviceCode,
  type DevicePoll,
  type GitlabFacts,
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
import {
  asList,
  field,
  numberField,
  oauthError,
  record,
  safeJson,
  stringField,
  textField,
  tokensFrom,
} from './json.ts';

export const gitlabCapabilities: HostCapabilities = {
  deviceFlow: true,
  readableBranchRules: true,
  signingKeyRegistration: true,
};

export const GITLAB_SCOPE = 'api';

export class GitlabHost implements Host {
  readonly endpoint: HostEndpoint;
  readonly #http: HttpClient;
  readonly #now: () => number;

  constructor(endpoint: HostEndpoint, http: HttpClient, now: () => number) {
    this.endpoint = endpoint;
    this.#http = http;
    this.#now = now;
  }

  capabilities(): HostCapabilities {
    return gitlabCapabilities;
  }

  async startDeviceFlow(clientId: string, options: HostCallOptions = {}): Promise<DeviceCode> {
    const response = await this.#oauth(
      '/oauth/authorize_device',
      { client_id: clientId, scope: GITLAB_SCOPE },
      options,
    );
    if (response.status === 404) throw new AppError('host.notSupported', { feature: 'deviceFlow' });
    const body = record(jsonBody(response));
    if (response.status !== 200 || oauthError(body)) {
      throw new AppError('host.requestFailed', { status: response.status, message: oauthError(body) ?? '' });
    }
    return {
      deviceCode: stringField(body, 'device_code'),
      userCode: stringField(body, 'user_code'),
      verificationUri: stringField(body, 'verification_uri'),
      intervalMs: (numberField(body, 'interval') ?? 5) * 1000,
      expiresAt: this.#now() + (numberField(body, 'expires_in') ?? 300) * 1000,
    };
  }

  async pollDeviceFlow(clientId: string, deviceCode: string, options: HostCallOptions = {}): Promise<DevicePoll> {
    const response = await this.#oauth(
      '/oauth/token',
      { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
      options,
    );
    const body = record(jsonBody(response));
    switch (oauthError(body)) {
      case undefined:
        if (response.status !== 200) throw new AppError('host.requestFailed', { status: response.status });
        return { kind: 'token', tokens: tokensFrom(body, this.#now()) };
      case 'authorization_pending':
        return { kind: 'pending' };
      case 'slow_down':
        return { kind: 'slowDown', intervalMs: 10_000 };
      case 'access_denied':
        return { kind: 'denied' };
      case 'expired_token':
        return { kind: 'expired' };
      default:
        throw new AppError('host.requestFailed', { status: response.status, message: oauthError(body) ?? '' });
    }
  }

  async refresh(clientId: string, refreshToken: string, options: HostCallOptions = {}): Promise<HostTokens> {
    const response = await this.#oauth(
      '/oauth/token',
      { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken },
      options,
    );
    const body = record(jsonBody(response));
    if (response.status !== 200 || oauthError(body)) throw new AppError('host.signInAgain', { host: 'gitlab' });
    return tokensFrom(body, this.#now());
  }

  async account(token: string, options: HostCallOptions = {}): Promise<HostAccount> {
    const user = await this.#user(token, options);
    const email = [field(user, 'commit_email'), field(user, 'email'), field(user, 'public_email')].find(
      (value): value is string => typeof value === 'string' && value !== '',
    );
    const name = field(user, 'name');
    return {
      login: stringField(user, 'username'),
      name: typeof name === 'string' && name !== '' ? name : null,
      email: email ?? null,
    };
  }

  async repoAccess(token: string, repoPath: string, options: HostCallOptions = {}): Promise<RepoAccess> {
    const project = await this.#api(`/projects/${encodeURIComponent(repoPath)}`, token, options);
    if (project.status === 401) return { kind: 'unauthorized' };
    if (project.status === 404 || project.status === 403) return { kind: 'notFound' };
    if (project.status !== 200) throw new AppError('host.requestFailed', { status: project.status });
    const body = record(jsonBody(project));
    const id = String(field(body, 'id'));
    const permissions = record(field(body, 'permissions') ?? {});
    const level = (key: string) => numberField(record(field(permissions, key) ?? {}), 'access_level') ?? 0;
    let accessLevel = Math.max(level('project_access'), level('group_access'));
    let readCode = false;
    if (accessLevel <= 10) {
      // A Guest with a custom role: the role says whether it may read the code (GitLab Ultimate).
      const user = await this.#user(token, options);
      const member = await this.#api(`/projects/${id}/members/all/${String(field(user, 'id'))}`, token, options);
      if (member.status === 200) {
        const memberBody = record(jsonBody(member));
        accessLevel = Math.max(accessLevel, numberField(memberBody, 'access_level') ?? 0);
        readCode = field(record(field(memberBody, 'member_role') ?? {}), 'read_code') === true;
      }
    }
    const defaultBranch =
      typeof field(body, 'default_branch') === 'string' ? stringField(body, 'default_branch') : null;
    let canPushDefault = false;
    if (defaultBranch) {
      const branch = await this.#api(
        `/projects/${id}/repository/branches/${encodeURIComponent(defaultBranch)}`,
        token,
        options,
      );
      canPushDefault = branch.status === 200 && field(record(jsonBody(branch)), 'can_push') === true;
    }
    // The push rule is readable for Maintainers; for others the first rejected push tells (PLAN.md §3.10 "Signing").
    const rule = await this.#api(`/projects/${id}/push_rule`, token, options);
    const signaturesRequired =
      rule.status === 200 && field(record(safeJson(rule.text)), 'reject_unsigned_commits') === true;
    const facts: GitlabFacts = { kind: 'gitlab', accessLevel, readCode, canPushDefault, signaturesRequired };
    const size = numberField(record(field(body, 'statistics') ?? {}), 'repository_size');
    return { kind: 'ok', facts, defaultBranch, sizeBytes: size ?? null };
  }

  gitHeader(token: string): string {
    return basicAuthHeader('oauth2', token);
  }

  // ---- Change requests: made on GitLab's website (ADR 0032) -----------------------------------------------------

  /** GitLab's own page for a new merge request from a branch into `base`, as its push message gives it. */
  newRequestUrl(repoPath: string, branch: string, base: string): string | null {
    const query = `merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}`;
    return `${this.endpoint.origin}/${repoPath}/-/merge_requests/new?${query}`;
  }

  async signingKeys(token: string, options: HostCallOptions = {}): Promise<HostSigningKey[]> {
    const response = await this.#api('/user/keys?per_page=100', token, options);
    return asList(this.#ok(response, 200))
      .map(record)
      .filter((k) => {
        const usage = field(k, 'usage_type');
        return usage === undefined || usage === 'signing' || usage === 'auth_and_signing';
      })
      .map((k) => ({ title: textField(k, 'title'), key: textField(k, 'key') }));
  }

  async addSigningKey(token: string, key: HostSigningKey, options: HostCallOptions = {}): Promise<void> {
    const response = await this.#send('POST', '/user/keys', token, options, {
      title: key.title,
      key: key.key,
      usage_type: 'signing',
    });
    // 400 "has already been taken": the key is there already.
    if (response.status === 400 && /taken/.test(response.text)) return;
    this.#ok(response, 201);
  }

  #ok(response: HttpResponse, expected: number): unknown {
    if (response.status === expected || (expected === 200 && response.status === 201)) return jsonBody(response);
    if (response.status === 401) throw new AppError('host.unauthorized');
    const message = textField(record(safeJson(response.text)), 'message');
    throw new AppError('host.requestFailed', { status: response.status, message: message.slice(0, 300) });
  }

  #send(
    method: 'POST' | 'PUT',
    pathname: string,
    token: string,
    options: HostCallOptions,
    body: Readonly<Record<string, unknown>>,
  ): Promise<HttpResponse> {
    return this.#http.request({
      method,
      url: `${this.endpoint.apiBase ?? ''}${pathname}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async #user(token: string, options: HostCallOptions) {
    const user = await this.#api('/user', token, options);
    if (user.status === 401) throw new AppError('host.unauthorized');
    if (user.status !== 200) throw new AppError('host.requestFailed', { status: user.status });
    return record(jsonBody(user));
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

  #api(pathname: string, token: string, options: HostCallOptions): Promise<HttpResponse> {
    return this.#http.request({
      method: 'GET',
      url: `${this.endpoint.apiBase ?? ''}${pathname}`,
      headers: { authorization: `Bearer ${token}` },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}
