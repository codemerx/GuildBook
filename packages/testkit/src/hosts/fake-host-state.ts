// The fake host's state and its admin API for tests (TESTING.md §5): users and their tokens, the app registered on the
// server (for its client id), device codes waiting for approval, who may do what in which repo, branch protection
// (rules anyone can read, or the classic way only admins can read), and where the GitHub App is installed. Tests call
// these methods directly; the server reads the same state for its APIs and for git.
import { randomBytes } from 'node:crypto';

export type HostFlavor = 'github' | 'gitlab' | 'plain';

/** GitHub's repository roles; GitLab's access levels are numbers (10 Guest … 50 Owner). */
export type GithubPermission = 'none' | 'read' | 'write' | 'maintain' | 'admin';

export interface FakeUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
  /** GitHub's "Keep my email addresses private": the API shows the address as private. */
  readonly privateEmail: boolean;
}

export interface FakeToken {
  readonly token: string;
  readonly login: string | null;
  /** A deploy key's or deploy token's repo, and whether it may write; null for a user's token. */
  readonly deploy: { readonly repo: string; readonly write: boolean } | null;
  expiresAt: number | null;
  revoked: boolean;
  refreshToken: string | null;
  readonly clientId: string | null;
}

export interface DeviceRequest {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly clientId: string;
  readonly expiresAt: number;
  approvedBy: string | null;
  denied: boolean;
  polls: number;
}

export type ProtectionStyle = 'github' | 'github-rules' | 'gitlab';

export interface Protection {
  readonly style: ProtectionStyle;
  /** GitHub rulesets: who may bypass the rule. */
  readonly bypass: readonly string[];
  /** The ruleset's id, for the rules API. */
  readonly rulesetId: number;
}

export interface Installation {
  readonly id: number;
  readonly owner: string;
  /** null: every repo of the owner; otherwise only these (repo names without the owner). */
  readonly repos: readonly string[] | null;
}

export interface FakeSigningKey {
  readonly id: number;
  readonly title: string;
  readonly key: string;
}

export class FakeHostState {
  readonly flavor: HostFlavor;
  readonly users = new Map<string, FakeUser>();
  readonly tokens = new Map<string, FakeToken>();
  readonly refreshTokens = new Map<string, string>();
  readonly devices = new Map<string, DeviceRequest>();
  /** repo → login → GitHub permission or GitLab access level. */
  readonly permissions = new Map<string, Map<string, GithubPermission | number>>();
  /** GitLab: repo → logins whose Guest custom role may read code. */
  readonly readCode = new Map<string, Set<string>>();
  /** repo → branch → protection. */
  readonly protections = new Map<string, Map<string, Protection>>();
  readonly installations = new Map<string, Installation>();
  /** Repos whose default branch isn't `main`. */
  readonly defaultBranches = new Map<string, string>();
  /** login → the SSH signing keys registered for the account. */
  readonly signingKeys = new Map<string, FakeSigningKey[]>();
  /** Repos that require signed commits, and whether a rule anyone can read says so (GitHub rulesets, GitLab Maintainers). */
  readonly signing = new Map<string, { readonly readable: boolean }>();
  /**
   * The server sends the link to make a change request with the push of a branch, in its host's words (ADR 0032):
   * GitHub's and GitLab's do; a plain host does when a test makes it pose as Gitea.
   */
  #requestLinks: boolean;
  readonly #clientIds = new Set<string>();
  #nextId = 1;
  /** User codes come from a fixed sequence, so screenshots of the sign-in page are the same in every run. */
  #codeSeed: number;
  #offline = false;
  #failures: Array<{ readonly path: RegExp; readonly status: number }> = [];
  now: () => number = () => Date.now();
  /** Seconds between device-flow polls the server asks for. */
  pollInterval = 1;
  /** Seconds an access token lives: GitHub App user tokens 8 hours, GitLab's 2 hours. */
  tokenLifetime: number;
  onChange: () => void = () => undefined;

  constructor(flavor: HostFlavor) {
    this.flavor = flavor;
    this.tokenLifetime = flavor === 'gitlab' ? 2 * 3600 : 8 * 3600;
    this.#codeSeed = flavor === 'github' ? 7 : flavor === 'gitlab' ? 11 : 13;
    this.#requestLinks = flavor !== 'plain';
  }

  /** Registers the app on this server, as an admin does once (PLAN.md §3.17 step 2), and returns its client id. */
  registerApp(clientId = this.flavor === 'github' ? 'Iv23.fake-host-app' : 'fake-host-oauth-app'): string {
    this.#clientIds.add(clientId);
    return clientId;
  }

  knowsClient(clientId: string): boolean {
    return this.#clientIds.has(clientId);
  }

