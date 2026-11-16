// The app's update feed (PLAN.md §3.19 "App updates", ADR 0031): the `latest*.yml` file that electron-builder writes
// for each system, and that the release workflow publishes. The app reads only two of its top-level fields: the newest
// version, and the rollout share (`stagingPercentage`, ADR 0027). It downloads nothing else: the user downloads the new
// version from its release page.
import { createHash } from 'node:crypto';

export interface UpdateFeed {
  readonly version: string;
  /** The share of devices that are told about the version, 0–100; 100 when the feed doesn't say. */
  readonly rolloutPercent: number;
}

/** The feed file of this system, as electron-builder names it. */
export function feedFileName(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'win32') return 'latest.yml';
  return arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`;
}

/** Reads the feed; null when it has no version. The fields are plain top-level scalars, so no YAML parser is needed. */
export function parseFeed(text: string): UpdateFeed | null {
  const field = (name: string) => {
    const match = new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(text);
    return match?.[1]?.replace(/^(['"])(.*)\1$/, '$2') ?? null;
  };
  const version = field('version');
  if (!version || !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) return null;
  const staging = field('stagingPercentage');
  const percent = staging === null ? 100 : Number(staging);
  return { version, rolloutPercent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 100 };
}

/**
 * Whether this device is in the rollout of a version: the device id and the version pick a fixed place from 0 to 100,
 * so a device stays in as the share grows, and each version picks other devices first.
 */
export function inRollout(deviceId: string, version: string, percent: number): boolean {
  if (percent >= 100) return true;
  const hash = createHash('sha256').update(`${deviceId}\n${version}`).digest();
  const place = (new DataView(hash.buffer, hash.byteOffset, 4).getUint32(0) / 0x1_0000_0000) * 100;
  return place < percent;
}
