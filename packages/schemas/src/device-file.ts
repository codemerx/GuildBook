// device.json: the device-wide state that only main writes (PLAN.md §3.1, IMPLEMENTATION.md §2.7). Every version
// stays here, so migrations can be tested from each of them (TESTING.md §8).
import { z } from 'zod';
import { DeviceIdSchema, InstanceIdSchema, OperationIdSchema, TimestampSchema } from './ids.ts';
import { SetupHandoffSchema } from './setup.ts';

/**
 * Version 0: the shape PLAN.md §3.1 shows, without a schema version. It's the oldest format a migration starts from.
 */
export const DeviceFileV0Schema = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  instances: z.array(
    z.object({
      id: z.string(),
      gitUrl: z.string(),
      status: z.string(),
      gitPrefix: z.string().nullable(),
      localPrefix: z.string().nullable(),
      libraryPath: z.string(),
      instructionsLinked: z.boolean(),
    }),
  ),
  customTools: z.array(z.object({ id: z.string(), name: z.string(), skillDirs: z.array(z.string()) })).optional(),
  toolFolders: z.record(z.string(), z.string()).optional(),
});

export type DeviceFileV0 = z.infer<typeof DeviceFileV0Schema>;

/** The statuses that survive a restart. pending, restarting and error exist only while the app runs. */
export const PersistedInstanceStatusSchema = z.enum(['setting-up', 'ready', 'removing']);

export const InstanceRecordSchema = z.object({
  id: InstanceIdSchema,
  /** What the UI calls the instance: its library's name, e.g. "Acme" (PLAN.md §3.1). */
  name: z.string().min(1).max(100),
  /** null for a test library: a local folder, in test and development builds only (Step 1). */
  gitUrl: z.string().nullable(),
  status: PersistedInstanceStatusSchema,
  gitPrefix: z.string().nullable(),
  localPrefix: z.string().nullable(),
  libraryPath: z.string(),
  instructionsLinked: z.boolean(),
  addedAt: TimestampSchema,
});

/** Version 1's setup record: a download whose temporary folder is removed at the next start. */
export const SetupRecordV1Schema = z.object({
  id: z.string(),
  downloadPath: z.string(),
  startedAt: TimestampSchema,
});

/** A setup id: the pending worker's name until the download gives the library its id (IMPLEMENTATION.md §2.1). */
export const SetupIdSchema = z.string().regex(/^setup_[0-9a-z]{4,32}$/, 'not a setup id');

/**
 * A setup with a download in progress (IMPLEMENTATION.md §2.1, Step 4). The download goes into `downloadPath`, a
 * temporary folder next to `libraryPath`, and is renamed into place when it's complete. Until `instanceId` is set,
 * the next start removes the temporary folder; once it's set, the next start finishes the rename.
 */
export const SetupRecordSchema = z.object({
  id: SetupIdSchema,
  downloadPath: z.string(),
  libraryPath: z.string(),
  /** Set when the download is complete and the instance is recorded. */
  instanceId: InstanceIdSchema.nullable(),
  /** What the instance's worker gets on its first start (no secrets); set together with `instanceId`. */
  handoff: SetupHandoffSchema.nullable(),
  startedAt: TimestampSchema,
});

/** A device operation in progress, recorded before it starts so it resumes after a crash (IMPLEMENTATION.md §2.6). */
export const DeviceOperationRecordSchema = z.object({
  id: OperationIdSchema,
  kind: z.string(),
  instanceId: InstanceIdSchema.nullable(),
  nextStep: z.number().int().nonnegative(),
  params: z.record(z.string(), z.json()),
  startedAt: TimestampSchema,
});

export const ThemeSchema = z.enum(['system', 'light', 'dark']);

/**
 * The types of system notification (PLAN.md §3.19 "Notifications"): incoming changes, links changed by a branch switch
 * or another git tool, and new red warnings.
 */
export const NotificationTypeSchema = z.enum(['incoming', 'linksChanged', 'warning']);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

