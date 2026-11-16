// The library in the instance engine (IMPLEMENTATION.md §2.4): loading and refreshing the snapshot are commands in the
// instance's queue, so they never race a pull or another change; reading it is a query. Watcher events for the library
// folder collect here and become one refresh command; events that arrive while it runs make another.
import { type DomainEvent } from '../../shared/events.ts';
import { defineCommand, defineQuery, type InstanceEngine } from '../../engine/index.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { WatchEvent } from '../../ports/watcher.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { isAppError } from '../../shared/errors.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import type { LibrarySnapshot } from '../domain/snapshot.ts';
import type { LibraryModel } from './library-model.ts';

type NoInput = Record<string, never>;

/** A full scan of the library. Resolves to whether the snapshot changed. */
export const LoadLibrary = defineCommand<NoInput, boolean>('LoadLibrary');
/** Rescans what the collected watcher events touched. */
export const RefreshLibrary = defineCommand<NoInput, boolean>('RefreshLibrary');
export const LibrarySnapshotQuery = defineQuery<NoInput, LibrarySnapshot | null>('LibrarySnapshot');

/** The snapshot changed: the skills, their headers, tags or issues (IMPLEMENTATION.md §2.4 events). */
export interface LibraryChanged extends DomainEvent {
  readonly type: 'LibraryChanged';
}

export interface LibraryServiceDeps {
  readonly engine: InstanceEngine;
  readonly model: LibraryModel;
  /** The library folder, as the watcher reports paths in it. */
  readonly root: AbsPath;
  readonly paths: PathFlavour;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class LibraryService {
  readonly #deps: LibraryServiceDeps;
  readonly #changed = new Set<string>();
  #queued = false;

  constructor(deps: LibraryServiceDeps) {
    this.#deps = deps;
    const { engine, model } = deps;
    engine.handleQuery(LibrarySnapshotQuery, () => model.snapshot ?? null);
    engine.handle(LoadLibrary, async (_input, context) => {
      const changed = await model.load(context.signal);
      if (changed) context.emit(this.#event());
      return changed;
    });
    engine.handle(RefreshLibrary, async (_input, context) => {
      this.#queued = false;
      const paths = [...this.#changed];
      this.#changed.clear();
      try {
        const changed = await model.refresh(paths, context.signal);
        if (changed) context.emit(this.#event());
        return changed;
      } catch (error) {
        // Nothing is lost: the paths wait for the next refresh.
        for (const path of paths) this.#changed.add(path);
        throw error;
      }
    });
  }

  /**
   * Reads the library again now, inside the command that changed it (a pull, a branch switch, Step 11): the link check
   * that follows sees the new skills at once, not after the watcher's refresh.
   */
  async reloadNow(emit: (event: DomainEvent) => void): Promise<void> {
    if (await this.#deps.model.load()) emit(this.#event());
  }

  /** The first full scan. */
  async start(): Promise<void> {
    await this.#deps.engine.execute(LoadLibrary, {});
  }

  /** Watcher events in the library folder: the paths wait for one refresh command. */
  onWatchEvents(events: readonly WatchEvent[]): void {
    const { root, paths } = this.#deps;
    for (const event of events) {
      const relative = paths.relative(root, event.path);
      // A path the watcher reports outside the folder (e.g. through a link to the library): rescan everything.
      this.#changed.add(relative === undefined ? '' : relative.split(paths.sep).join('/'));
    }
    if (this.#changed.size === 0 || this.#queued) return;
    this.#queued = true;
    this.#deps.engine.execute(RefreshLibrary, {}).catch((error: unknown) => {
      this.#queued = false;
      const code = isAppError(error) ? error.code : 'internal';
      if (code !== 'command.cancelled')
        this.#deps.logger.warn('library refresh failed', { code, error: String(error) });
    });
  }

  #event(): LibraryChanged {
    return { type: 'LibraryChanged', at: this.#deps.clock.now() };
  }
}
