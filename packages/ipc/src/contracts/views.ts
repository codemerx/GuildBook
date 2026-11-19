// View models (DTOs) that cross process boundaries. The renderer sees these, never core's types
// (IMPLEMENTATION.md §2.8).
import { ErrorViewSchema, InstanceIdSchema, NotificationSettingsSchema, ThemeSchema } from '@app/schemas';
import { z } from 'zod';
import { LocalPrefixPageSchema } from './projection-views.ts';

/**
 * An instance's lifecycle as the UI shows it (IMPLEMENTATION.md §2.1, §2.6): setting-up, ready and removing are
 * stored in device.json; pending, starting, restarting and error exist only while the app runs.
 */
export const InstanceStatusSchema = z.enum([
  'pending',
  'setting-up',
  'starting',
  'ready',
  'restarting',
  'error',
  'removing',
]);
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;

export const InstanceViewSchema = z.object({
  id: InstanceIdSchema,
  name: z.string(),
  status: InstanceStatusSchema,
  /** Why the instance is in the error state, e.g. instance.newerData. */
  error: ErrorViewSchema.nullable(),
  libraryPath: z.string(),
  gitUrl: z.string().nullable(),
  /** The effective prefix: the local one when it has one, else the git prefix. */
  prefix: z.string().nullable(),
  /** The local prefix on this device (Step 8, PLAN.md §3.3); null or left out when it has none. */
  localPrefix: z.string().nullable().optional(),
  /** The library's own prefix, from git; null or left out before it's known (Step 9: S12's offer to drop another's). */
  gitPrefix: z.string().nullable().optional(),
  /** How often its worker was restarted since the app started. */
  restarts: z.number().int().nonnegative(),
  /** Its red warnings, as "Needs attention" lists them (PLAN.md §3.8): the tray shows the count. */
  attention: z.number().int().nonnegative(),
  /** ↓ commits on the server not pulled yet, and ↑ commits not pushed yet (Step 11); left out before they're known. */
  incoming: z.number().int().nonnegative().optional(),
  toPush: z.number().int().nonnegative().optional(),
  /** Whether the company's instructions are linked on this device (PLAN.md §3.12). */
  instructionsLinked: z.boolean(),
  /** Its access to the host is lost: shown instead of "Ready", while the worker runs (PLAN.md §3.11); left out otherwise. */
  accessLost: z.boolean().optional(),
});
export type InstanceView = z.infer<typeof InstanceViewSchema>;

export const PlatformSchema = z.enum(['darwin', 'win32', 'linux']);

