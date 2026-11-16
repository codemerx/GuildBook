// The DeviceServices port in a worker: main's locks, secrets and facts, reached over the worker's port
// (IMPLEMENTATION.md §2.1). Secrets are held in memory only while they're used (§2.13 rule 9).
import type { DeviceServices } from '@app/core';
import type { Client, DeviceServicesApi } from '@app/ipc';

export function remoteDeviceServices(client: Client<DeviceServicesApi>): DeviceServices {
  return {
    async lock(name, options = {}) {
      const { token } = await client.command.acquireLock({ name }, options.signal ? { signal: options.signal } : {});
      let released = false;
      return {
        name,
        release: async () => {
          if (released) return;
          released = true;
          await client.command.releaseLock({ name, token });
        },
      };
    },
    secret: async (key) => (await client.query.secret({ key })).value,
    setSecret: async (key, value) => void (await client.command.setSecret({ key, value })),
    deleteSecret: async (key) => void (await client.command.deleteSecret({ key })),
    facts: () => client.query.facts({}),
    proxyFor: async (url) => (await client.query.proxyFor({ url })).proxy,
  };
}

/**
 * The proxy and certificate bundle for a git or HTTP address (ADR 0015). Only HTTP(S) goes through a proxy: an SSH
 * address (`git@host:path`) or a folder isn't a URL main is asked about.
 */
export function networkFor(client: Client<DeviceServicesApi>) {
  return async (url: string): Promise<{ proxy: string | null; caBundle: string | null }> => {
    const web = /^https?:\/\//i.test(url);
    const [{ proxy }, facts] = await Promise.all([
      web ? client.query.proxyFor({ url }) : Promise.resolve({ proxy: null }),
      client.query.facts({}),
    ]);
    return { proxy, caBundle: facts.caBundlePath };
  };
}
