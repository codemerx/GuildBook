// File watching (@parcel/watcher, ADR 0003): the library folder, and later the projected copies and worktree lists
// (PLAN.md §2). Several folders per instance; the engine's WatchSet coalesces their events into commands.
import type { AbsPath } from '../shared/brand.ts';

export interface WatchEvent {
  readonly type: 'create' | 'update' | 'delete';
  readonly path: AbsPath;
}

export interface WatchSubscription {
  unsubscribe(): Promise<void>;
}

export interface WatchOptions {
  /** Paths inside the folder to leave out, as globs relative to it, e.g. `.git/objects/**`. */
  readonly ignore?: readonly string[];
}

export interface Watcher {
  /**
   * Reports changes anywhere below `dir`, in batches, until unsubscribed. Links inside it are reported, not followed.
   * `onError` hears of a watch that stopped working (e.g. the folder was removed).
   */
  watch(
    dir: AbsPath,
    onEvents: (events: readonly WatchEvent[]) => void,
    options?: WatchOptions & { readonly onError?: (error: Error) => void },
  ): Promise<WatchSubscription>;
}
