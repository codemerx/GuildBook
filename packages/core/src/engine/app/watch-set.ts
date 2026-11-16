// The folders an instance watches (IMPLEMENTATION.md §2.4): the library now; projected copies and worktree lists later
// (PLAN.md §2). Events from all of them are coalesced per path and delivered as one batch once the folders have been
// quiet for a moment, or at the latest after a maximum delay, so a long stream of changes still makes progress. The
// batch becomes a command in the instance's queue.
import type { Clock, Timer } from '../../ports/clock.ts';
import type { Watcher, WatchEvent, WatchOptions, WatchSubscription } from '../../ports/watcher.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { isWatchMarker, mergeChange, type WatchChange } from '../domain/watch-events.ts';

export interface WatchSetOptions {
  readonly watcher: Watcher;
  readonly clock: Clock;
  /** Gets each coalesced batch, sorted by path. */
  readonly onBatch: (events: readonly WatchEvent[]) => void;
  readonly onError?: (dir: AbsPath, error: Error) => void;
  /** How long the folders must be quiet before a batch goes out. */
  readonly quietMs?: number;
  /** The longest a change waits while events keep coming. */
  readonly maxDelayMs?: number;
}

export class WatchSet {
  readonly #options: WatchSetOptions;
  readonly #subscriptions = new Map<AbsPath, WatchSubscription>();
  readonly #pending = new Map<AbsPath, WatchChange>();
  readonly #markerWaiters = new Map<string, () => void>();
  #quiet: Timer | undefined;
  #deadline: Timer | undefined;
  #closed = false;

  constructor(options: WatchSetOptions) {
    this.#options = options;
  }

  get dirs(): AbsPath[] {
    return [...this.#subscriptions.keys()];
  }

  /** How many paths wait for the next batch. */
  get pending(): number {
    return this.#pending.size;
  }

  async add(dir: AbsPath, options: WatchOptions = {}): Promise<void> {
    if (this.#closed || this.#subscriptions.has(dir)) return;
    const subscription = await this.#options.watcher.watch(dir, (events) => this.#receive(events), {
      ...options,
      onError: (error) => this.#options.onError?.(dir, error),
    });
    this.#subscriptions.set(dir, subscription);
  }

  async remove(dir: AbsPath): Promise<void> {
    const subscription = this.#subscriptions.get(dir);
    this.#subscriptions.delete(dir);
    await subscription?.unsubscribe();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelTimers();
    this.#pending.clear();
    for (const dir of this.dirs) await this.remove(dir);
  }

  /** Delivers what's pending now, without waiting for quiet. */
  flush(): void {
    this.#cancelTimers();
    if (this.#pending.size === 0 || this.#closed) return;
    const events = [...this.#pending.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, type]) => ({ type, path }));
    this.#pending.clear();
    this.#options.onBatch(events);
  }

  /**
   * Resolves when an event for this marker file arrives. Test mode writes one into each watched folder to know that
   * every earlier event has arrived (TESTING.md §6). Marker events never reach a batch.
   */
  waitForMarker(path: AbsPath): Promise<void> {
    return new Promise((resolve) => this.#markerWaiters.set(path, resolve));
  }

  #receive(events: readonly WatchEvent[]): void {
    if (this.#closed) return;
    for (const event of events) {
      if (isWatchMarker(event.path)) {
        this.#markerWaiters.get(event.path)?.();
        this.#markerWaiters.delete(event.path);
        continue;
      }
      const merged = mergeChange(this.#pending.get(event.path), event.type);
      if (merged === undefined) this.#pending.delete(event.path);
      else this.#pending.set(event.path, merged);
    }
    if (this.#pending.size === 0) return;
    const { clock, quietMs = 150, maxDelayMs = 2000 } = this.#options;
    this.#quiet?.cancel();
    this.#quiet = clock.setTimer(quietMs, () => this.flush());
    this.#deadline ??= clock.setTimer(maxDelayMs, () => this.flush());
  }

  #cancelTimers(): void {
    this.#quiet?.cancel();
    this.#deadline?.cancel();
    this.#quiet = undefined;
    this.#deadline = undefined;
  }
}
