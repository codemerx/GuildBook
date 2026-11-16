// The Links port on Node (ADR 0017): `fs.symlink(target, link, 'junction')` makes a junction on Windows and a symlink
// elsewhere. A link is replaced by renaming a new link over it (on Windows: remove the old junction, then rename), and
// removed with unlink, or rmdir for a Windows junction. Proven in Step 0's spike 3; Step 5 builds the link engine on it.
import type { AbsPath, Links } from '@app/core';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';

/** readlink on Windows returns junction targets with the \\?\ prefix. */
export function normalizeTarget(target: string): string {
  return isWindows && target.startsWith('\\\\?\\') ? target.slice(4) : target;
}

export const nodeLinks: Links = {
  async create(target, link) {
    await fs.symlink(target, link, 'junction');
  },
  async readTarget(link) {
    try {
      const stats = await fs.lstat(link);
      if (!stats.isSymbolicLink()) return undefined;
      return normalizeTarget(await fs.readlink(link)) as AbsPath;
    } catch {
      return undefined;
    }
  },
  async retarget(link, newTarget) {
    const temp = path.join(path.dirname(link), `.${path.basename(link)}.new`);
    await fs.rm(temp, { force: true });
    await fs.symlink(newTarget, temp, 'junction');
    if (isWindows) await fs.rmdir(link);
    await fs.rename(temp, link);
  },
  async remove(link) {
    if (isWindows) await fs.rmdir(link);
    else await fs.unlink(link);
  },
};
