// An instance's access after setup (PLAN.md §3.11 "When", IMPLEMENTATION.md Step 4): at every start the host is asked
// again for the role, so a changed permission shows up without signing in again. A revoked sign-in or a repo that's
// gone or out of reach is the *access lost* state, with three ways out: sign in again, change the URL, or remove the
// library. Device-flow tokens are renewed in the background before they expire; a refused renewal is access lost too.
// Offline, nothing changes: the last state stands.
import type { HostAccount } from '@app/schemas';
import type { Clock, Timer } from '../../ports/clock.ts';
import type { Git, GitRepo } from '../../ports/git.ts';
import type { DeviceCode, HostFacts, HostProbe } from '../../ports/host.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Random } from '../../ports/random.ts';
import type { Store } from '../../ports/store.ts';
import { type GitUrl, parseGitUrl } from '../../library/index.ts';
import { classicProtection, type Role, roleFrom, roleWithRefusal } from '../../review/index.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import { keyRole } from './access.ts';
import type { HostCredentials } from './credentials.ts';
import { credentialFor, endpointFor, type SignInRequest } from './sign-in.ts';

export type AccessLostReason = 'revoked' | 'notFound' | 'signInAgain';

export interface AccessSnapshot {
  readonly state: 'unknown' | 'ok' | 'lost';
  readonly reason: AccessLostReason | null;
  readonly host: HostAccount['host'] | null;
  readonly method: HostAccount['method'] | null;
  readonly login: string | null;
  readonly role: Role | null;
  readonly clientIdNeeded: boolean;
  readonly deviceCode: { readonly userCode: string; readonly verificationUri: string } | null;
}

export interface InstanceAccessDeps {
  readonly credentials: HostCredentials;
  readonly probe: HostProbe;
  readonly git: Git;
  readonly repo: GitRepo;
  readonly store: Store;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  /** The library's URL now (it changes with Change URL); null for a test library. */
  readonly gitUrl: () => string | null;
  readonly builtInClientId: (kind: HostAccount['host'], selfHosted: boolean) => string | null;
  readonly onChange: (snapshot: AccessSnapshot) => void;
}

/** Failures that say nothing about access: the host or the network is out of reach. */
const OFFLINE = new Set(['host.offline', 'host.certificate', 'git.offline', 'git.certificate', 'command.cancelled']);

/** How long to wait before the next try, when a due renewal kept the old token (the host was out of reach). */
export const RETRY_RENEWAL_MS = 60 * 1000;

export class InstanceAccess {
  readonly #deps: InstanceAccessDeps;
  #state: AccessSnapshot['state'] = 'unknown';
  #reason: AccessLostReason | null = null;
  #deviceCode: AccessSnapshot['deviceCode'] = null;
  #timer: Timer | undefined;
  #stopped = false;

  constructor(deps: InstanceAccessDeps) {
    this.#deps = deps;
  }

  snapshot(): AccessSnapshot {
    const account = this.#account();
    return {
      state: this.#state,
      reason: this.#reason,
      host: account?.host ?? null,
      method: account?.method ?? null,
      login: account?.login ?? null,
      role: account?.role ?? null,
      clientIdNeeded:
        account !== undefined &&
        account.method === 'device' &&
        account.clientId === null &&
        this.#deps.builtInClientId(account.host, account.selfHosted) === null,
      deviceCode: this.#deviceCode,
    };
  }

  /** Asks the host whether the user still has access, and for the role (A4.7). */
  async check(signal?: AbortSignal): Promise<AccessSnapshot> {
    const account = this.#account();
    const url = this.#url();
    if (!account || !url) return this.snapshot();
    try {
      const found = await this.#role(account, url, signal);
      if ('lost' in found) this.#lose(found.lost);
      else {
        const role = found.role;
        this.#deps.store.write((tx) => tx.hostAccount.set({ ...account, role, roleCheckedAt: this.#deps.clock.now() }));
        // A changed role is news too, not only a changed state (PLAN.md §3.11 "When").
        if (role !== account.role && this.#state === 'ok') this.#deps.onChange(this.snapshot());
        this.#set('ok', null);
      }
    } catch (error) {
      if (isAppError(error) && OFFLINE.has(error.code)) {
        this.#deps.logger.info('access not checked: the host is out of reach', { code: error.code });
      } else if (isAppError(error) && error.code === 'host.signInAgain') this.#lose('signInAgain');
      else throw error;
    }
    this.#schedule();
    return this.snapshot();
  }

  /** The access-lost state's [Sign in again]: a new sign-in, then the same check as at start. */
  async signInAgain(
    input: { readonly method: SignInRequest },
    options: { signal?: AbortSignal; onCode?: (code: DeviceCode) => void } = {},
  ): Promise<AccessSnapshot> {
    const account = this.#account();
    const url = this.#url();
    if (!account || !url) throw new AppError('setup.wrongStep', { step: 'signIn' });
    const endpoint = endpointFor(account.host, account.origin ?? `https://${url.host}`, account.selfHosted);
    const method =
      input.method.kind === 'device' && !input.method.clientId && account.clientId
        ? { ...input.method, clientId: account.clientId }
        : input.method;
    try {
      const credential = await credentialFor({
        endpoint,
        transport: url.transport,
        method,
        host: (e) => this.#deps.probe.host(e),
        clock: this.#deps.clock,
        builtInClientId: (e) => this.#deps.builtInClientId(e.kind, e.selfHosted),
        ...(options.signal ? { signal: options.signal } : {}),
        onCode: (code) => {
          this.#deviceCode = { userCode: code.userCode, verificationUri: code.verificationUri };
          this.#deps.onChange(this.snapshot());
          options.onCode?.(code);
        },
      });
      await this.#deps.credentials.save(credential);
      this.#deps.store.write((tx) =>
        tx.hostAccount.set({
          ...account,
          method: credential.method,
          clientId: credential.method === 'device' && account.selfHosted ? credential.clientId : account.clientId,
        }),
      );
    } finally {
      this.#deviceCode = null;
    }
    return this.check(options.signal);
  }

