// The test API (TESTING.md §6, IMPLEMENTATION.md §2.16). It exists only in test builds: main serves it to Playwright
// and the drive tool, and forwards instance calls to the workers. Production code never imports this file, and the
// packaging check looks for its marker in production bundles (A1.6).
import { z } from 'zod';
import { api, command, query } from '../contract.ts';

export const TEST_API_MARKER = 'test-api:v1:only-in-test-builds';

/** Every test starts its clock here: 2026-01-15 09:00 UTC (TESTING.md §6). */
export const TEST_CLOCK_START = Date.UTC(2026, 0, 15, 9, 0, 0);

const Empty = z.object({});
/** An instance by name ("Acme") or id. */
const InstanceRef = z.string().min(1).max(100);

export const FaultActionSchema = z.enum(['crash', 'throw', 'hang', 'delay']);
export type FaultAction = z.infer<typeof FaultActionSchema>;

export const FaultArmSchema = z.object({
  /** A named fault point, e.g. `op:sample:step-2:before` (TESTING.md §9.3). */
  point: z.string().min(1).max(200),
  action: FaultActionSchema,
  delayMs: z.number().int().nonnegative().max(600_000).optional(),
  /** How many hits to skip before acting; the default 0 acts on the first hit. */
  skip: z.number().int().nonnegative().optional(),
});
export type FaultArm = z.infer<typeof FaultArmSchema>;

export const TreeEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(['file', 'dir', 'link', 'other']),
  size: z.number().int().nonnegative().optional(),
  sha256: z.string().optional(),
  target: z.string().optional(),
});
export type TreeEntry = z.infer<typeof TreeEntrySchema>;

export const TrayItemSchema = z.object({
  label: z.string(),
  enabled: z.boolean(),
  kind: z.enum(['normal', 'separator', 'instance']),
});

export const RecordedSchema = z.object({
  openedLinks: z.array(z.string()),
  notifications: z.array(z.object({ kind: z.string(), title: z.string(), body: z.string() })),
  tray: z.object({ tooltip: z.string(), count: z.number().int().nonnegative(), items: z.array(TrayItemSchema) }),
  clipboard: z.array(z.string()),
  loginItem: z.object({ openAtLogin: z.boolean() }).nullable(),
  trashed: z.array(z.string()),
  protocolRegistrations: z.array(z.string()),
  dialogs: z.array(z.object({ kind: z.string(), purpose: z.string(), answer: z.string().nullable() })),
});
export type Recorded = z.infer<typeof RecordedSchema>;

export const DialogAnswerSchema = z.object({
  /** A folder or file path, or null for "Cancel". */
  path: z.string().nullable(),
});

const ArrangePlacementShape = {
  repos: z.array(z.string().min(1).max(4096)).max(100).default([]),
  roots: z.array(z.string().min(1).max(4096)).max(100).default([]),
  /** Placement edits (PLAN.md §3.6), with each `repo` given by its name. */
  edits: z.array(z.record(z.string(), z.json())).max(1000).default([]),
};

