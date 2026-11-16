// The device services main serves to each worker (IMPLEMENTATION.md §2.1): locks, secrets, device facts and
// notifications, plus the worker's report on its start. Secrets are kept per instance: instances never share state
// (PLAN.md §3.1).
import { AppError, type Logger } from '@app/core';
import type { DeviceFacts, DeviceServicesApi, Handlers, RpcEndpoint, ToolSettings } from '@app/ipc';
import type { NotificationSettings } from '@app/schemas';
import type { LockService } from './locks.ts';
import type { OsIntegrations } from './os/integrations.ts';
import type { SecretsService } from './secrets.ts';
import type { WorkerSupervisor } from './supervisor.ts';

export interface DeviceServicesDeps {
  readonly supervisor: WorkerSupervisor;
  readonly locks: LockService;
  readonly secrets: SecretsService;
  readonly os: OsIntegrations;
  readonly logger: Logger;
  readonly facts: () => DeviceFacts;
  readonly proxyFor: (url: string) => Promise<string | null>;
  readonly toolSettings: () => ToolSettings;
  /** Which types of notification are off, and Do not disturb (device.json, PLAN.md §3.19, Step 17). */
  readonly notificationSettings?: () => NotificationSettings;
  /** Whether an instance's instructions are linked on this device (device.json, PLAN.md §3.12). */
  readonly instructionsLinked?: (instanceId: string) => boolean;
  /** The other library whose instructions are linked on this device, by name, if one is. */
  readonly instructionsLinkedBy?: (instanceId: string) => string | null;
  /**
   * An instance's git prefix (Step 14) and local prefix, and the other instances' effective prefixes (device.json,
   * PLAN.md §3.2, §3.3).
   */
  readonly prefixes?: (instanceId: string) => {
    gitPrefix?: string | null;
    localPrefix: string | null;
    instances: Array<{ prefix: string; name: string }>;
  };
  /** Records an instance's local prefix in device.json (Step 8). */
  readonly setLocalPrefix?: (instanceId: string, prefix: string | null) => Promise<void>;
  /** Records an instance's new git prefix after a prefix change (Step 14). */
  readonly setGitPrefix?: (instanceId: string, prefix: string) => Promise<void>;
  /** Where a library folder can't go: the other libraries and every instance's repos (Step 9, PLAN.md §3.9). */
  readonly locationContext?: (instanceId: string) => {
    libraries: Array<{ name: string; path: string }>;
    repos: string[];
  };
  /** Records the library's new place in device.json (Step 9). */
  readonly setLibraryPath?: (instanceId: string, path: string) => Promise<void>;
  /** Starts the instance's worker again from device.json (Step 9). */
  readonly restart?: (instanceId: string) => void;
  readonly onAttention: (instanceId: string, count: number) => void;
  /** ↓ incoming and ↑ to push (Step 11): the switcher and the tray show them. */
  readonly onSync?: (instanceId: string, counts: { incoming: number; toPush: number }) => void;
  readonly onRepos: (instanceId: string, paths: readonly string[]) => void;
  /** An instance lost its access to the host, or has it again (Step 4): the switcher and the tray show it. */
  readonly onAccess?: (instanceId: string, lost: boolean) => void;
}

export function deviceServicesHandlers(
  deps: DeviceServicesDeps,
  instanceId: string,
  endpoint: RpcEndpoint,
): Handlers<DeviceServicesApi> {
  const key = (name: string) => `${instanceId}/${name}`;
  return {
    queries: {
      facts: () => deps.facts(),
      proxyFor: async ({ url }) => ({ proxy: await deps.proxyFor(url) }),
      secret: async ({ key: name }) => ({ value: await deps.secrets.get(key(name)) }),
      toolSettings: () => deps.toolSettings(),
      instructionsLinked: () => ({
        linked: deps.instructionsLinked?.(instanceId) ?? false,
        linkedBy: deps.instructionsLinkedBy?.(instanceId) ?? null,
      }),
      prefixes: () => deps.prefixes?.(instanceId) ?? { localPrefix: null, instances: [] },
      locationContext: () => deps.locationContext?.(instanceId) ?? { libraries: [], repos: [] },
    },
    commands: {
      reportLifecycle: (report) => {
        deps.supervisor.reportLifecycle(instanceId, endpoint, report);
        return {};
      },
      acquireLock: async ({ name }, context) => ({ token: await deps.locks.acquire(name, instanceId, context.signal) }),
      releaseLock: ({ name, token }) => {
        deps.locks.release(name, token);
        return {};
      },
      setSecret: async ({ key: name, value }) => {
        await deps.secrets.set(key(name), value);
        return {};
      },
      deleteSecret: async ({ key: name }) => {
        await deps.secrets.delete(key(name));
        return {};
      },
      notify: (notification) => {
        const settings = deps.notificationSettings?.() ?? { off: [], doNotDisturb: false };
        // Held back, not queued: the app's own pages still show what the notification was about.
        if (settings.doNotDisturb || settings.off.includes(notification.kind)) {
          deps.logger.info('a notification was held back', {
            kind: notification.kind,
            reason: settings.doNotDisturb ? 'do-not-disturb' : 'type-off',
          });
          return {};
        }
        deps.os.notifications.show(notification);
        return {};
      },
      reportAttention: ({ count }) => {
        deps.onAttention(instanceId, count);
        return {};
      },
      reportSync: ({ incoming, toPush }) => {
        deps.onSync?.(instanceId, { incoming, toPush });
        return {};
      },
      reportAccess: ({ lost }) => {
        deps.onAccess?.(instanceId, lost);
        return {};
      },
      reportRepos: ({ paths }) => {
        deps.onRepos(instanceId, paths);
        return {};
      },
      setLocalPrefix: async ({ localPrefix }) => {
        if (!deps.setLocalPrefix) throw new AppError('feature.unavailable', { feature: 'localPrefix' });
        await deps.setLocalPrefix(instanceId, localPrefix);
        return {};
      },
      setGitPrefix: async ({ gitPrefix }) => {
        if (!deps.setGitPrefix) throw new AppError('feature.unavailable', { feature: 'prefixChange' });
        await deps.setGitPrefix(instanceId, gitPrefix);
        return {};
      },
      setLibraryPath: async ({ path }) => {
        if (!deps.setLibraryPath) throw new AppError('feature.unavailable', { feature: 'relocation' });
        await deps.setLibraryPath(instanceId, path);
        return {};
      },
      restart: () => {
        if (!deps.restart) throw new AppError('feature.unavailable', { feature: 'relocation' });
        deps.restart(instanceId);
        return {};
      },
    },
  };
}
