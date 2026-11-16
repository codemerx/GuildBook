// The FileSystem port on Node's fs. Core never gets this directly: it gets the guarded file system wrapped around it
// (IMPLEMENTATION.md §2.10, ADR 0017).
import { type AbsPath, AppError, type Entry, type FileSystem, type WriteOptions } from '@app/core';
import { randomBytes } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/** rmdir on a folder with something in it: ENOTEMPTY, or EEXIST, which POSIX also allows. */
function isNotEmpty(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOTEMPTY' || error.code === 'EEXIST')
  );
}

/** Runs an operation and turns "not there" into the port's typed error. */
async function mapMissing<T>(target: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isMissing(error)) throw new AppError('fs.notFound', { path: target });
    throw error;
  }
}

function kindOf(stats: Stats): Entry['kind'] {
  if (stats.isSymbolicLink()) return 'link';
  if (stats.isDirectory()) return 'dir';
  if (stats.isFile()) return 'file';
  return 'other';
}

export class NodeFileSystem implements FileSystem {
  async lstat(target: AbsPath): Promise<Entry | undefined> {
    try {
      const stats = await fs.lstat(target);
      return { kind: kindOf(stats), size: stats.size, mtimeMs: stats.mtimeMs, mode: stats.mode & 0o7777 };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async list(dir: AbsPath): Promise<string[]> {
    return mapMissing(dir, async () => (await fs.readdir(dir)).sort());
  }

  async readText(target: AbsPath): Promise<string> {
    return mapMissing(target, () => fs.readFile(target, 'utf8'));
  }

  async readBytes(target: AbsPath): Promise<Uint8Array> {
    return mapMissing(target, async () => new Uint8Array(await fs.readFile(target)));
  }

  async readLink(target: AbsPath): Promise<string> {
    return mapMissing(target, async () => normalizeLinkTarget(await fs.readlink(target)));
  }

  async writeTextAtomic(target: AbsPath, text: string): Promise<void> {
    await this.writeBytesAtomic(target, new TextEncoder().encode(text));
  }

  /** Temp file in the same folder, flushed, then renamed over the target: readers see the old or the new file. */
  async writeBytesAtomic(target: AbsPath, bytes: Uint8Array, options: WriteOptions = {}): Promise<void> {
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
    await mapMissing(target, async () => {
      const existing = await fs.stat(target).catch(() => undefined);
      const mode =
        options.mode === undefined ? (existing?.isFile() ? existing.mode & 0o777 : 0o644) : options.mode & 0o777;
      const handle = await fs.open(temp, 'wx', mode);
      try {
        // The mode asked for, whatever the umask took from it.
        if (options.mode !== undefined && !isWindows) await handle.chmod(mode);
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.rename(temp, target);
      } catch (error) {
        await fs.rm(temp, { force: true });
        throw error;
      }
    });
  }

  async mkdirp(dir: AbsPath): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  async rename(from: AbsPath, to: AbsPath): Promise<void> {
    await mapMissing(from, () => fs.rename(from, to));
  }

  async remove(target: AbsPath): Promise<void> {
    const entry = await this.lstat(target);
    if (!entry) throw new AppError('fs.notFound', { path: target });
    if (entry.kind === 'dir') await fs.rmdir(target);
    else if (entry.kind === 'link' && isWindows && (await isDirectoryLink(target))) await fs.rmdir(target);
    else await fs.unlink(target);
  }

  /** A real, empty folder goes: rmdir refuses one with anything in it, so nothing in it is read. */
  async removeEmptyFolder(dir: AbsPath): Promise<boolean> {
    // A link to a folder stays: on Windows, rmdir would remove a junction itself.
    if ((await this.lstat(dir))?.kind !== 'dir') return false;
    try {
      await fs.rmdir(dir);
      return true;
    } catch (error) {
      if (isMissing(error) || isNotEmpty(error)) return false;
      throw error;
    }
  }

  /** Removes a folder and what's in it; a link inside is removed as a link, and what it points to is left alone. */
  async removeTree(dir: AbsPath): Promise<void> {
    const entry = await this.lstat(dir);
    if (!entry) return;
    if (entry.kind !== 'dir') {
      await this.remove(dir);
      return;
    }
    for (const name of await fs.readdir(dir)) {
      await this.removeTree(path.join(dir, name) as AbsPath);
    }
    await fs.rmdir(dir);
  }

  async copyFile(from: AbsPath, to: AbsPath): Promise<void> {
    await mapMissing(from, () => fs.copyFile(from, to, constants.COPYFILE_FICLONE));
  }
}

/** readlink on Windows returns junction targets with the \\?\ prefix. */
function normalizeLinkTarget(target: string): string {
  return isWindows && target.startsWith('\\\\?\\') ? target.slice(4) : target;
}

/** A Windows junction or directory symlink is removed with rmdir, a file symlink with unlink. */
async function isDirectoryLink(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    // A dangling junction: rmdir removes it.
    return true;
  }
}
