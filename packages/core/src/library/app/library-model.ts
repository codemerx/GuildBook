// One instance's library model (IMPLEMENTATION.md Step 2): the current snapshot, loaded with a full scan and refreshed
// incrementally from watcher events. The worker runs both as commands in the instance's queue (§2.4), so a refresh never
// races another change.
import { hashValue } from '../../shared/hash.ts';
import { buildSnapshot, type LibraryFacts, type LibrarySnapshot, type SnapshotContext } from '../domain/snapshot.ts';
import { refreshLibrary, type ScanOptions, scanLibrary } from './scanner.ts';
import type { LibrarySource } from './source.ts';

export interface LibraryModelDeps {
  readonly source: LibrarySource;
  /** Read at every build, so a changed catalog or local prefix applies at the next refresh. */
  readonly context: () => SnapshotContext;
  readonly scan?: ScanOptions;
}

export class LibraryModel {
  readonly #deps: LibraryModelDeps;
  #facts: LibraryFacts | undefined;
  #snapshot: LibrarySnapshot | undefined;
  #hash: string | undefined;

  constructor(deps: LibraryModelDeps) {
    this.#deps = deps;
  }

  /** The latest snapshot; undefined until the first scan finished. */
  get snapshot(): LibrarySnapshot | undefined {
    return this.#snapshot;
  }

  /** A full scan. Returns whether the snapshot changed. */
  async load(signal?: AbortSignal): Promise<boolean> {
    const facts = await scanLibrary(this.#deps.source, { ...this.#deps.scan, ...(signal ? { signal } : {}) });
    return this.#publish(facts);
  }

  /** Rescans what the changed library paths touch; a full scan if nothing was loaded yet. */
  async refresh(changed: readonly string[], signal?: AbortSignal): Promise<boolean> {
    if (!this.#facts) return this.load(signal);
    const options = { ...this.#deps.scan, ...(signal ? { signal } : {}) };
    return this.#publish(await refreshLibrary(this.#deps.source, this.#facts, changed, options));
  }

  #publish(facts: LibraryFacts): boolean {
    const snapshot = buildSnapshot(facts, this.#deps.context());
    const hash = hashValue(snapshot);
    const changed = hash !== this.#hash;
    this.#facts = facts;
    this.#snapshot = snapshot;
    this.#hash = hash;
    return changed;
  }
}
