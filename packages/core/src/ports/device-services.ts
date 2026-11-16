// What main provides to workers (IMPLEMENTATION.md §2.1): device-wide locks, secrets and device facts.
export interface DeviceLock {
  readonly name: string;
  release(): Promise<void>;
}

export interface DeviceFacts {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly online: boolean;
  /** The certificate bundle for git and HTTP: the OS trust store plus the extra certificates (ADR 0015). */
  readonly caBundlePath: string | null;
  /**
   * How main keeps secrets: `os` in the OS's keychain; `weak` on Linux without a keyring (libsecret or KWallet), where
   * the app warns before a secret is kept with weaker protection (PLAN.md §2 "Secrets").
   */
  readonly secretStorage: 'os' | 'weak';
}

export interface DeviceServices {
  /**
   * Waits for a device-wide lock. Hold it for one read-modify-write of a shared file and never nest locks
   * (IMPLEMENTATION.md §2.13 rule 8). Main releases it if the worker exits.
   */
  lock(name: string, options?: { signal?: AbortSignal }): Promise<DeviceLock>;
  /** Secrets stay in main; a worker holds one only while it uses it (rule 9). */
  secret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  facts(): Promise<DeviceFacts>;
  proxyFor(url: string): Promise<string | null>;
}

/** Runs `fn` while holding a device-wide lock, and always releases it. */
export async function withDeviceLock<T>(
  services: DeviceServices,
  name: string,
  fn: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const lock = await services.lock(name, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
