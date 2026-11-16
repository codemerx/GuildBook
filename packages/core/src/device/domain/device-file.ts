// Reading device.json in any version (IMPLEMENTATION.md §2.7): older versions are migrated one version at a time;
// data written by a newer app version is never touched, and the app asks to be updated (A1.17).
import {
  DEVICE_FILE_VERSION,
  type DeviceFile,
  DeviceFileSchema,
  type DeviceFileV0,
  DeviceFileV0Schema,
  type DeviceFileV1,
  DeviceFileV1Schema,
  type DeviceFileV2,
  DeviceFileV2Schema,
  defaultDeviceSettings,
} from '@app/schemas';

export type DeviceFileRead =
  | { readonly kind: 'current'; readonly file: DeviceFile }
  | { readonly kind: 'migrated'; readonly file: DeviceFile; readonly from: number }
  | { readonly kind: 'newer'; readonly version: number }
  | { readonly kind: 'invalid'; readonly reason: string };

/** The schema version a parsed device.json says it has: version 0 had no field. */
export function deviceFileVersion(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  if (!('schemaVersion' in raw)) return 0;
  const version = raw.schemaVersion;
  return typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : undefined;
}

export function readDeviceFile(raw: unknown, now: string): DeviceFileRead {
  const version = deviceFileVersion(raw);
  if (version === undefined) return { kind: 'invalid', reason: 'not a device file' };
  if (version > DEVICE_FILE_VERSION) return { kind: 'newer', version };
  if (version === DEVICE_FILE_VERSION) {
    const parsed = DeviceFileSchema.safeParse(raw);
    return parsed.success ? { kind: 'current', file: parsed.data } : { kind: 'invalid', reason: parsed.error.message };
  }
  let v2: DeviceFileV2;
  if (version === 2) {
    const parsed = DeviceFileV2Schema.safeParse(raw);
    if (!parsed.success) return { kind: 'invalid', reason: parsed.error.message };
    v2 = parsed.data;
  } else {
    const v1 = readV1(raw, version, now);
    if (!v1.ok) return { kind: 'invalid', reason: v1.reason };
    v2 = migrateV1ToV2(v1.file);
  }
  const migrated = DeviceFileSchema.safeParse(migrateV2ToV3(v2));
  return migrated.success
    ? { kind: 'migrated', file: migrated.data, from: version }
    : { kind: 'invalid', reason: migrated.error.message };
}

function readV1(
  raw: unknown,
  version: number,
  now: string,
): { ok: true; file: DeviceFileV1 } | { ok: false; reason: string } {
  let v1: DeviceFileV1;
  if (version === 0) {
    const v0 = DeviceFileV0Schema.safeParse(raw);
    if (!v0.success) return { ok: false, reason: v0.error.message };
    v1 = migrateV0ToV1(v0.data, now);
  } else {
    const parsed = DeviceFileV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: parsed.error.message };
    v1 = parsed.data;
  }
  return { ok: true, file: v1 };
}

/** Version 0 → 1: adds the schema version, instance names, setups, operations and settings. */
export function migrateV0ToV1(v0: DeviceFileV0, now: string): DeviceFileV1 {
  return {
    schemaVersion: 1,
    deviceId: v0.deviceId,
    deviceName: v0.deviceName,
    instances: v0.instances.map((instance) => ({
      id: instance.id,
      name: lastSegment(instance.libraryPath) || instance.id,
      gitUrl: instance.gitUrl,
      status: instance.status === 'setting-up' || instance.status === 'removing' ? instance.status : 'ready',
      gitPrefix: instance.gitPrefix,
      localPrefix: instance.localPrefix,
      libraryPath: instance.libraryPath,
      instructionsLinked: instance.instructionsLinked,
      addedAt: now,
    })),
    setups: [],
    operations: [],
    customTools: v0.customTools ?? [],
    toolFolders: v0.toolFolders ?? {},
    settings: structuredClone(defaultDeviceSettings),
  };
}

/**
 * Version 1 → 2: a setup records its library folder and, once its download is complete, its instance. Version 1 never
 * recorded a setup (sign-in and the download came with version 2), so its setups are dropped; a temporary folder one
 * named would be left over from a test build.
 */
export function migrateV1ToV2(v1: DeviceFileV1): DeviceFileV2 {
  return { ...v1, schemaVersion: 2, setups: [] };
}

/** Version 2 → 3: custom tools name no instructions yet. */
export function migrateV2ToV3(v2: DeviceFileV2): DeviceFile {
  return {
    ...v2,
    schemaVersion: 3,
    customTools: v2.customTools.map((tool) => ({ ...tool, instructions: null, copy: false })),
  };
}

export function newDeviceFile(deviceId: string, deviceName: string): DeviceFile {
  return {
    schemaVersion: 3,
    deviceId,
    deviceName,
    instances: [],
    setups: [],
    operations: [],
    customTools: [],
    toolFolders: {},
    settings: structuredClone(defaultDeviceSettings),
  };
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}