  addUser(login: string, name: string, email: string, options: { privateEmail?: boolean } = {}): FakeUser {
    const user = { id: this.#nextId++, login, name, email, privateEmail: options.privateEmail ?? false };
    this.users.set(login, user);
    return user;
  }

  /** A user's permission on a repo: a GitHub role, or a GitLab access level. */
  setPermission(
    repo: string,
    login: string,
    permission: GithubPermission | number,
    options: { readCode?: boolean } = {},
  ) {
    const forRepo = this.permissions.get(repo) ?? new Map<string, GithubPermission | number>();
    forRepo.set(login, permission);
    this.permissions.set(repo, forRepo);
    const readers = this.readCode.get(repo) ?? new Set<string>();
    if (options.readCode) readers.add(login);
    else readers.delete(login);
    this.readCode.set(repo, readers);
    this.onChange();
  }

  permission(repo: string, login: string): GithubPermission | number {
    return this.permissions.get(repo)?.get(login) ?? (this.flavor === 'gitlab' ? 0 : 'none');
  }

  /** Whether a user may read and write the repo over git, by the host's own rules. */
  access(repo: string, login: string): { read: boolean; write: boolean } {
    const permission = this.permission(repo, login);
    if (typeof permission === 'number') {
      const readCode = this.readCode.get(repo)?.has(login) ?? false;
      return { read: permission >= 20 || (permission >= 10 && readCode), write: permission >= 30 };
    }
    return {
      read: permission !== 'none',
      write: permission === 'write' || permission === 'maintain' || permission === 'admin',
    };
  }

  protect(repo: string, branch: string, style: ProtectionStyle, bypass: readonly string[] = []): void {
    const forRepo = this.protections.get(repo) ?? new Map<string, Protection>();
    forRepo.set(branch, { style, bypass, rulesetId: 1000 + this.#nextId++ });
    this.protections.set(repo, forRepo);
    this.onChange();
  }

  unprotect(repo: string, branch: string): void {
    this.protections.get(repo)?.delete(branch);
    this.onChange();
  }

  /** Who may push to a protected branch: a ruleset's bypass list; GitHub's admins with classic protection; GitLab's Maintainers. */
  mayPushProtected(repo: string, branch: string, login: string): boolean {
    const protection = this.protections.get(repo)?.get(branch);
    if (!protection) return true;
    const permission = this.permission(repo, login);
    switch (protection.style) {
      case 'github-rules':
        return protection.bypass.includes(login);
      case 'github':
        return permission === 'admin';
      case 'gitlab':
        return typeof permission === 'number' && permission >= 40;
    }
  }

  /** Installs the GitHub App for an owner: on all its repos, or on some. */
  installApp(owner: string, repos: readonly string[] | null = null): void {
    this.installations.set(owner.toLowerCase(), { id: this.#nextId++, owner, repos });
    this.onChange();
  }

  uninstallApp(owner: string): void {
    this.installations.delete(owner.toLowerCase());
    this.onChange();
  }

  /** Whether a GitHub App token reaches this repo: the app must be installed on it. Other hosts have no apps. */
  appReaches(repo: string): boolean {
    if (this.flavor !== 'github') return true;
    const [owner = '', name = ''] = repo.split('/');
    const installation = this.installations.get(owner.toLowerCase());
    return installation !== undefined && (installation.repos === null || installation.repos.includes(name));
  }

  /** A token as the device flow or a person's settings page would give it. */
  issueToken(login: string, options: { clientId?: string | null; lifetimeSeconds?: number | null } = {}): FakeToken {
    const lifetime = options.lifetimeSeconds === undefined ? this.tokenLifetime : options.lifetimeSeconds;
    const prefix = this.flavor === 'github' ? 'ghu_' : this.flavor === 'gitlab' ? 'glo_' : 'tok_';
    const token: FakeToken = {
      token: `${prefix}${randomBytes(18).toString('hex')}`,
      login,
      deploy: null,
      expiresAt: lifetime === null ? null : this.now() + lifetime * 1000,
      revoked: false,
      refreshToken: options.clientId
        ? `${this.flavor === 'github' ? 'ghr_' : 'glr_'}${randomBytes(18).toString('hex')}`
        : null,
      clientId: options.clientId ?? null,
    };
    this.tokens.set(token.token, token);
    if (token.refreshToken) this.refreshTokens.set(token.refreshToken, token.token);
    return token;
  }

  /** A deploy token for one repo (GitLab, plain servers), read-only unless `write`. */
  deployToken(repo: string, write: boolean): FakeToken {
    const token: FakeToken = {
      token: `dpl_${randomBytes(18).toString('hex')}`,
      login: null,
      deploy: { repo, write },
      expiresAt: null,
      revoked: false,
      refreshToken: null,
      clientId: null,
    };
    this.tokens.set(token.token, token);
    return token;
  }

  /** A token that works now, or undefined: unknown, revoked or expired. */
  validToken(text: string | undefined): FakeToken | undefined {
    if (!text) return undefined;
    const token = this.tokens.get(text);
    if (!token || token.revoked) return undefined;
    if (token.expiresAt !== null && token.expiresAt <= this.now()) return undefined;
    return token;
  }

  /** Revokes every token of a user, refresh tokens included, as removing the app's authorization does. */
  revoke(login: string): void {
    for (const token of this.tokens.values()) {
      if (token.login === login) {
        token.revoked = true;
        if (token.refreshToken) this.refreshTokens.delete(token.refreshToken);
      }
    }
  }

  /** Lets a user's access tokens expire now; their refresh tokens still work. */
  expire(login: string): void {
    for (const token of this.tokens.values()) if (token.login === login) token.expiresAt = this.now();
  }

  /** Renews a token with its refresh token, which is replaced (GitHub and GitLab rotate them). */
  refresh(refreshToken: string, clientId: string): FakeToken | undefined {
    const old = this.tokens.get(this.refreshTokens.get(refreshToken) ?? '');
    if (!old || old.revoked || old.clientId !== clientId || !old.login) return undefined;
    this.refreshTokens.delete(refreshToken);
    old.revoked = true;
    return this.issueToken(old.login, { clientId });
  }

  startDevice(clientId: string): DeviceRequest {
    const letters = 'BCDFGHJKLMNPQRSTVWXZ';
    const pick = (n: number) =>
      Array.from({ length: n }, () => {
        this.#codeSeed = (this.#codeSeed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return letters[this.#codeSeed % letters.length];
      }).join('');
    const request: DeviceRequest = {
      deviceCode: randomBytes(20).toString('hex'),
      userCode: `${pick(4)}-${pick(4)}`,
      clientId,
      expiresAt: this.now() + 15 * 60 * 1000,
      approvedBy: null,
      denied: false,
      polls: 0,
    };
    this.devices.set(request.deviceCode, request);
    return request;
  }

  /** The user approves the code in the browser (TESTING.md §5 "approve a device code"). */
  approveDevice(userCode: string, login: string): void {
    const request = [...this.devices.values()].find((d) => d.userCode === userCode);
    if (!request) throw new Error(`no device code ${userCode}`);
    if (!this.users.has(login)) throw new Error(`no user ${login}`);
    request.approvedBy = login;
  }

  denyDevice(userCode: string): void {
    const request = [...this.devices.values()].find((d) => d.userCode === userCode);
    if (!request) throw new Error(`no device code ${userCode}`);
    request.denied = true;
  }

  /** The codes waiting for approval, newest last. */
  pendingCodes(): string[] {
    return [...this.devices.values()].filter((d) => !d.approvedBy && !d.denied).map((d) => d.userCode);
  }

  #held: Array<() => void> | null = null;

  /** Holds every git request until `releaseGit`: e.g. to look at a download while it runs. */
  holdGit(): void {
    this.#held ??= [];
  }

  releaseGit(): void {
    const waiting = this.#held ?? [];
    this.#held = null;
    for (const resume of waiting) resume();
  }

  /** Resolves at once, or when the held git requests are released. */
  whenGitAllowed(): Promise<void> {
    const held = this.#held;
    return held === null ? Promise.resolve() : new Promise((resolve) => held.push(resolve));
  }

  setOffline(offline: boolean): void {
    this.#offline = offline;
  }

  get offline(): boolean {
    return this.#offline;
  }

  /** Makes the next request whose path matches fail with this status. */
  failNext(path: RegExp, status: number): void {
    this.#failures.push({ path, status });
  }

  takeFailure(path: string): number | undefined {
    const index = this.#failures.findIndex((f) => f.path.test(path));
    if (index < 0) return undefined;
    const [failure] = this.#failures.splice(index, 1);
    return failure?.status;
  }

  defaultBranch(repo: string): string {
    return this.defaultBranches.get(repo) ?? 'main';
  }

  // ---- Change requests (ADR 0032): made on the host's website; the server only sends the link ------------------

  get requestLinks(): boolean {
    return this.#requestLinks;
  }

  /** Whether the server's push message has the link to make a change request (TESTING.md §5 "request links"). */
  sendRequestLinks(on: boolean): void {
    this.#requestLinks = on;
    this.onChange();
  }

  // ---- Signing (TESTING.md §5 "require signing") ----------------------------------------------------------------

  /** Requires signed commits on every branch of the repo; `readable`: a rule the app can read says so. */
  requireSigning(repo: string, readable = true): void {
    this.signing.set(repo, { readable });
    this.onChange();
  }

  addSigningKey(login: string, title: string, key: string): FakeSigningKey {
    const keys = this.signingKeys.get(login) ?? [];
    const entry = { id: this.#nextId++, title, key: key.trim() };
    keys.push(entry);
    this.signingKeys.set(login, keys);
    this.onChange();
    return entry;
  }

  /** Every registered signing key, as an allowed-signers file for `git verify-commit`. */
  allowedSigners(): string {
    const lines: string[] = [];
    for (const [login, keys] of this.signingKeys) {
      for (const k of keys) lines.push(`${login}@fake-host ${k.key.split(/\s+/).slice(0, 2).join(' ')}`);
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }
}
