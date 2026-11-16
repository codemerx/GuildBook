// Zip archives for imports (PLAN.md §3.18 C): `.zip` and `.skill` files. Core reads the archive's bytes through the
// guarded file system and checks every entry (imports/domain/archive.ts) before it unpacks anything; the adapter only
// reads the zip format.

export interface ArchiveEntry {
  /** Its position in the archive's listing: what `read` takes. */
  readonly index: number;
  /** The entry's name as stored, unchecked. */
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'link';
  /** The unpacked size the archive declares. */
  readonly size: number;
  readonly encrypted: boolean;
  /** Stored or deflated: what the app can unpack. */
  readonly supported: boolean;
}

export interface Archive {
  /** The entries of a zip archive; fails with `archive.unreadable` when the bytes aren't one. */
  entries(archive: Uint8Array): Promise<ArchiveEntry[]>;
  /**
   * One file's unpacked bytes. Fails with `archive.sizeMismatch` when the entry unpacks to more or less than it
   * declared, and never produces more than that (a zip bomb stops there).
   */
  read(archive: Uint8Array, entry: ArchiveEntry): Promise<Uint8Array>;
}
