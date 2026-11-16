// What core may do with files. Core only ever gets the guarded file system, a decorator over the Node adapter that
// enforces the safety and privacy rules (IMPLEMENTATION.md §2.10, ADR 0017).
import type { AbsPath } from '../shared/brand.ts';

export type EntryKind = 'file' | 'dir' | 'link' | 'other';

export interface Entry {
  readonly kind: EntryKind;
  readonly size: number;
  readonly mtimeMs: number;
  /** POSIX permission bits; on Windows only what Node reports. */
  readonly mode: number;
}

export interface WriteOptions {
  /**
   * The permission bits of the written file (the lowest nine), e.g. 0o755 for a script. Without it, a file that is there
   * keeps the bits it has, and a new file gets 0o644. Windows has no such bits and ignores it.
   */
  readonly mode?: number;
}

export interface FileSystem {
  /** Information about the path itself (a link is reported as a link), or undefined when nothing is there. */
  lstat(path: AbsPath): Promise<Entry | undefined>;
  /** The names in a folder, sorted. */
  list(dir: AbsPath): Promise<string[]>;
  readText(path: AbsPath): Promise<string>;
  readBytes(path: AbsPath): Promise<Uint8Array>;
  /** A link's target as stored, without following it (e.g. a symbolic link inside a skill, PLAN.md §3.15). */
  readLink(path: AbsPath): Promise<string>;
  /** Writes through a temporary file that's renamed into place, so readers see the old or the new file, never half. */
  writeTextAtomic(path: AbsPath, text: string): Promise<void>;
  writeBytesAtomic(path: AbsPath, bytes: Uint8Array, options?: WriteOptions): Promise<void>;
  /** Creates a folder and its missing parents. */
  mkdirp(dir: AbsPath): Promise<void>;
  rename(from: AbsPath, to: AbsPath): Promise<void>;
  /** Removes one file, link or empty folder. Never follows a link. */
  remove(path: AbsPath): Promise<void>;
  /**
   * Removes a real folder only while it's empty, and says whether it did. Anything else at the path (a folder with
   * something in it, a link, a file, nothing) stays as it is, and the answer is false. Nothing in the folder is read.
   */
  removeEmptyFolder(dir: AbsPath): Promise<boolean>;
  /** Removes a folder with its contents, without following links inside it. Only under the data folder. */
  removeTree(dir: AbsPath): Promise<void>;
  /** Copies one file. */
  copyFile(from: AbsPath, to: AbsPath): Promise<void>;
}