export const AppInfoSchema = z.object({
  version: z.string(),
  platform: PlatformSchema,
  arch: z.string(),
  /** The home folder, so paths can be shown as ~/… */
  homePath: z.string(),
  /** A test-hooks build started with a test root (TESTING.md §3). */
  testMode: z.boolean(),
  /**
   * Development and test builds show what production builds don't: test libraries, and developer pages such as the
   * library inspector (IMPLEMENTATION.md Step 2).
   */
  features: z.object({ testLibraries: z.boolean(), developerPages: z.boolean() }),
  /** `newerData` when device.json was written by a newer app version: the app asks to be updated. */
  deviceState: z.enum(['ok', 'newerData']),
  /** The clock's offset from the system clock, so the renderer shows the same time as main (TESTING.md §6). */
  clockOffsetMs: z.number(),
  /** Test runs only: the window shows the pseudo-locale (TESTING.md §7.2, Step 17). */
  locale: z.literal('pseudo').optional(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

/**
 * App updates (PLAN.md §3.19 "App updates", Step 18; ADR 0031): the daily check finds a newer version and tells the
 * user, who downloads and installs it from the release page. The tool catalog is not downloaded (ADR 0037).
 */
export const UpdateViewSchema = z.object({
  /** The running version. */
  version: z.string(),
  /** Whether this build checks for newer versions: false for a build without a release feed. */
  supported: z.boolean(),
  phase: z.enum(['idle', 'checking', 'available', 'up-to-date', 'failed']),
  /** The newer version that is out, once a check found it. */
  available: z.string().nullable(),
  /** The user put the notice away ([Later]): the banner shows again for a newer version, or at the next start. */
  dismissed: z.boolean(),
  /** The last check, ISO 8601; null before the first one. */
  lastCheckedAt: z.string().nullable(),
  /** Why the last check of the app failed (`update.failed`, `update.offline`). */
  error: ErrorViewSchema.nullable(),
});
export type UpdateView = z.infer<typeof UpdateViewSchema>;

/**
 * Export diagnostics (PLAN.md §3.13, Step 16): the redacted text the user reviews, which is exactly what [Save…]
 * writes, and what it holds.
 */
export const DiagnosticsViewSchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().max(64 * 1024 * 1024),
  parts: z.array(
    z.object({
      kind: z.enum(['summary', 'doctor', 'log']),
      title: z.string().max(1000),
      /** Its length in characters. */
      size: z.number().int().nonnegative(),
      /** A log longer than the part that goes in: its end only. */
      truncated: z.boolean(),
    }),
  ),
});
export type DiagnosticsView = z.infer<typeof DiagnosticsViewSchema>;

/** A company certificate authority the app trusts besides the OS store (PLAN.md §3.19, Step 18). */
export const CertificateViewSchema = z.object({
  /** SHA-256, as `AB:CD:…`. */
  fingerprint: z.string().max(200),
  subject: z.string().max(2000),
  /** When it expires, ISO 8601. */
  validTo: z.string().max(100),
});
export type CertificateView = z.infer<typeof CertificateViewSchema>;

export const DeviceSettingsViewSchema = z.object({
  theme: ThemeSchema,
  extraCertificateCount: z.number().int().nonnegative(),
  /** The extra certificates themselves (Step 18); left out by views from before. */
  extraCertificates: z.array(CertificateViewSchema).max(1000).optional(),
  launchAtLogin: z.boolean(),
  /** The notification types switched off, and Do not disturb (Step 17). */
  notifications: NotificationSettingsSchema,
});
export type DeviceSettingsView = z.infer<typeof DeviceSettingsViewSchema>;

/** What a worker reports about itself: the instance API's status query. */
export const InstanceStatusViewSchema = z.object({
  instanceId: InstanceIdSchema,
  name: z.string(),
  libraryPath: z.string(),
  dataFolder: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  /** The command running in the instance's queue, if any: a query sees it as in progress (A1.13). */
  busy: z
    .object({
      command: z.string(),
      progress: z.object({ done: z.number().int(), total: z.number().int() }).nullable(),
    })
    .nullable(),
  queued: z.number().int().nonnegative(),
});
export type InstanceStatusView = z.infer<typeof InstanceStatusViewSchema>;

/** One validation issue (IMPLEMENTATION.md Step 2): the renderer shows `messageKey` translated with `params`. */
export const IssueViewSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  messageKey: z.string(),
  /** Inside the library, with forward slashes. */
  path: z.string(),
  skill: z.string().nullable(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type IssueView = z.infer<typeof IssueViewSchema>;

export const SkillViewSchema = z.object({
  folder: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  source: z.string().nullable(),
  allowedTools: z.string().nullable(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  scripts: z.boolean(),
  /** git's tree id of the skill folder (PLAN.md §3.8). */
  fingerprint: z.string().nullable(),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
});
export type SkillView = z.infer<typeof SkillViewSchema>;

/** A library's snapshot, for the developer page that inspects it (development and test builds only). */
export const LibrarySnapshotViewSchema = z.object({
  /** loading until the first scan has finished. */
  state: z.enum(['loading', 'ready']),
  config: z.object({
    id: z.string().nullable(),
    prefix: z.string().nullable(),
    format: z.number().nullable(),
    minAppVersion: z.string().nullable(),
    repoOnlyTags: z.array(z.string()),
    suggest: z.record(z.string(), z.array(z.string())),
  }),
  compatibility: z.enum(['ok', 'formatTooNew', 'appTooOld', 'unknown']),
  skills: z.array(SkillViewSchema),
  instructions: z
    .object({ path: z.string(), bytes: z.number().int().nonnegative(), characters: z.number().int().nonnegative() })
    .nullable(),
  tags: z.array(z.object({ tag: z.string(), skills: z.array(z.string()) })),
  issues: z.array(IssueViewSchema),
});
export type LibrarySnapshotView = z.infer<typeof LibrarySnapshotViewSchema>;

/** One commit as the developer git page lists it. */
export const GitCommitViewSchema = z.object({
  id: z.string(),
  subject: z.string(),
  author: z.string(),
  /** Epoch milliseconds. */
  authorDate: z.number(),
  merge: z.boolean(),
});
export type GitCommitView = z.infer<typeof GitCommitViewSchema>;

export const GitChangeViewSchema = z.object({
  path: z.string(),
  /** For a rename recorded in the index: where it came from. */
  from: z.string().nullable(),
  change: z.enum(['modified', 'added', 'deleted', 'renamed', 'copied', 'typeChanged', 'untracked', 'conflicted']),
  /** Whether the change is staged. */
  staged: z.boolean(),
  conflict: z
    .enum(['bothModified', 'bothAdded', 'bothDeleted', 'addedByUs', 'addedByThem', 'deletedByUs', 'deletedByThem'])
    .nullable(),
});
export type GitChangeView = z.infer<typeof GitChangeViewSchema>;

/** The library's git state (Step 3's developer page, and the test API's `git`, TESTING.md §6). */
export const LibraryGitViewSchema = z.object({
  state: z.enum(['ready', 'notARepository', 'failed']),
  error: ErrorViewSchema.nullable(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  operation: z.enum(['none', 'merging', 'rebasing', 'cherryPicking', 'reverting']),
  busy: z.boolean(),
  changes: z.array(GitChangeViewSchema),
  /** The latest commits on the current branch. */
  log: z.array(GitCommitViewSchema),
  /** Fetched commits not in the branch yet (`HEAD..upstream`). */
  incoming: z.array(GitCommitViewSchema),
  stashes: z.number().int().nonnegative(),
});
export type LibraryGitView = z.infer<typeof LibraryGitViewSchema>;

// ---- Setting up and joining (Step 4) ------------------------------------------------------------------------------

export const SignInMethodViewSchema = z.enum(['device', 'token', 'ssh-key', 'ssh-agent']);
export const RoleViewSchema = z.enum(['viewer', 'member', 'maintainer', 'admin']);
export const HostKindViewSchema = z.enum(['github', 'gitlab', 'plain']);

/** The first page's check of a URL (PLAN.md §3.15): the host and repo shown before cloning, or why it's refused. */
export const UrlCheckViewSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), url: z.string(), name: z.string(), host: z.string(), repo: z.string() }),
  z.object({
    ok: z.literal(false),
    /** `gitUrl.*`: translated under `setup.url.<problem>`. */
    problem: z.string(),
    /** For `gitUrl.alreadyConnected`: the library it's connected as. */
    name: z.string().nullable(),
    instanceId: z.string().nullable(),
  }),
]);
export type UrlCheckView = z.infer<typeof UrlCheckViewSchema>;

const ParamsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/** The folder page's check (PLAN.md §3.17 step 3): problems refuse the folder, warnings don't. */
export const LocationCheckViewSchema = z.object({
  path: z.string(),
  problems: z.array(z.object({ code: z.string(), params: ParamsSchema })),
  warnings: z.array(z.object({ code: z.string(), params: ParamsSchema })),
});
export type LocationCheckView = z.infer<typeof LocationCheckViewSchema>;

export const SetupStepSchema = z.enum(['signIn', 'folder', 'download', 'prefix', 'localPrefix', 'done']);

/** A setup while its instance is pending: what the wizard shows (IMPLEMENTATION.md §2.1, Step 4). */
export const SetupViewSchema = z.object({
  id: z.string(),
  intent: z.enum(['join', 'create']),
  url: z.string(),
  name: z.string(),
  host: z.string(),
  repo: z.string(),
  hostKind: HostKindViewSchema.nullable(),
  selfHosted: z.boolean(),
  clientIdNeeded: z.boolean(),
  methods: z.array(SignInMethodViewSchema),
  step: SetupStepSchema,
  /** The code to type in the browser while a device-flow sign-in waits. */
  deviceCode: z.object({ userCode: z.string(), verificationUri: z.string() }).nullable(),
  signedIn: z
    .object({
      method: SignInMethodViewSchema,
      login: z.string().nullable(),
      role: RoleViewSchema.nullable(),
      identity: z.object({ name: z.string(), email: z.string() }).nullable(),
    })
    .nullable(),
  defaultFolder: z.string(),
  folder: LocationCheckViewSchema.nullable(),
  download: z.object({ phase: z.string(), percent: z.number().nullable() }).nullable(),
  library: z
    .object({
      id: z.string(),
      prefix: z.string().nullable(),
      needsUpdate: z.enum(['formatTooNew', 'appTooOld']).nullable(),
    })
    .nullable(),
  offer: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('sameLibrary'), instanceId: z.string(), name: z.string() }),
      z.object({ kind: z.literal('alreadySetUp') }),
    ])
    .nullable(),
  /** The local-prefix page, when the library's git prefix is in use on this device already (Step 8). */
  localPrefix: LocalPrefixPageSchema.nullable(),
  error: ErrorViewSchema.nullable(),
  /** On Linux without a keyring: the sign-in page warns before a secret is kept (A4.13). */
  weakStorage: z.boolean(),
  /** Set once the download is complete: the setup continues as this instance. */
  instanceId: z.string().nullable(),
  /** The client id an invite link carried, for a self-hosted server's sign-in (PLAN.md §3.17 step 2). */
  clientId: z.string().nullable(),
});
export type SetupView = z.infer<typeof SetupViewSchema>;

/** An instance's sign-in and access (Step 4): the access-lost state has three ways out. */
export const AccessViewSchema = z.object({
  state: z.enum(['unknown', 'ok', 'lost']),
  reason: z.enum(['revoked', 'notFound', 'signInAgain']).nullable(),
  host: HostKindViewSchema.nullable(),
  method: SignInMethodViewSchema.nullable(),
  login: z.string().nullable(),
  role: RoleViewSchema.nullable(),
  clientIdNeeded: z.boolean(),
  /** The code to type in the browser while signing in again. */
  deviceCode: z.object({ userCode: z.string(), verificationUri: z.string() }).nullable(),
});
export type AccessView = z.infer<typeof AccessViewSchema>;

/** What removing an instance would leave behind in its library folder (PLAN.md §3.8 S12). */
export const RemovalCheckViewSchema = z.object({
  unpushedCommits: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
});
export type RemovalCheckView = z.infer<typeof RemovalCheckViewSchema>;
