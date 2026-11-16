// The Volumes port on Node (PLAN.md §3.17 step 3): free space from statfs, write access from access(W_OK), and the
// disk's kind from the OS's mount table: /proc/self/mountinfo on Linux, `mount` on macOS, the drive type on Windows.
// Test mode reads simulated volumes from `<test root>/test-volumes.json`, so a test can stand on a "network drive", a
// "full disk" or "another disk" without one (TESTING.md §3). The disk's number is stat's `dev`.
import type { AbsPath, Platform, VolumeInfo, Volumes } from '@app/core';
import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

/** File system types that live on another computer. */
const NETWORK_TYPES = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smb3',
  'smbfs',
  'afpfs',
  'webdav',
  'davfs',
  'fuse.sshfs',
  'sshfs',
  'fuse.rclone',
  'afs',
  'ncpfs',
  'ftp',
  '9p',
]);

export const TEST_VOLUMES_FILE = 'test-volumes.json';

export interface SimulatedVolume {
  /** The volume's mount point: it applies to this path and everything below it. */
  readonly path: string;
  readonly kind?: VolumeInfo['kind'];
  readonly freeBytes?: number | null;
  /** Another disk: a relocation there copies, as across disks (A9.2). */
  readonly device?: string;
}

export interface NodeVolumesOptions {
  readonly platform: Platform;
  readonly testRoot?: string | undefined;
}

export class NodeVolumes implements Volumes {
  readonly #platform: Platform;
  readonly #testRoot: string | undefined;

  constructor(options: NodeVolumesOptions) {
    this.#platform = options.platform;
    this.#testRoot = options.testRoot;
  }

  async info(target: AbsPath): Promise<VolumeInfo> {
    const existing = await nearestExisting(target);
    const [freeBytes, writable, kind, device] = await Promise.all([
      free(existing),
      fs.access(existing, constants.W_OK).then(
        () => true,
        () => false,
      ),
      this.#kind(existing),
      fs.stat(existing).then(
        (stat) => String(stat.dev),
        () => null,
      ),
    ]);
    const real: VolumeInfo = { kind, freeBytes, writable, device };
    const simulated = await this.#simulated(target);
    if (!simulated) return real;
    return {
      kind: simulated.kind ?? real.kind,
      freeBytes: simulated.freeBytes === undefined ? real.freeBytes : simulated.freeBytes,
      writable,
      device: simulated.device ?? real.device,
    };
  }

  async #kind(dir: string): Promise<VolumeInfo['kind']> {
    try {
      const real = await fs.realpath(dir);
      if (this.#platform === 'linux') return linuxKind(await fs.readFile('/proc/self/mountinfo', 'utf8'), real);
      if (this.#platform === 'darwin') return macKind(await run('/sbin/mount', []), real);
      return await windowsKind(real);
    } catch {
      return 'unknown';
    }
  }

  async #simulated(target: string): Promise<SimulatedVolume | undefined> {
    if (this.#testRoot === undefined) return undefined;
    let list: SimulatedVolume[];
    try {
      list = JSON.parse(await fs.readFile(path.join(this.#testRoot, TEST_VOLUMES_FILE), 'utf8')) as SimulatedVolume[];
    } catch {
      return undefined;
    }
    const inside = (root: string) => {
      const relative = path.relative(root, target);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    return list.filter((v) => inside(v.path)).sort((a, b) => b.path.length - a.path.length)[0];
  }
}

async function nearestExisting(target: string): Promise<string> {
  let current = path.resolve(target);
  for (;;) {
    try {
      const stat = await fs.stat(current);
      if (stat.isDirectory()) return current;
    } catch {
      // Not there yet: try the parent.
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

async function free(dir: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** The longest mount point that holds `real`, and its type, from /proc/self/mountinfo. */
export function linuxKind(mountinfo: string, real: string): VolumeInfo['kind'] {
  let best: { point: string; type: string } | undefined;
  for (const line of mountinfo.split('\n')) {
    // id parent major:minor root mount-point options [optional…] - type source super-options
    const fields = line.split(' ');
    const dash = fields.indexOf('-');
    const point = unescapeMount(fields[4] ?? '');
    const type = fields[dash + 1];
    if (dash < 0 || !type || !point) continue;
    if (!within(point, real)) continue;
    if (!best || point.length >= best.point.length) best = { point, type };
  }
  if (!best) return 'unknown';
  return NETWORK_TYPES.has(best.type) ? 'network' : 'local';
}

/** The same from macOS's `mount` output: `<device> on <mount point> (<type>, <flags>…)`; network mounts lack "local". */
export function macKind(mountOutput: string, real: string): VolumeInfo['kind'] {
  let best: { point: string; type: string; local: boolean } | undefined;
  for (const line of mountOutput.split('\n')) {
    const match = / on (.+) \(([^,)]+)((?:, [^)]*)?)\)$/.exec(line);
    if (!match) continue;
    const point = match[1] ?? '';
    if (!within(point, real)) continue;
    const flags = (match[3] ?? '').split(',').map((flag) => flag.trim());
    if (!best || point.length >= best.point.length)
      best = { point, type: match[2] ?? '', local: flags.includes('local') };
  }
  if (!best) return 'unknown';
  return NETWORK_TYPES.has(best.type) || !best.local ? 'network' : 'local';
}

async function windowsKind(real: string): Promise<VolumeInfo['kind']> {
  if (/^\\\\/.test(real)) return 'network';
  const drive = /^([A-Za-z]):/.exec(real)?.[1];
  if (!drive) return 'unknown';
  const type = (
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `([IO.DriveInfo]'${drive}').DriveType`])
  ).trim();
  return type === 'Network' ? 'network' : type === '' ? 'unknown' : 'local';
}

function within(point: string, real: string): boolean {
  if (point === '/') return true;
  return real === point || real.startsWith(`${point}/`);
}

/** mountinfo escapes spaces, tabs, newlines and backslashes as octal. */
function unescapeMount(text: string): string {
  return text.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 10_000, windowsHide: true }, (error, stdout) =>
      error ? reject(new Error(error.message)) : resolve(stdout),
    );
  });
}
