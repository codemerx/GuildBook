// TanStack Query over the contracts (IMPLEMENTATION.md §2.8): query keys follow the contracts, and one table maps each
// event to the queries it refreshes. A new port for an instance (its worker restarted) refreshes all of that instance.
import type { DeviceApi, InstanceApi, InviteView } from '@app/ipc';
import { QueryClient, useMutation, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import type { Connection } from './connection.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

type DeviceQueries = DeviceApi['queries'];
type DeviceCommands = DeviceApi['commands'];
type InstanceQueries = InstanceApi['queries'];
type InstanceCommands = InstanceApi['commands'];

export const keys = {
  device: <K extends keyof DeviceQueries>(name: K) => ['device', name] as const,
  instance: <K extends keyof InstanceQueries>(instanceId: string, name: K) => ['instance', instanceId, name] as const,
  instanceAll: (instanceId: string) => ['instance', instanceId] as const,
};

let current: Connection | undefined;

export function useDeviceQuery<K extends keyof DeviceQueries>(name: K) {
  return useQuery({
    queryKey: keys.device(name),
    queryFn: async () => {
      const client = await (current as Connection).device();
      return (client.query[name] as (input: object) => Promise<z.output<DeviceQueries[K]['output']>>)({});
    },
  });
}

export function useInstanceQuery<K extends keyof InstanceQueries>(instanceId: string | undefined, name: K) {
  return useQuery({
    queryKey: keys.instance(instanceId ?? '', name),
    enabled: instanceId !== undefined,
    queryFn: async () => {
      const client = await (current as Connection).instance(instanceId as string);
      return (client.query[name] as (input: object) => Promise<z.output<InstanceQueries[K]['output']>>)({});
    },
  });
}

/** A device query with input, e.g. the URL check as the user types. */
export function useDeviceQueryWith<K extends keyof DeviceQueries>(
  name: K,
  input: z.input<DeviceQueries[K]['input']>,
  enabled = true,
) {
  return useQuery({
    queryKey: [...keys.device(name), input],
    enabled,
    queryFn: async () => {
      const client = await (current as Connection).device();
      return (client.query[name] as (i: unknown) => Promise<z.output<DeviceQueries[K]['output']>>)(input);
    },
  });
}

/** A device command, with its progress messages (e.g. the sign-in code, the download's progress). */
export async function callDevice<K extends keyof DeviceCommands>(
  name: K,
  input: z.input<DeviceCommands[K]['input']>,
  onProgress?: (progress: never) => void,
): Promise<z.output<DeviceCommands[K]['output']>> {
  const client = await (current as Connection).device();
  const call = client.command[name] as (
    i: unknown,
    o?: { onProgress?: (p: never) => void },
  ) => Promise<z.output<DeviceCommands[K]['output']>>;
  return call(input, onProgress ? { onProgress } : undefined);
}

/** An instance query called once, e.g. a plan to preview before [Apply]. */
export async function queryInstance<K extends keyof InstanceQueries>(
  instanceId: string,
  name: K,
  input: z.input<InstanceQueries[K]['input']>,
): Promise<z.output<InstanceQueries[K]['output']>> {
  const client = await (current as Connection).instance(instanceId);
  return (client.query[name] as (i: unknown) => Promise<z.output<InstanceQueries[K]['output']>>)(input);
}

/** An instance query with input, e.g. the plan for the tools the user ticked. */
export function useInstanceQueryWith<K extends keyof InstanceQueries>(
  instanceId: string | undefined,
  name: K,
  input: z.input<InstanceQueries[K]['input']>,
  enabled = true,
) {
  return useQuery({
    queryKey: [...keys.instance(instanceId ?? '', name), input],
    enabled: enabled && instanceId !== undefined,
    queryFn: () => queryInstance(instanceId as string, name, input),
  });
}

/** An instance command, with its progress messages. */
export async function callInstance<K extends keyof InstanceCommands>(
  instanceId: string,
  name: K,
  input: z.input<InstanceCommands[K]['input']>,
  onProgress?: (progress: never) => void,
): Promise<z.output<InstanceCommands[K]['output']>> {
  const client = await (current as Connection).instance(instanceId);
  const call = client.command[name] as (
    i: unknown,
    o?: { onProgress?: (p: never) => void },
  ) => Promise<z.output<InstanceCommands[K]['output']>>;
  return call(input, onProgress ? { onProgress } : undefined);
}

export function useDeviceCommand<K extends keyof DeviceCommands>(name: K) {
  return useMutation({
    mutationFn: async (input: z.input<DeviceCommands[K]['input']>) => {
      const client = await (current as Connection).device();
      return (client.command[name] as (i: unknown) => Promise<z.output<DeviceCommands[K]['output']>>)(input);
    },
  });
}

/** The git screens' queries (Step 11): they change with the library's git state. */
const SYNC_QUERIES = [
  'syncStatus',
  'changes',
  'changeDiff',
  'incoming',
  'conflicts',
  'conflictFile',
  'branches',
  'stashes',
  'gitHistory',
  // Step 12: the branch decides what the role allows and which request is the branch's.
  'reviewStatus',
  // Step 14: the lock comes from the fetched company branch, and the warning lists what the library has now.
  'prefix',
  'previewPrefixChange',
] as const;

/** Roles, change requests and signing (Step 12): they change with the host's answers and the app's own actions. */
const REVIEW_QUERIES = ['reviewStatus', 'signing'] as const;

/** Wires events to the cache: the invalidation table (IMPLEMENTATION.md §2.8). */
export function connectCache(
  connection: Connection,
  onShowInstance: (instanceId: string) => void,
  onInvite: (invite: InviteView) => void = () => undefined,
): void {
  current = connection;
  connection.onDevice((client) => {
    // An invite link (Step 15): one that arrived before the window connected waits in main.
    client.on('inviteOpened', onInvite);
    void client.query
      .invite({})
      .then((invite) => invite && onInvite(invite))
      .catch(() => undefined);
    client.on('instancesChanged', ({ instances }) => {
      queryClient.setQueryData(keys.device('instances'), instances);
      // "You're already connected to …" follows the libraries on this device.
      void queryClient.invalidateQueries({ queryKey: keys.device('checkUrl') });
      // Another library added, moved or removed: whether a local prefix is still needed may change (S12).
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'instance' && query.queryKey[2] === 'localPrefix',
      });
    });
    client.on('settingsChanged', (settings) => queryClient.setQueryData(keys.device('settings'), settings));
    client.on('showInstance', ({ instanceId }) => onShowInstance(instanceId));
    client.on('setupsChanged', ({ setups }) => queryClient.setQueryData(keys.device('setups'), setups));
    client.on('toolSettingsChanged', (settings) => queryClient.setQueryData(keys.device('toolSettings'), settings));
    client.on('windowModeChanged', (mode) => queryClient.setQueryData(keys.device('windowMode'), mode));
    client.on('updatesChanged', (view) => queryClient.setQueryData(keys.device('updates'), view));
    void queryClient.invalidateQueries({ queryKey: ['device'] });
  });
  connection.onInstance((instanceId, client) => {
    client.on('statusChanged', (status) => queryClient.setQueryData(keys.instance(instanceId, 'status'), status));
    client.on('libraryChanged', () => {
      // The skills page lists the library's skills with their links.
      for (const name of [
        'librarySnapshot',
        'skillLinks',
        'overview',
        'skillFiles',
        'importOffers',
        // The setup wizard shows the library's skills, tags and instructions (Step 15).
        'setupWizard',
        'setupSummary',
      ] as const) {
        void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId, name) });
      }
    });
    // Something in the library folder or its .git changed: the git state, and the editor's file, files and history
    // (Step 10: a file changed on disk reloads in the editor).
    client.on('gitChanged', () => {
      for (const name of [
        'libraryGit',
        'libraryFile',
        'skillFiles',
        'history',
        'setupWizard',
        ...SYNC_QUERIES,
      ] as const) {
        void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId, name) });
      }
    });
    // The git screens (Step 11): a fetch, a commit, a pull, a conflict resolved. The activity log has its entry.
    client.on('syncChanged', () => {
      // An imported skill may have reached the company version: its original can be replaced (Step 13).
      for (const name of [...SYNC_QUERIES, 'activity', 'importOffers'] as const) {
        void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId, name) });
      }
    });
    client.on('accessChanged', (access) => queryClient.setQueryData(keys.instance(instanceId, 'access'), access));
    client.on('reviewChanged', () => {
      for (const name of [...REVIEW_QUERIES, 'activity'] as const) {
        void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId, name) });
      }
    });
    // Imports (Step 13): the import under way, the review of each skill, and the originals that can be replaced.
    client.on('importChanged', () => {
      for (const name of ['importSession', 'importFile', 'importOffers', 'activity'] as const) {
        void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId, name) });
      }
      void queryClient.invalidateQueries({ queryKey: ['instance', instanceId, 'importReview'] });
    });
    // The prefix (Step 14): its lock, a change that waits for a local prefix, and the local prefix after a change.
    client.on('prefixChanged', () => {
      for (const name of [
        'prefix',
        'previewPrefixChange',
        'previewAdoptPrefix',
        'attention',
        'localPrefix',
        'incoming',
        'activity',
      ] as const) {
        void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId, name) });
      }
    });
    // Links, warnings, the activity log, the tools page and the placement overview change together (Steps 5, 6).
    client.on('linksChanged', () => {
      for (const name of [
        'skillLinks',
        'attention',
        'activity',
        'tools',
        'overview',
        'placementAnalysis',
        'doctor',
        // The local prefix's view: its skipped skills and the copies that wait (Step 8).
        'localPrefix',
        // A move that stopped, and the connections that wait for recovery (Step 9).
        'relocation',
        'recovery',
        // What each tool reads through its links (Step 10).
        'agentView',
        // A repo added on the wizard's repos page (Step 15).
        'setupWizard',
        'setupSummary',
      ] as const) {
        void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId, name) });
      }
    });
    // The setup wizard's answers (Step 15): its page and the summary's plan.
    client.on('setupChanged', () => {
      for (const name of ['setupWizard', 'setupSummary', 'overview'] as const) {
        void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId, name) });
      }
    });
    // The instructions changed (Step 7): the Instructions page, the Doctor and the activity log.
    client.on('instructionsChanged', () => {
      for (const name of ['instructions', 'doctor', 'activity'] as const) {
        void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId, name) });
      }
    });
    void queryClient.invalidateQueries({ queryKey: keys.instanceAll(instanceId) });
  });
}