/** Each type can be switched off, and Do not disturb holds back every one of them (Step 17). */
export const NotificationSettingsSchema = z.object({
  off: z.array(NotificationTypeSchema),
  doNotDisturb: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

/**
 * The same in `device.json`: a type that is gone is dropped when the file is read. `requestDecision` and `requestNew`
 * went with the requests in the app (ADR 0032).
 */
const StoredNotificationSettingsSchema = z.object({
  off: z
    .array(z.string())
    .transform((types) =>
      types.filter((type): type is NotificationType => NotificationTypeSchema.safeParse(type).success),
    ),
  doNotDisturb: z.boolean(),
});

/** The macOS folders whose access the system asks the user about (Step 17, A17.9). */
export const ProtectedFolderSchema = z.enum(['Desktop', 'Documents', 'Downloads']);
export type ProtectedFolder = z.infer<typeof ProtectedFolderSchema>;

export const DeviceSettingsSchema = z.object({
  theme: ThemeSchema,
  /** PEM certificates the app trusts besides the OS trust store (PLAN.md §3.19, ADR 0015). */
  extraCertificates: z.array(z.string()),
  /** Start at login, in the tray without a window (PLAN.md §3.19): on by default. Added in Step 15. */
  launchAtLogin: z.boolean().default(true),
  /** Added in Step 17: left out, as in files from before, every type is on. */
  notifications: StoredNotificationSettingsSchema.default({ off: [], doNotDisturb: false }),
  /** The protected folders whose notice the user has seen (Step 17): macOS asks about each one only once. */
  folderAccessNoticed: z.array(ProtectedFolderSchema).default([]),
});

/** Versions 1 and 2: a custom tool's name and the folders it reads skills from. */
export const CustomToolV1Schema = z.object({ id: z.string(), name: z.string(), skillDirs: z.array(z.string()) });

/** A custom tool's instructions (PLAN.md §3.4 "Custom tools"): a file that gets a marked block, or a folder. */
export const CustomToolInstructionsSchema = z.object({
  method: z.enum(['marked-block', 'owned-file']),
  path: z.string().min(1).max(4096),
});

/**
 * Version 3 (Step 7): a custom tool may also name an instructions file and its method. `copy` (Step 16) makes it a
 * copy target: its folder gets copies of the skills instead of links (copy mode, PLAN.md §3.4), for WSL, a folder
 * mounted into a container or VM, or a sandboxed app. Left out, as in files written before Step 16, it's false.
 */
export const CustomToolSchema = CustomToolV1Schema.extend({
  instructions: CustomToolInstructionsSchema.nullable(),
  copy: z.boolean().default(false),
});

export const DEVICE_FILE_VERSION = 3;

export const DeviceFileV1Schema = z.object({
  schemaVersion: z.literal(1),
  deviceId: DeviceIdSchema,
  deviceName: z.string(),
  instances: z.array(InstanceRecordSchema),
  setups: z.array(SetupRecordV1Schema),
  operations: z.array(DeviceOperationRecordSchema),
  customTools: z.array(CustomToolV1Schema),
  toolFolders: z.record(z.string(), z.string()),
  settings: DeviceSettingsSchema,
});

export type DeviceFileV1 = z.infer<typeof DeviceFileV1Schema>;

/** Version 2 (Step 4): a setup records where its library goes, and the instance once its download is complete. */
export const DeviceFileV2Schema = DeviceFileV1Schema.extend({
  schemaVersion: z.literal(2),
  setups: z.array(SetupRecordSchema),
});

export type DeviceFileV2 = z.infer<typeof DeviceFileV2Schema>;

/** Version 3 (Step 7): custom tools with instructions. */
export const DeviceFileV3Schema = DeviceFileV2Schema.extend({
  schemaVersion: z.literal(3),
  customTools: z.array(CustomToolSchema),
});

export type DeviceFileV3 = z.infer<typeof DeviceFileV3Schema>;
export type DeviceFile = DeviceFileV3;
/** The current version's schema. */
export const DeviceFileSchema = DeviceFileV3Schema;
export type CustomToolRecord = z.infer<typeof CustomToolSchema>;
export type InstanceRecord = z.infer<typeof InstanceRecordSchema>;
export type PersistedInstanceStatus = z.infer<typeof PersistedInstanceStatusSchema>;
export type DeviceOperationRecord = z.infer<typeof DeviceOperationRecordSchema>;
export type SetupRecord = z.infer<typeof SetupRecordSchema>;
export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>;
export type Theme = z.infer<typeof ThemeSchema>;

export const defaultDeviceSettings: DeviceSettings = {
  theme: 'system',
  extraCertificates: [],
  launchAtLogin: true,
  notifications: { off: [], doNotDisturb: false },
  folderAccessNoticed: [],
};
