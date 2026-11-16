// Which kind of host serves a URL (ADR 0016). github.com and gitlab.com are known; any other HTTPS server is asked:
// GitHub Enterprise Server answers `/api/v3/meta` without a sign-in, and GitLab answers `/api/v4/version` (with 401
// before a sign-in). Anything else is a plain git server, which has no API.
import {
  AppError,
  type DeviceCode,
  type DevicePoll,
  type Host,
  type HostAccount,
  type HostCapabilities,
  type HostEndpoint,
  type HostProbe,
  type HostTokens,
  type RepoAccess,
} from '@app/core';
import { basicAuthHeader } from '../git/git-env.ts';
import type { HttpClient } from '../network/http-client.ts';
import { GithubHost } from './github.ts';
import { GitlabHost } from './gitlab.ts';
import { field, record } from './json.ts';

export const plainCapabilities: HostCapabilities = {
  deviceFlow: false,
  readableBranchRules: false,
  signingKeyRegistration: false,
};

/** A plain git server: no API. A token typed in for it is sent as Basic credentials with its user name. */
export class PlainHost implements Host {
  readonly endpoint: HostEndpoint;

  constructor(endpoint: HostEndpoint) {
    this.endpoint = endpoint;
  }

  capabilities(): HostCapabilities {
    return plainCapabilities;
  }

  startDeviceFlow(): Promise<DeviceCode> {
    return Promise.reject(new AppError('host.notSupported', { feature: 'deviceFlow' }));
  }

  pollDeviceFlow(): Promise<DevicePoll> {
    return Promise.reject(new AppError('host.notSupported', { feature: 'deviceFlow' }));
  }

  refresh(): Promise<HostTokens> {
    return Promise.reject(new AppError('host.notSupported', { feature: 'refresh' }));
  }

  account(): Promise<HostAccount> {
    return Promise.reject(new AppError('host.notSupported', { feature: 'account' }));
  }

  repoAccess(): Promise<RepoAccess> {
    return Promise.reject(new AppError('host.notSupported', { feature: 'repoAccess' }));
  }

  gitHeader(token: string): string {
    return basicAuthHeader('git', token);
  }

  // Plain git has no web page of its own that the app knows: the server's push message is the only link (ADR 0032).
  newRequestUrl(): null {
    return null;
  }

  signingKeys(): Promise<never> {
    return notSupported('signingKeyRegistration');
  }
  addSigningKey(): Promise<never> {
    return notSupported('signingKeyRegistration');
  }
}

function notSupported(feature: string): Promise<never> {
  return Promise.reject(new AppError('host.notSupported', { feature }));
}

export function knownEndpoint(origin: string): HostEndpoint | undefined {
  const host = new URL(origin).host.toLowerCase();
  if (host === 'github.com') return { kind: 'github', origin, apiBase: 'https://api.github.com', selfHosted: false };
  if (host === 'gitlab.com') {
    return { kind: 'gitlab', origin, apiBase: 'https://gitlab.com/api/v4', selfHosted: false };
  }
  return undefined;
}

export class NodeHostProbe implements HostProbe {
  readonly #http: HttpClient;
  readonly #now: () => number;

  constructor(http: HttpClient, now: () => number) {
    this.#http = http;
    this.#now = now;
  }

  async probe(origin: string, options: { signal?: AbortSignal } = {}): Promise<HostEndpoint> {
    const known = knownEndpoint(origin);
    if (known) return known;
    const signal = options.signal ? { signal: options.signal } : {};
    const github = await this.#http.request({ method: 'GET', url: `${origin}/api/v3/meta`, ...signal });
    if (github.status === 200 && looksLike(github.text, ['installed_version', 'verifiable_password_authentication'])) {
      return { kind: 'github', origin, apiBase: `${origin}/api/v3`, selfHosted: true };
    }
    const gitlab = await this.#http.request({ method: 'GET', url: `${origin}/api/v4/version`, ...signal });
    if (
      (gitlab.status === 200 && looksLike(gitlab.text, ['version'])) ||
      (gitlab.status === 401 && looksLike(gitlab.text, ['message']))
    ) {
      return { kind: 'gitlab', origin, apiBase: `${origin}/api/v4`, selfHosted: true };
    }
    return { kind: 'plain', origin, apiBase: null, selfHosted: true };
  }

  host(endpoint: HostEndpoint): Host {
    switch (endpoint.kind) {
      case 'github':
        return new GithubHost(endpoint, this.#http, this.#now);
      case 'gitlab':
        return new GitlabHost(endpoint, this.#http, this.#now);
      case 'plain':
        return new PlainHost(endpoint);
    }
  }
}

function looksLike(text: string, keys: readonly string[]): boolean {
  try {
    const body = record(JSON.parse(text) as unknown);
    return keys.some((key) => field(body, key) !== undefined);
  } catch {
    return false;
  }
}
