// Main ↔ worker over the worker's port to main (IMPLEMENTATION.md §2.1). The worker serves workerApi to main, and
// main serves deviceServicesApi to the worker: locks, secrets, device facts, network and power events.
import { ErrorViewSchema, NotificationTypeSchema, OperationIdSchema } from '@app/schemas';
import { z } from 'zod';
import { api, command, query } from '../contract.ts';
import { DoctorViewSchema } from './instruction-views.ts';
import { CustomToolViewSchema } from './link-views.ts';
import { InstanceStatusViewSchema } from './views.ts';

const Empty = z.object({});

export const workerApi = api({
  queries: {
    /** The supervisor's health ping (IMPLEMENTATION.md §2.1). */
    ping: query(
      z.object({ seq: z.number().int().nonnegative() }),
      z.object({ seq: z.number().int().nonnegative(), busy: z.boolean(), queued: z.number().int().nonnegative() }),
    ),
    /**
     * The Doctor report, for Export diagnostics (PLAN.md §3.13, Step 16); null while the instance has no link engine
     * (a setup in progress).
     */
    doctorReport: query(Empty, DoctorViewSchema.nullable()),
  },
  commands: {
    /** Close the database and exit. */
    shutdown: command(Empty, Empty),
    /** A file from the library for the asset protocol; the worker refuses paths outside the library. */
    readAsset: command(
      z.object({ path: z.string().min(1).max(4096) }),
      z.object({ bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array), mimeType: z.string() }),
    ),
    /** The worker's part of a device operation (IMPLEMENTATION.md §2.6). */
    runDeviceOperationStep: command(
      z.object({
        operationId: OperationIdSchema,
        kind: z.string().min(1).max(100),
        step: z.string().min(1).max(100),
        params: z.record(z.string(), z.json()),
      }),
      Empty,
    ),
    /**
     * The wizard's [Finish] (PLAN.md §3.17 step 10): applies the summary's plan if it still holds, and clears the setup
     * state; refused while the library needs a newer app.
     */
    finishSetup: command(z.object({ planHash: z.string().min(1).max(200) }), Empty),
    /** Points the library at another URL, after checking that its library.yaml id is this library's (PLAN.md §3.1). */
    changeUrl: command(z.object({ url: z.string().min(1).max(2048) }), Empty),
  },
  events: {
    statusChanged: InstanceStatusViewSchema,
  },
});

export type WorkerApi = typeof workerApi;

/** A worker tells main how its start went. A command, not an event, so it can't be missed. */
export const LifecycleReportSchema = z.object({
  state: z.enum(['starting', 'ready', 'failed']),
  error: ErrorViewSchema.nullable(),
});
export type LifecycleReport = z.infer<typeof LifecycleReportSchema>;

export const DeviceFactsSchema = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  online: z.boolean(),
  /** The bundle git and the HTTP client trust: the OS trust store plus the extra certificates (ADR 0015). */
  caBundlePath: z.string().nullable(),
  /** `weak` on Linux without a keyring: the app warns before a secret is kept with weaker protection (PLAN.md §2). */
  secretStorage: z.enum(['os', 'weak']),
});
export type DeviceFacts = z.infer<typeof DeviceFactsSchema>;

export const ToolSettingsSchema = z.object({
  customTools: z.array(CustomToolViewSchema),
  toolFolders: z.record(z.string(), z.string()),
  homeEnv: z.record(z.string(), z.string()),
  prefixesInUse: z.array(z.string()),
  /** Every library folder on the device: never taken as a code repo (PLAN.md §3.6 "Adding repos"). */
  libraryFolders: z.array(z.string()),
});
export type ToolSettings = z.infer<typeof ToolSettingsSchema>;

export const NotificationKindSchema = NotificationTypeSchema;

