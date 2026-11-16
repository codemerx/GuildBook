// The instance's trash (PLAN.md §3.8 "Safety rules"): anything the app removes from a tool folder goes here first, and
// can be restored from the activity log until its retention ends (7 days for relocation leftovers, 30 for the rest).
// Moving into the trash is a rename inside the user's disk, recorded first as `moving`: after a crash in between, the
// next sweep finds the entry where it went, or drops the record of a move that never happened. Nothing is lost.
import { type TrashEntry, type TrashReason, TRASH_RETENTION_DAYS } from '@app/schemas';
import type { Clock } from '../../ports/clock.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Random } from '../../ports/random.ts';
import type { Store } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import { randomToken } from '../../shared/ids.ts';
import type { PathFlavour } from '../../shared/paths.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrashDeps {
  readonly fs: FileSystem;
  readonly store: Store;
  readonly clock: Clock;
  readonly random: Random;
  readonly paths: PathFlavour;
  readonly logger: Logger;
  /** `<data folder>/trash`. */
  readonly dir: AbsPath;
}

export interface SweepReport {
  readonly expired: number;
  readonly recovered: number;
}

export class InstanceTrash {
  readonly #deps: TrashDeps;

  constructor(deps: TrashDeps) {
    this.#deps = deps;
  }

  /** Where an entry's item lies in the trash. */
  itemPath(entry: Pick<TrashEntry, 'id' | 'originalPath'>): AbsPath {
    const { paths, dir } = this.#deps;
    return paths.join(dir, entry.id, paths.basename(entry.originalPath)) as AbsPath;
  }

  list(): TrashEntry[] {
    return this.#deps.store.read((tx) => tx.trash.list());
  }

  /**
   * Moves `path` (a folder, a file or a link, never followed) into the trash. `restoreTo` is where [Restore] puts it,
   * when that isn't where it is now: a copy made aside of a version that's about to be overwritten (Step 8).
   */
  async put(
    path: AbsPath,
    reason: TrashReason,
    skill: string | null,
    options: { readonly restoreTo?: AbsPath } = {},
  ): Promise<TrashEntry> {
    const { fs, store, clock, random, paths, dir } = this.#deps;
    const found = await fs.lstat(path);
    if (!found) throw new AppError('fs.notFound', { path });
    const now = clock.now();
    const entry: TrashEntry = {
      id: `trash_${randomToken(random, 16)}`,
      originalPath: options.restoreTo ?? path,
      kind: found.kind === 'dir' ? 'dir' : found.kind === 'link' ? 'link' : 'file',
      reason,
      skill,
      trashedAt: now,
      expiresAt: now + TRASH_RETENTION_DAYS[reason] * DAY_MS,
      state: 'moving',
    };
    store.write((tx) => tx.trash.put(entry));
    const folder = paths.join(dir, entry.id) as AbsPath;
    await fs.mkdirp(folder);
    try {
      await fs.rename(path, this.itemPath(entry));
    } catch (error) {
      // Nothing moved (e.g. another disk, EXDEV): the record and its folder go again.
      await fs.removeEmptyFolder(folder);
      store.write((tx) => tx.trash.delete(entry.id));
      throw error;
    }
    const kept: TrashEntry = { ...entry, state: 'kept' };
    store.write((tx) => tx.trash.put(kept));
    this.#deps.logger.info('moved to the trash', { id: entry.id, reason, kind: entry.kind });
    return kept;
  }

  /**
   * The same for a folder on another disk than the trash, where a rename can't go (EXDEV): `copy` puts a copy in the
   * trash, then `removeOriginal` removes the folder. Relocation's old folder after a move across disks (Step 9).
   */
  async putCopy(
    path: AbsPath,
    reason: TrashReason,
    skill: string | null,
    how: { copy(from: AbsPath, to: AbsPath): Promise<void>; removeOriginal(path: AbsPath): Promise<void> },
  ): Promise<TrashEntry> {
    const { fs, store, clock, random, paths, dir } = this.#deps;
    const found = await fs.lstat(path);
    if (found?.kind !== 'dir') throw new AppError('fs.notFound', { path });
    const now = clock.now();
    const entry: TrashEntry = {
      id: `trash_${randomToken(random, 16)}`,
      originalPath: path,
      kind: 'dir',
      reason,
      skill,
      trashedAt: now,
      expiresAt: now + TRASH_RETENTION_DAYS[reason] * DAY_MS,
      state: 'moving',
    };
    store.write((tx) => tx.trash.put(entry));
    await fs.mkdirp(paths.join(dir, entry.id) as AbsPath);
    await how.copy(path, this.itemPath(entry));
    await how.removeOriginal(path);
    const kept: TrashEntry = { ...entry, state: 'kept' };
    store.write((tx) => tx.trash.put(kept));
    this.#deps.logger.info('copied to the trash', { id: entry.id, reason });
    return kept;
  }

  /** Puts an entry back where it was. Refused when something is there now, or the entry is gone. */
  async restore(id: string): Promise<TrashEntry> {
    const { fs, store } = this.#deps;
    const entry = store.read((tx) => tx.trash.get(id));
    if (!entry || entry.state !== 'kept') throw new AppError('trash.notFound', { id });
    const original = entry.originalPath as AbsPath;
    if (await fs.lstat(original)) throw new AppError('trash.pathTaken', { path: original });
    const item = this.itemPath(entry);
    if (!(await fs.lstat(item))) throw new AppError('trash.notFound', { id });
    await fs.rename(item, original);
    const restored: TrashEntry = { ...entry, state: 'restored' };
    store.write((tx) => tx.trash.put(restored));
    return restored;
  }

  /** Empties what's past its retention, and settles moves a crash interrupted. */
  async sweep(): Promise<SweepReport> {
    const { fs, store, clock, paths, dir, logger } = this.#deps;
    const now = clock.now();
    let expired = 0;
    let recovered = 0;
    for (const entry of this.list()) {
      const folder = paths.join(dir, entry.id) as AbsPath;
      if (entry.state === 'moving') {
        if (await fs.lstat(this.itemPath(entry))) {
          store.write((tx) => tx.trash.put({ ...entry, state: 'kept' }));
        } else {
          if (await fs.lstat(folder)) await fs.removeTree(folder);
          store.write((tx) => tx.trash.delete(entry.id));
        }
        recovered++;
        continue;
      }
      if (entry.expiresAt > now) continue;
      if (await fs.lstat(folder)) await fs.removeTree(folder);
      store.write((tx) => tx.trash.delete(entry.id));
      expired++;
    }
    if (expired + recovered > 0) logger.info('trash swept', { expired, recovered });
    return { expired, recovered };
  }
}