  stop(): void {
    this.#stopped = true;
    this.#timer?.cancel();
  }

  /** The role the host gives now, or why there's none. */
  async #role(
    account: HostAccount,
    url: GitUrl,
    signal?: AbortSignal,
  ): Promise<{ readonly role: Role | null } | { readonly lost: AccessLostReason }> {
    const call = signal ? { signal } : {};
    if (account.host !== 'plain' && url.transport === 'https') {
      const token = await this.#deps.credentials.apiToken();
      if (token === null) return { lost: 'signInAgain' };
      const endpoint = endpointFor(account.host, account.origin ?? `https://${url.host}`, account.selfHosted);
      const access = await this.#deps.probe.host(endpoint).repoAccess(token, url.path, call);
      if (access.kind === 'unauthorized') return { lost: 'revoked' };
      if (access.kind !== 'ok') return { lost: 'notFound' };
      const role = this.#learned(access.facts, roleFrom(access.facts));
      return role === null ? { lost: 'notFound' } : { role };
    }
    try {
      await this.#deps.git.lsRemote(url.url, call);
    } catch (error) {
      if (isAppError(error) && error.code === 'git.authFailed') return { lost: 'revoked' };
      if (isAppError(error) && error.code === 'git.notFound') return { lost: 'notFound' };
      throw error;
    }
    const branch = (await this.#deps.repo.status()).branch;
    return { role: branch ? await keyRole(this.#deps.repo, branch, this.#deps.random, signal) : account.role };
  }

  /**
   * What the host's facts and earlier rejections say together (PLAN.md §3.11, §3.10 "Signing"): a refused direct push
   * counts while the branch is protected the classic way, and readable rules that require signatures are remembered.
   */
  #learned(facts: HostFacts, role: Role | null): Role | null {
    const settings = this.#deps.store.read((tx) => tx.settings.get());
    const refused = settings.directPushRefused && classicProtection(facts);
    const signing =
      (facts.kind === 'github' && facts.branch.signaturesRequired) ||
      (facts.kind === 'gitlab' && facts.signaturesRequired);
    if (refused !== settings.directPushRefused || (signing && !settings.signingRequired)) {
      this.#deps.store.write((tx) =>
        tx.settings.set({
          ...tx.settings.get(),
          directPushRefused: refused,
          signingRequired: settings.signingRequired || signing,
        }),
      );
    }
    return roleWithRefusal(role, facts, refused);
  }

  /** The background renewal, shortly before the token expires. */
  #schedule(): void {
    this.#timer?.cancel();
    if (this.#stopped || this.#state === 'lost') return;
    void this.#deps.credentials.renewAt().then((at) => {
      if (at === null || this.#stopped) return;
      // A renewal that was due already failed offline and kept the old token: try again later, not at once.
      const delay = at - this.#deps.clock.now();
      this.#timer = this.#deps.clock.setTimer(delay > 0 ? delay : RETRY_RENEWAL_MS, () => {
        this.#deps.credentials
          .renew()
          .then(() => this.#schedule())
          .catch((error: unknown) => {
            if (isAppError(error) && error.code === 'host.signInAgain') this.#lose('signInAgain');
            else this.#deps.logger.info('token renewal postponed', { error: String(error) });
          });
      });
    });
  }

  #lose(reason: AccessLostReason): void {
    this.#deps.logger.warn('access to the library is lost', { reason });
    this.#set('lost', reason);
  }

  #set(state: AccessSnapshot['state'], reason: AccessLostReason | null): void {
    const changed = state !== this.#state || reason !== this.#reason;
    this.#state = state;
    this.#reason = reason;
    if (changed) this.#deps.onChange(this.snapshot());
  }

  #account(): HostAccount | undefined {
    return this.#deps.store.read((tx) => tx.hostAccount.get());
  }

  #url(): GitUrl | null {
    const text = this.#deps.gitUrl();
    if (text === null) return null;
    const parsed = parseGitUrl(text);
    return parsed.ok ? parsed.value : null;
  }
}