export const deviceServicesApi = api({
  queries: {
    facts: query(Empty, DeviceFactsSchema),
    /** The proxy for one URL, from the OS settings or the login shell (IMPLEMENTATION.md §2.9). */
    proxyFor: query(z.object({ url: z.url() }), z.object({ proxy: z.string().nullable() })),
    secret: query(z.object({ key: z.string().min(1).max(200) }), z.object({ value: z.string().nullable() })),
    /**
     * The device's tool settings (PLAN.md §3.4): custom tools and changed tool folders from device.json, the tools'
     * `home_env` variables from the environment or the login shell, and the prefixes in use on the device.
     */
    toolSettings: query(Empty, ToolSettingsSchema),
    /**
     * Whether this instance's instructions are linked on this device: device.json (PLAN.md §3.12). `linkedBy` names the
     * library whose instructions are linked instead, if one is (the setup summary says so, Step 15).
     */
    instructionsLinked: query(Empty, z.object({ linked: z.boolean(), linkedBy: z.string().nullable().optional() })),
    /**
     * This instance's git prefix (the one its links follow, Step 14) and local prefix, and the other instances'
     * effective prefixes: device.json (PLAN.md §3.2, §3.3).
     */
    prefixes: query(
      Empty,
      z.object({
        gitPrefix: z.string().nullable().optional(),
        localPrefix: z.string().nullable(),
        instances: z.array(z.object({ prefix: z.string(), name: z.string() })),
      }),
    ),
    /**
     * Where a library folder can't go (PLAN.md §3.9 step 0): the other libraries, and every instance's added repos.
     */
    locationContext: query(
      Empty,
      z.object({
        libraries: z.array(z.object({ name: z.string(), path: z.string() })),
        repos: z.array(z.string()),
      }),
    ),
  },
  commands: {
    reportLifecycle: command(LifecycleReportSchema, Empty),
    /** The instance's count of red warnings, for the tray (PLAN.md §3.8 "Needs attention"). */
    reportAttention: command(z.object({ count: z.number().int().nonnegative() }), Empty),
    /** ↓ incoming and ↑ to push, for the switcher and the tray (Step 11, PLAN.md §3.10). */
    reportSync: command(
      z.object({ incoming: z.number().int().nonnegative(), toPush: z.number().int().nonnegative() }),
      Empty,
    ),
    /**
     * Whether the instance has lost its access to the host (PLAN.md §3.11 "When"), for the switcher, the page header and
     * the tray: a worker that runs but cannot sync must not show a green "Ready".
     */
    reportAccess: command(z.object({ lost: z.boolean() }), Empty),
    /** The instance's added code repos: a new library folder can't go inside one (PLAN.md §3.9, Step 6). */
    reportRepos: command(z.object({ paths: z.array(z.string().min(1).max(4096)).max(10_000) }), Empty),
    /** Waits for a device-wide lock (IMPLEMENTATION.md §2.13 rule 8). Main releases it if the worker exits. */
    acquireLock: command(z.object({ name: z.string().min(1).max(200) }), z.object({ token: z.string() })),
    releaseLock: command(z.object({ name: z.string().min(1).max(200), token: z.string().max(100) }), Empty),
    setSecret: command(z.object({ key: z.string().min(1).max(200), value: z.string().max(65_536) }), Empty),
    deleteSecret: command(z.object({ key: z.string().min(1).max(200) }), Empty),
    /** Records this instance's local prefix in device.json (Step 8): a durable operation's step, so idempotent. */
    setLocalPrefix: command(z.object({ localPrefix: z.string().min(3).max(16).nullable() }), Empty),
    /** Records the library's new git prefix in device.json after a prefix change (Step 14): an operation's step. */
    setGitPrefix: command(z.object({ gitPrefix: z.string().min(3).max(16) }), Empty),
    /** Records the library's new place in device.json (Step 9, PLAN.md §3.9 step 6): an operation's step, idempotent. */
    setLibraryPath: command(z.object({ path: z.string().min(1).max(4096) }), Empty),
    /** Starts this worker again with device.json's record, e.g. at the library's new place (§3.9 step 8). */
    restart: command(Empty, Empty),
    notify: command(
      z.object({ kind: NotificationKindSchema, title: z.string().max(200), body: z.string().max(2000) }),
      Empty,
    ),
  },
  events: {
    network: z.object({ online: z.boolean() }),
    power: z.object({ state: z.enum(['suspend', 'resume']) }),
    focus: z.object({ focused: z.boolean() }),
    /** The test clock moved: workers follow main's clock (TESTING.md §6). */
    clock: z.object({ offsetMs: z.number() }),
    factsChanged: Empty,
    /** A custom tool or a tool folder changed: the workers check their links again. */
    toolSettingsChanged: Empty,
    /** The device's choice of linked instructions changed (PLAN.md §3.12): the worker checks them again. */
    instructionsChanged: Empty,
  },
});

export type DeviceServicesApi = typeof deviceServicesApi;