export const testApi = api({
  queries: {
    device: query(Empty, z.json()),
    dump: query(z.object({ instance: InstanceRef }), z.json()),
    tree: query(z.object({ path: z.string().min(1).max(4096) }), z.array(TreeEntrySchema)),
    /** The library's branch, HEAD, status, log and merge or rebase state; the first instance by default. */
    git: query(z.object({ instance: InstanceRef.optional() }), z.json()),
    recorded: query(Empty, RecordedSchema),
    logs: query(z.object({ tail: z.number().int().positive().max(10_000).optional() }), z.array(z.string())),
    marker: query(Empty, z.literal(TEST_API_MARKER)),
  },
  commands: {
    waitForIdle: command(
      z.object({ instance: InstanceRef.optional(), timeoutMs: z.number().int().positive().max(600_000).optional() }),
      Empty,
    ),
    clockAdvance: command(z.object({ ms: z.number().int().nonnegative() }), z.object({ now: z.number() })),
    clockSet: command(z.object({ time: z.number().int() }), z.object({ now: z.number() })),
    networkOnline: command(z.object({ online: z.boolean() }), Empty),
    powerSleep: command(Empty, Empty),
    powerWake: command(Empty, Empty),
    windowFocus: command(Empty, Empty),
    windowBlur: command(Empty, Empty),
    dialogsAnswer: command(z.object({ answers: z.array(DialogAnswerSchema).min(1) }), Empty),
    faultsArm: command(FaultArmSchema.extend({ instance: InstanceRef.optional() }), Empty),
    protocolOpen: command(z.object({ url: z.string().min(1).max(4096) }), Empty),
    /** Kills an instance's worker process, as a crash would (A1.2). */
    killWorker: command(z.object({ instance: InstanceRef }), Empty),
    /** Makes main send one request, to prove the recording proxy sees the app's traffic (A1.8). */
    networkProbe: command(
      z.object({ url: z.url() }),
      z.object({ status: z.number().int().nullable(), error: z.string().nullable() }),
    ),
    /** Makes an instance's worker take a device-wide lock and hold it until it exits (A1.12). */
    holdLock: command(
      z.object({ instance: InstanceRef, name: z.string().min(1).max(200) }),
      z.object({ held: z.boolean() }),
    ),
    /**
     * Trusts a certificate authority through the "extra certificates" setting, as a person adds a company's in
     * Settings: how tests make the app trust the fake hosts (TESTING.md §3 "No real network").
     */
    trustCertificate: command(z.object({ pem: z.string().min(1).max(100_000) }), Empty),
    /** Acts as a Linux computer without a keychain (libsecret or KWallet), or with one again (A4.13). */
    simulateKeyring: command(z.object({ available: z.boolean() }), Empty),
    /** What a tool's version or list command prints in test mode, where no real program runs (TESTING.md §3). */
    scriptToolCommand: command(
      z.object({
        program: z.string().min(1).max(200),
        stdout: z.string().max(100_000),
        code: z.number().int().default(0),
      }),
      Empty,
    ),
    /**
     * Joins a library with a token through the app's own setup flow, into the folder it suggests, then [Finish]: how
     * a world gets a joined library (TESTING.md §4 "through the app's own use cases").
     */
    joinLibrary: command(
      z.object({
        url: z.string().min(1).max(2048),
        token: z.string().min(1).max(10_000),
        identity: z.object({ name: z.string().min(1).max(200), email: z.string().min(1).max(200) }),
        /** When the git prefix is in use on the device (Step 8): this local prefix, else the one suggested. */
        localPrefix: z.string().min(1).max(100).optional(),
      }),
      z.object({ instanceId: z.string() }),
    ),
    /** Asks the host for an instance's role again, as the app does at every start (PLAN.md §3.11 "When"). */
    checkAccess: command(z.object({ instance: InstanceRef }), Empty),
    /** Enables exactly these tools for an instance, applying the plan it previews (PLAN.md §3.4). */
    enableTools: command(
      z.object({ instance: InstanceRef, tools: z.array(z.string().min(1).max(200)).max(200) }),
      Empty,
    ),
    /**
     * Adds repos and parent folders (paths relative to the test root), then applies placement edits whose `repo` is a
     * repo's name, each with the plan it previews (PLAN.md §3.6): the app state a Step 6 journey starts from.
     */
    arrangePlacement: command(z.object({ instance: InstanceRef, ...ArrangePlacementShape }), Empty),
    /** Starts a device operation and waits for it, e.g. the sample device operation (A1.19). */
    runDeviceOperation: command(
      z.object({ kind: z.string().min(1).max(100), instance: InstanceRef.optional() }),
      z.object({ operationId: z.string(), result: z.json() }),
    ),
  },
  events: {},
});

export type TestApi = typeof testApi;

/** What main forwards to a worker in test builds. */
export const workerTestApi = api({
  queries: {
    dump: query(Empty, z.json()),
    git: query(Empty, z.json()),
  },
  commands: {
    waitForIdle: command(Empty, Empty),
    faultsArm: command(FaultArmSchema, Empty),
    /** Takes a device-wide lock through main and holds it; resolves once held. */
    holdLock: command(z.object({ name: z.string().min(1).max(200) }), z.object({ held: z.boolean() })),
    enableTools: command(z.object({ tools: z.array(z.string().min(1).max(200)).max(200) }), Empty),
    arrangePlacement: command(z.object(ArrangePlacementShape), Empty),
    /** The setup wizard's pages with no tools and no repos (Step 15): the summary's plan hash, for [Finish]. */
    setupDefaults: command(Empty, z.object({ hash: z.string() })),
    /** Makes an automatic backup of instance.db now, as the daily one does (Step 9, PLAN.md §3.5). */
    backupDatabase: command(Empty, z.object({ file: z.string() })),
    /** Asks the host for the role again, as the app does at every start (Step 12, PLAN.md §3.11 "When"). */
    checkAccess: command(Empty, Empty),
  },
  events: {},
});

export type WorkerTestApi = typeof workerTestApi;
