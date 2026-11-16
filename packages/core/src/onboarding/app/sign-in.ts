// Sign-in (PLAN.md §3.17 step 2): the device flow shows a short code, the browser opens, and the user approves there.
// The app polls at the interval the host asks for, slower when it says "slow down", until the code is approved,
// denied or expired. Waiting follows the clock, so tests move time instead of sleeping.
import type { HostCredential } from '@app/schemas';
import type { Clock } from '../../ports/clock.ts';
import type { DeviceCode, Host, HostEndpoint, HostKind, HostTokens } from '../../ports/host.ts';
import { AppError } from '../../shared/errors.ts';
import { defaultTokenUser } from './credentials.ts';

/** How the user signs in: the device flow, a token typed in, an SSH key the app keeps, or their own SSH agent. */
export type SignInRequest =
  | { readonly kind: 'device'; readonly clientId?: string | null | undefined }
  | { readonly kind: 'token'; readonly token: string; readonly username?: string | null | undefined }
  | { readonly kind: 'ssh-key'; readonly privateKey: string }
  | { readonly kind: 'ssh-agent' };

export interface DeviceSignInOptions {
  readonly host: Host;
  readonly clientId: string;
  readonly clock: Clock;
  readonly signal?: AbortSignal;
  /** Called once with the code to show and the page to open. */
  readonly onCode: (code: DeviceCode) => void;
}

/** Extra wait the device flow asks for after "slow down" (RFC 8628 §3.5). */
export const SLOW_DOWN_MS = 5000;

export async function deviceSignIn(options: DeviceSignInOptions): Promise<HostTokens> {
  const { host, clientId, clock, signal } = options;
  const call = signal ? { signal } : {};
  const code = await host.startDeviceFlow(clientId, call);
  options.onCode(code);
  let interval = code.intervalMs;
  for (;;) {
    await wait(clock, interval, signal);
    if (clock.now() >= code.expiresAt) throw new AppError('host.signInExpired');
    const poll = await host.pollDeviceFlow(clientId, code.deviceCode, call);
    switch (poll.kind) {
      case 'pending':
        break;
      case 'slowDown':
        interval = Math.max(poll.intervalMs, interval + SLOW_DOWN_MS);
        break;
      case 'denied':
        throw new AppError('host.signInDenied');
      case 'expired':
        throw new AppError('host.signInExpired');
      case 'token':
        return poll.tokens;
    }
  }
}

/** Waits on the clock; a cancelled wait fails as `command.cancelled`. */
export function wait(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('command.cancelled'));
      return;
    }
    const onAbort = () => {
      timer.cancel();
      reject(new AppError('command.cancelled'));
    };
    const timer = clock.setTimer(ms, () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface CredentialForOptions {
  readonly endpoint: HostEndpoint;
  /** Keys go with SSH URLs, tokens and the device flow with HTTPS ones. */
  readonly transport: 'https' | 'ssh';
  readonly method: SignInRequest;
  readonly host: (endpoint: HostEndpoint) => Host;
  readonly clock: Clock;
  /** The app's own client id for github.com or gitlab.com; null on self-hosted servers. */
  readonly builtInClientId: (endpoint: HostEndpoint) => string | null;
  readonly signal?: AbortSignal;
  readonly onCode?: (code: DeviceCode) => void;
}

/** Signs in and returns what main keeps: for the setup, and for the access-lost state's [Sign in again]. */
export async function credentialFor(options: CredentialForOptions): Promise<HostCredential> {
  const { endpoint, method } = options;
  const ssh = options.transport === 'ssh';
  if (ssh !== (method.kind === 'ssh-key' || method.kind === 'ssh-agent')) {
    throw new AppError('host.notSupported', { feature: method.kind });
  }
  switch (method.kind) {
    case 'ssh-key':
      return { method: 'ssh-key', privateKey: method.privateKey };
    case 'ssh-agent':
      return { method: 'ssh-agent' };
    case 'token':
      return {
        method: 'token',
        host: endpoint.kind,
        origin: endpoint.origin,
        token: method.token.trim(),
        username: method.username?.trim() || defaultTokenUser(endpoint.kind),
      };
    case 'device': {
      if (endpoint.kind === 'plain') throw new AppError('host.notSupported', { feature: 'deviceFlow' });
      const clientId = method.clientId?.trim() || options.builtInClientId(endpoint);
      if (!clientId) throw new AppError('host.clientIdRequired');
      const tokens = await deviceSignIn({
        host: options.host(endpoint),
        clientId,
        clock: options.clock,
        ...(options.signal ? { signal: options.signal } : {}),
        onCode: (code) => options.onCode?.(code),
      });
      return {
        method: 'device',
        host: endpoint.kind,
        origin: endpoint.origin,
        clientId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      };
    }
  }
}

/** A host's endpoint from what an instance remembers about it (HostAccount): where its API is. */
export function endpointFor(kind: HostKind, origin: string, selfHosted: boolean): HostEndpoint {
  if (kind === 'plain') return { kind, origin, apiBase: null, selfHosted };
  if (!selfHosted) {
    return kind === 'github'
      ? { kind, origin, apiBase: 'https://api.github.com', selfHosted }
      : { kind, origin, apiBase: `${origin}/api/v4`, selfHosted };
  }
  return { kind, origin, apiBase: `${origin}${kind === 'github' ? '/api/v3' : '/api/v4'}`, selfHosted };
}
