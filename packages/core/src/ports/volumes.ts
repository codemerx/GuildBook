// The disk a folder is on (PLAN.md §3.17 step 3, §3.9): whether it's a local disk or a network drive, how much space is
// free, and whether the app may write there. A folder that doesn't exist yet is measured at its nearest existing parent.
// Test mode can simulate a network drive or a full disk for a path (TESTING.md §3, §2.16).
import type { AbsPath } from '../shared/brand.ts';

export interface VolumeInfo {
  readonly kind: 'local' | 'network' | 'unknown';
  /** Bytes free for this user; null when the OS doesn't say. */
  readonly freeBytes: number | null;
  /** Whether this user may create files in the folder (or its nearest existing parent). */
  readonly writable: boolean;
  /**
   * Which disk it is, as the OS numbers it: two folders on the same disk can be moved with one rename (PLAN.md §3.9
   * step 3). Null when the OS doesn't say.
   */
  readonly device: string | null;
}

export interface Volumes {
  info(path: AbsPath): Promise<VolumeInfo>;
}
