// The activity log (PLAN.md §3.13): the user-facing timeline of what happened in an instance, kept in its events
// table. Each entry has a kind from PLAN's list, the library path it concerns, and details for the message.
import type { JsonValue } from '@app/schemas';
import type { Clock } from '../../ports/clock.ts';
import type { StoredEvent, Store, WriteTx } from '../../ports/store.ts';

/** PLAN.md §3.13's kinds; later steps use the rest of the list. */
export type ActivityKind =
  | 'modified-locally'
  | 'installed'
  | 'skipped'
  | 'suppressed'
  | 'relinked'
  | 'taken-back'
  | 'detached'
  | 'renamed'
  | 'removed'
  | 'restored'
  | 'restored-from-trash'
  | 'brought-in'
  | 'discarded'
  | 'committed'
  | 'commit-undone'
  | 'pulled'
  | 'merged'
  | 'conflict-resolved'
  | 'merge-aborted'
  | 'pushed'
  | 'push-rejected'
  | 'branch-created'
  | 'branch-switched'
  | 'branch-deleted'
  | 'stashed'
  | 'stash-applied'
  | 'stash-dropped'
  | 'reverted'
  | 'signing-key-added'
  | 'request-opened'
  | 'request-updated'
  | 'request-approved'
  | 'request-declined'
  | 'request-merged'
  | 'request-withdrawn'
  | 'imported'
  | 'instructions-linked'
  | 'instructions-unlinked'
  | 'tool-enabled'
  | 'tool-disabled'
  | 'placement-changed'
  | 'tag-rule-changed'
  | 'repo-added'
  | 'repo-removed'
  | 'worktree-linked'
  | 'local-prefix-changed'
  | 'prefix-changed'
  | 'written-back'
  | 'copy-kept'
  | 'library-moved'
  | 'library-downloaded'
  | 'connections-recovered'
  | 'database-restored'
  | 'instance-added'
  | 'instance-removed';

export interface ActivityEntry {
  readonly kind: ActivityKind;
  /** The library path it concerns, e.g. `skills/acme-code-review`. */
  readonly path: string | null;
  readonly details: JsonValue;
  readonly author?: string | null;
  readonly commit?: string | null;
}

export class ActivityLog {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #device: () => string;

  constructor(deps: { store: Store; clock: Clock; device: () => string }) {
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#device = deps.device;
  }

  /** Adds entries inside a transaction that's already open. */
  appendIn(tx: WriteTx, entries: readonly ActivityEntry[]): void {
    const ts = this.#clock.now();
    for (const entry of entries) {
      tx.events.append({
        ts,
        device: this.#device(),
        author: entry.author ?? null,
        path: entry.path,
        kind: entry.kind,
        commit: entry.commit ?? null,
        details: entry.details,
      });
    }
  }

  append(entries: readonly ActivityEntry[]): void {
    if (entries.length === 0) return;
    this.#store.write((tx) => this.appendIn(tx, entries));
  }

  list(options: { limit?: number; kind?: string } = {}): StoredEvent[] {
    return this.#store.read((tx) => tx.events.list(options));
  }
}
