// What the review module's use cases share (IMPLEMENTATION.md Step 12, PLAN.md §3.11): the library's repo and the git
// screens, the host's API with the signed-in token (for the signing key), the role the host gave, and the signing keys.
import type { HostAccount, InstanceSettings } from '@app/schemas';
import type { ActivityLog } from '../../activity/index.ts';
import type { InstanceEngine } from '../../engine/index.ts';
import type { Clock } from '../../ports/clock.ts';
import type { DeviceServices } from '../../ports/device-services.ts';
import type { GitRepo } from '../../ports/git.ts';
import type { Host } from '../../ports/host.ts';
import type { Logger } from '../../ports/logger.ts';
import type { SigningKeySource } from '../../ports/signing-keys.ts';
import type { Store } from '../../ports/store.ts';
import type { SyncService } from '../../sync/index.ts';

/** The host's API for this library: GitHub or GitLab with the signed-in token. */
export interface ReviewApi {
  readonly host: Host;
  readonly token: string;
  /** e.g. `acme/agent-library`. */
  readonly repoPath: string;
}

export interface ReviewDeps {
  readonly engine: InstanceEngine;
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly activity: ActivityLog;
  readonly repo: GitRepo;
  readonly sync: SyncService;
  readonly services: DeviceServices;
  readonly keys: SigningKeySource;
  /** The host's API, or null: a plain git server, a key instead of an account, or a test library. */
  readonly api: () => Promise<ReviewApi | null>;
  /** The product's name, for the name of a key it creates. */
  readonly appName: string;
  readonly deviceName: () => string;
  /** Asks the host for the role again, in its own command (PLAN.md §3.11 "When": after a rejection). */
  readonly recheckAccess: () => void;
  /**
   * The page that makes a change request from the host kind (ADR 0032), for when the server sent no link with the
   * push: GitHub's and GitLab's; null on a plain git server, or for a test library.
   */
  readonly newRequestUrl: (branch: string, base: string) => Promise<string | null>;
  /** The role's view or a branch changed: the renderer asks again. */
  readonly onChange: () => void;
}

/** The secrets service's key for the signing key the app created (main keeps one namespace per instance). */
export const SIGNING_KEY_SECRET = 'signing-key';

export function accountOf(store: Store): HostAccount | undefined {
  return store.read((tx) => tx.hostAccount.get());
}

export function settingsOf(store: Store): InstanceSettings {
  return store.read((tx) => tx.settings.get());
}

export function updateSettings(store: Store, change: Partial<InstanceSettings>): void {
  store.write((tx) => tx.settings.set({ ...tx.settings.get(), ...change }));
}
