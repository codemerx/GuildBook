// Opening an instance's database with its safeguards (PLAN.md §3.5 "Safeguards if the database is lost"): automatic
// backup copies in `<data folder>/backups/`, and a damaged or missing database replaced by the latest one. The
// damaged file is kept beside it, renamed, never deleted. A database from a newer app version is still left untouched
// (A1.17): that isn't damage.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { looksDamaged, type OpenOptions, SqliteStore } from './sqlite-store.ts';
import { AppError, isAppError } from '@app/core';

export const BACKUPS_FOLDER = 'backups';
/** How many automatic backups are kept: the newest ones. */
export const KEPT_BACKUPS = 3;
/** A new automatic backup when the newest is older than this (a day). */
export const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;

const NAME = /^instance-(\d{8}T\d{6}Z)(?:-(\d+))?\.db$/;

export interface OpenedInstanceDatabase {
  readonly store: SqliteStore;
  readonly migratedFrom: number;
  readonly backups: string[];
  /** The backup the database was restored from, when it was missing or damaged. */
  readonly restoredFrom: string | null;
  /** Where the damaged file was put, when it was damaged. */
  readonly damagedCopy: string | null;
  /** Missing or damaged without a backup: a new, empty database. [Recover connections] rebuilds the registry. */
  readonly lost: boolean;
}

export interface InstanceDatabaseOptions extends OpenOptions {
  readonly backupsDir: string;
  /** The instance existed before (set up and ready): a missing database is a lost one. */
  readonly existing: boolean;
  readonly now: number;
}

/** The automatic backups, newest first. */
export function listBackups(dir: string): Array<{ file: string; at: number }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const match = NAME.exec(name);
      if (!match?.[1]) return [];
      const s = match[1];
      const at = Date.UTC(
        +s.slice(0, 4),
        +s.slice(4, 6) - 1,
        +s.slice(6, 8),
        +s.slice(9, 11),
        +s.slice(11, 13),
        +s.slice(13, 15),
      );
      // Two backups in the same second: the one with the higher counter is the newer.
      return [{ file: path.join(dir, name), at, n: Number(match[2] ?? 0) }];
    })
    .sort((a, b) => b.at - a.at || b.n - a.n)
    .map(({ file, at }) => ({ file, at }));
}

function stamp(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Makes a new automatic backup and keeps only the newest ones. Returns its file. */
export function backupInstanceDatabase(store: SqliteStore, dir: string, now: number): string {
  mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `instance-${stamp(now)}.db`);
  for (let n = 1; existsSync(file); n++) file = path.join(dir, `instance-${stamp(now)}-${n}.db`);
  store.backupTo(file);
  for (const old of listBackups(dir).slice(KEPT_BACKUPS)) rmSync(old.file, { force: true });
  return file;
}

/** Whether the newest backup is older than a day, or there is none. */
export function backupDue(dir: string, now: number): boolean {
  const newest = listBackups(dir)[0];
  return newest === undefined || now - newest.at >= BACKUP_EVERY_MS;
}

/** Puts a damaged database (and its write-ahead log) aside under a new name. */
function setAside(file: string, now: number): string {
  const aside = `${file}.damaged-${stamp(now)}`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${file}${suffix}`)) renameSync(`${file}${suffix}`, `${aside}${suffix}`);
  }
  return aside;
}

function restore(file: string, dir: string): string | null {
  for (const backup of listBackups(dir)) {
    try {
      for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
      copyFileSync(backup.file, file);
      const { store } = SqliteStore.open({ file });
      const ok = store.intact();
      store.close();
      if (ok) return backup.file;
    } catch {
      // A damaged backup: the next older one.
    }
    rmSync(file, { force: true });
  }
  return null;
}

function damage(error: unknown): boolean {
  if (!isAppError(error)) return true;
  return error.code !== 'instance.newerData';
}

export function openInstanceDatabase(options: InstanceDatabaseOptions): OpenedInstanceDatabase {
  const { file, backupsDir, now } = options;
  let damagedCopy: string | null = null;
  let restoredFrom: string | null = null;
  let lost = false;
  const missing = !existsSync(file);
  if (!missing && looksDamaged(file)) damagedCopy = setAside(file, now);
  else if (!missing) {
    try {
      const opened = SqliteStore.open(options);
      if (opened.store.intact()) return { ...opened, restoredFrom: null, damagedCopy: null, lost: false };
      opened.store.close();
      damagedCopy = setAside(file, now);
    } catch (error) {
      if (!damage(error)) throw error;
      if (isAppError(error) && error.code === 'instance.migrationFailed') throw error;
      damagedCopy = setAside(file, now);
    }
  }
  if (damagedCopy !== null || (missing && options.existing)) {
    restoredFrom = restore(file, backupsDir);
    lost = restoredFrom === null;
  }
  try {
    const opened = SqliteStore.open(options);
    return { ...opened, restoredFrom, damagedCopy, lost };
  } catch (error) {
    throw isAppError(error) ? error : new AppError('instance.migrationFailed', { version: 0 }, String(error));
  }
}
