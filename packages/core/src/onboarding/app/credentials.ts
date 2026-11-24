// An instance's sign-in, kept by main's secrets service (IMPLEMENTATION.md §2.13 rule 9). The worker asks for it each
// time it needs it and keeps it only for that call. A device-flow token is renewed with its refresh token before it
// expires (GitLab's after 2 hours; GitHub App tokens after 8 hours, or never when the App sets no expiry), both ahead
// of a command and in the background; a renewal the host refuses asks the user to sign in again (A4.8). Git gets the
// credential only in its environment (ADR 0014): a header for its own origin, or an SSH key or agent for SSH URLs.
import { HOST_CREDENTIAL_KEY, type HostCredential, HostCredentialSchema } from '@app/schemas';
import type { Clock } from '../../ports/clock.ts';
import type { DeviceServices } from '../../ports/device-services.ts';
import type { GitAuth } from '../../ports/git.ts';
import type { Host, HostEndpoint, HostKind } from '../../ports/host.ts';
import type { Logger } from '../../ports/logger.ts';
import { AppError, isAppError } from '../../shared/errors.ts';

/** How long before it expires a token is renewed: 10 minutes. */
export const RENEW_AHEAD_MS = 10 * 60 * 1000;

export interface HostCredentialsDeps {
  readonly services: DeviceServices;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The host API for a credential's origin, to renew its token. */
  readonly host: (endpoint: HostEndpoint) => Host;
}

/** Basic credentials as an HTTP header, without Node's Buffer (core is pure). */
export function basicHeader(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Authorization: Basic ${btoa(binary)}`;
}

/** The user name git sends with a token by default: what GitHub and GitLab expect for app and OAuth tokens. */
export function defaultTokenUser(host: HostKind): string {
  return host === 'github' ? 'x-access-token' : host === 'gitlab' ? 'oauth2' : 'git';
}

function tokenUser(credential: HostCredential & { method: 'device' | 'token' }): string {
  return credential.method === 'token' ? credential.username : defaultTokenUser(credential.host);
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export class HostCredentials {
  readonly #deps: HostCredentialsDeps;
  #renewing: Promise<HostCredential> | undefined;

  constructor(deps: HostCredentialsDeps) {
    this.#deps = deps;
  }

  async get(): Promise<HostCredential | null> {
    const text = await this.#deps.services.secret(HOST_CREDENTIAL_KEY);
    if (text === null) return null;
    const parsed = HostCredentialSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      this.#deps.logger.warn('the stored sign-in is not readable; it is ignored');
      return null;
    }
    return parsed.data;
  }

  async save(credential: HostCredential): Promise<void> {
    await this.#deps.services.setSecret(HOST_CREDENTIAL_KEY, JSON.stringify(HostCredentialSchema.parse(credential)));
  }

  async remove(): Promise<void> {
    await this.#deps.services.deleteSecret(HOST_CREDENTIAL_KEY);
  }

  /** The current credential, renewed first when its token expires within RENEW_AHEAD_MS. */
  async current(): Promise<HostCredential | null> {
    const credential = await this.get();
    if (credential?.method !== 'device' || !this.#due(credential)) return credential;
    return this.renew();
  }

  /** The token for the host's API, renewed first if needed; null for a key, which has none. */
  async apiToken(): Promise<string | null> {
    const credential = await this.current();
    if (credential?.method === 'device') return credential.accessToken;
    if (credential?.method === 'token') return credential.token;
    return null;
  }

  /** How one git command to this URL authenticates (ADR 0014). */
  async gitAuth(url: string): Promise<GitAuth> {
    const origin = originOf(url);
    const credential = await this.current();
    if (!credential) return { kind: 'none' };
    if (origin === null) {
      if (credential.method === 'ssh-key') return { kind: 'ssh-key', privateKey: credential.privateKey };
      if (credential.method === 'ssh-agent') return { kind: 'ssh-agent' };
      return { kind: 'none' };
    }
    if ((credential.method === 'device' || credential.method === 'token') && credential.origin === origin) {
      const token = credential.method === 'device' ? credential.accessToken : credential.token;
      return { kind: 'https-header', origin, header: basicHeader(tokenUser(credential), token) };
    }
    return { kind: 'none' };
  }

  /** When the background renewal should run, or null when the token doesn't expire. */
  async renewAt(): Promise<number | null> {
    const credential = await this.get();
    if (credential?.method !== 'device' || credential.expiresAt === null || credential.refreshToken === null) {
      return null;
    }
    return credential.expiresAt - RENEW_AHEAD_MS;
  }

  /**
   * Renews the token now. One renewal runs at a time; callers that arrive meanwhile get its result. A refusal fails as
   * `host.signInAgain`; while offline the old token is used until it expires.
   */
  renew(): Promise<HostCredential> {
    this.#renewing ??= this.#renew().finally(() => {
      this.#renewing = undefined;
    });
    return this.#renewing;
  }

  async #renew(): Promise<HostCredential> {
    const credential = await this.get();
    if (credential?.method !== 'device') throw new AppError('host.signInAgain');
    if (credential.refreshToken === null) throw new AppError('host.signInAgain', { host: credential.host });
    const host = this.#deps.host({
      kind: credential.host,
      origin: credential.origin,
      apiBase: null,
      selfHosted: true,
    });
    try {
      const tokens = await host.refresh(credential.clientId, credential.refreshToken);
      const renewed: HostCredential = {
        ...credential,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? credential.refreshToken,
        expiresAt: tokens.expiresAt,
      };
      await this.save(renewed);
      this.#deps.logger.info('host token renewed', { host: credential.host });
      return renewed;
    } catch (error) {
      const offline = isAppError(error) && (error.code === 'host.offline' || error.code === 'host.certificate');
      if (offline && credential.expiresAt !== null && credential.expiresAt > this.#deps.clock.now()) {
        this.#deps.logger.info('host token not renewed while offline; the current one still works');
        return credential;
      }
      if (offline) throw error;
      this.#deps.logger.warn('host token renewal refused: sign in again', { host: credential.host });
      throw new AppError('host.signInAgain', { host: credential.host });
    }
  }

  #due(credential: HostCredential & { method: 'device' }): boolean {
    return (
      credential.expiresAt !== null &&
      credential.refreshToken !== null &&
      credential.expiresAt - this.#deps.clock.now() <= RENEW_AHEAD_MS
    );
  }
}
