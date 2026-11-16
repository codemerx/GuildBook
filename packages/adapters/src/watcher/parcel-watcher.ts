// The Watcher port on @parcel/watcher (ADR 0003, ADR 0005): native, recursive watching on every OS (FSEvents, inotify,
// ReadDirectoryChangesW), with events in batches. Links are reported as entries and never followed. Proven in a
// packaged utility process by Step 0's spike 1.
//
// On Linux, @parcel/watcher 2.6.0 misses folders created in a burst (`mkdir -p`, a git checkout of a new skill) in
// about 4 runs out of 10: inotify never watches them, and nothing inside them is reported afterwards. A new
// subscription, made after the old one is gone, watches them (Step 2 report, finding 9). So on Linux, a batch that
// created folders makes the adapter subscribe again, and then report those folders and their parents as changed:
// anything inside them may have changed while they weren't watched, and a sibling folder may have appeared in the
// moment between the two subscriptions (as when git checks out several new skills).
import type { AbsPath, Watcher, WatchEvent, WatchOptions, WatchSubscription } from '@app/core';
import parcel, { type AsyncSubscription, type Event } from '@parcel/watcher';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ParcelWatcherOptions {
  /** Whether to subscribe again after folders are created; by default on Linux only. */
  readonly resubscribeOnNewFolders?: boolean;
}

export class ParcelWatcher implements Watcher {
  readonly #resubscribe: boolean;

  constructor(options: ParcelWatcherOptions = {}) {
    this.#resubscribe = options.resubscribeOnNewFolders ?? process.platform === 'linux';
  }

  async watch(
    dir: AbsPath,
    onEvents: (events: readonly WatchEvent[]) => void,
    options: WatchOptions & { readonly onError?: (error: Error) => void } = {},
  ): Promise<WatchSubscription> {
    const parcelOptions = options.ignore ? { ignore: [...options.ignore] } : {};
    const created = new Set<string>();
    let closed = false;
    let renewing: Promise<void> | undefined;

    const listener = (error: Error | null, events: Event[]) => {
      if (error) {
        options.onError?.(error);
        return;
      }
      if (closed || events.length === 0) return;
      onEvents(events.map((event) => ({ type: event.type, path: event.path as AbsPath })));
      if (!this.#resubscribe) return;
      for (const event of events) if (event.type === 'create') created.add(event.path);
      renew();
    };

    const renew = () => {
      if (renewing || created.size === 0) return;
      renewing = (async () => {
        const paths = [...created];
        created.clear();
        const folders = (
          await Promise.all(
            paths.map(async (created) =>
              (await fs.lstat(created).catch(() => undefined))?.isDirectory() ? created : undefined,
            ),
          )
        ).filter((folder): folder is string => folder !== undefined);
        if (folders.length === 0 || closed) return;
        await current.unsubscribe();
        if (closed) return;
        current = await parcel.subscribe(dir, listener, parcelOptions);
        const parents = folders.map((folder) => path.dirname(folder)).filter((parent) => parent.startsWith(dir));
        const changed = [...new Set([...folders, ...parents])].sort();
        onEvents(changed.map((folder) => ({ type: 'update', path: folder as AbsPath })));
      })()
        .catch((error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error))))
        .finally(() => {
          renewing = undefined;
          if (!closed) renew();
        });
    };

    let current: AsyncSubscription = await parcel.subscribe(dir, listener, parcelOptions);
    return {
      unsubscribe: async () => {
        closed = true;
        await renewing;
        await current.unsubscribe();
      },
    };
  }
}
