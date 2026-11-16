// Coalescing watcher events (IMPLEMENTATION.md §2.4 "file-watcher events, coalesced"), as a pure function: several
// events for one path become the one that describes the net change.
export type WatchChange = 'create' | 'update' | 'delete';

/**
 * The net change after `next` follows `previous` for the same path; undefined when they cancel out (a file created
 * and deleted again).
 */
export function mergeChange(previous: WatchChange | undefined, next: WatchChange): WatchChange | undefined {
  if (previous === undefined) return next;
  if (previous === 'create') return next === 'delete' ? undefined : 'create';
  if (previous === 'delete') return next === 'delete' ? 'delete' : 'update';
  return next === 'delete' ? 'delete' : 'update';
}

/** Files test mode writes into a watched folder to see its events drained (TESTING.md §6 waitForIdle). */
export const WATCH_MARKER_PREFIX = '.idle-marker-';

/** A marker, or the temporary file an atomic write of one goes through. */
export function isWatchMarker(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  return name.includes(WATCH_MARKER_PREFIX);
}
