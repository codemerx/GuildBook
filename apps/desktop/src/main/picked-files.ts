// Files the user picks in the OS dialog (PLAN.md §3.7 "the files the user picks"): main reads them for the editor's
// [Load from file…] and [Replace…]. A link isn't followed, and a file over the limit isn't read: only its size goes back.
import type { AbsPath, FileSystem } from '@app/core';

export function pickedFileReader(fs: FileSystem) {
  return async (path: string, max: number): Promise<{ size: number; bytes: Uint8Array | null }> => {
    const entry = await fs.lstat(path as AbsPath);
    if (entry?.kind !== 'file') return { size: 0, bytes: null };
    return { size: entry.size, bytes: entry.size > max ? null : await fs.readBytes(path as AbsPath) };
  };
}
