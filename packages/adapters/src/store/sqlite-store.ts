// The Store port on node:sqlite (ADR 0010, ADR 0011): an instance's instance.db in WAL mode, with numbered
// migrations, a backup before migrating an existing database, a separate read connection that sees only committed
// state, and repositories per group of tables. A database written by a newer app version is never opened for writing
// (IMPLEMENTATION.md §2.7, A1.17).
import {
  AppError,
  type NewEvent,
  type ReadTx,
  type RegistryRecord,
  type Store,
  type StoredEvent,
  type WriteTx,
} from '@app/core';
import {
  type AppliedState,
  AppliedStateSchema,
  defaultInstanceSettings,
  type HostAccount,
  HostAccountSchema,
  type InstanceSettings,
  InstanceSettingsSchema,
  type JsonValue,
  type RepoRecord,
  RepoRecordSchema,
  type SetupState,
  SetupStateSchema,
  type SkillMode,
  SkillModeSchema,
  type TrashEntry,
  TrashEntrySchema,
} from '@app/schemas';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: DatabaseSync): void;
}

/** The instance database's migrations. Never edit or remove one after a release: add the next (IMPLEMENTATION.md §6). */
export const instanceMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'settings, activity log and registry',
    up(db) {
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          device TEXT NOT NULL,
          author TEXT,
          path TEXT,
          kind TEXT NOT NULL,
          commit_id TEXT,
          details TEXT NOT NULL
        ) STRICT;
        CREATE INDEX events_by_kind ON events (kind, id);
        CREATE TABLE registry (
          kind TEXT NOT NULL,
          key TEXT NOT NULL,
          data TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (kind, key)
        ) STRICT;
      `);
    },
  },
  {
    version: 2,
    name: 'applied-state baseline',
    up(db) {
      // One row: the commit and skill list the instance last adjusted links for (PLAN.md §3.10).
      db.exec(`CREATE TABLE applied_state (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL) STRICT;`);
    },
  },
  {
    version: 3,
    name: 'host account and setup state',
    up(db) {
      // One row each: the sign-in without its secrets (Step 4), and where the setup wizard is until [Finish].
      db.exec(`
        CREATE TABLE host_account (id INTEGER PRIMARY KEY CHECK (id = 1), account TEXT NOT NULL) STRICT;
        CREATE TABLE setup_state (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL) STRICT;
      `);
    },
  },
  {
    version: 4,
    name: 'trash',
    up(db) {
      // What the app moved out of tool folders (Step 5), restorable from the activity log until it expires
      // (PLAN.md §3.8 "Retention"). The enabled tools are a new settings field, read with its default.
      db.exec(`
        CREATE TABLE trash (
          id TEXT PRIMARY KEY,
          trashed_at INTEGER NOT NULL,
          entry TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 5,
    name: 'placement',
    up(db) {
      // Placement (Step 6, PLAN.md §3.6 "Stored where"): repos and parent folders, tag rules, additions, exclusions,
      // each skill's mode and the tag suggestions turned down. Skill links get the repo and the checkout they're in;
      // every link before this step is global.
      db.exec(`
        CREATE TABLE repo (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          remote TEXT,
          name TEXT NOT NULL,
          root TEXT,
          added_at INTEGER NOT NULL,
          missing_since INTEGER,
          hidden INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE TABLE repo_root (path TEXT PRIMARY KEY) STRICT;
        CREATE TABLE repo_tag_rule (repo TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (repo, tag)) STRICT;
        CREATE TABLE repo_skill_added (repo TEXT NOT NULL, skill TEXT NOT NULL, PRIMARY KEY (repo, skill)) STRICT;
        CREATE TABLE repo_skill_excluded (repo TEXT NOT NULL, skill TEXT NOT NULL, PRIMARY KEY (repo, skill)) STRICT;
        CREATE TABLE skill_placement (skill TEXT PRIMARY KEY, mode TEXT NOT NULL) STRICT;
        CREATE TABLE repo_suggestion_dismissed (repo TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (repo, tag)) STRICT;
        UPDATE registry SET data = json_set(data, '$.repo', json('null'), '$.checkout', json('null'))
          WHERE kind = 'skill-link';
      `);
    },
  },
];

export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

/**
 * The schema version stored in a database file's header (`PRAGMA user_version`, bytes 60–63), read without opening
 * the database, so a newer database is never touched. Returns 0 for a missing or empty file.
 */
export function headerVersion(file: string): number {
  if (!existsSync(file)) return 0;
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(64);
    const read = readSync(fd, header, 0, 64, 0);
    if (read < 64) return 0;
    // Not an SQLite file at all: damaged, never "from a newer version" (Step 9's recovery decides what to do).
    if (!header.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) return 0;
    return header.readUInt32BE(60);
  } finally {
    closeSync(fd);
  }
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/** Whether a file is an SQLite database by its first bytes: an empty or missing file isn't damaged, just new. */
export function looksDamaged(file: string): boolean {
  if (!existsSync(file)) return false;
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(SQLITE_MAGIC.length);
    const read = readSync(fd, header, 0, header.length, 0);
    if (read === 0) return false;
    return read < header.length || !header.equals(SQLITE_MAGIC);
  } finally {
    closeSync(fd);
  }
}

export interface OpenOptions {
  readonly file: string;
  readonly migrations?: readonly Migration[];
}

interface Statements {
  settingsGet: StatementSync;
  settingsSet: StatementSync;
  eventsAppend: StatementSync;
  eventsList: StatementSync;
  eventsListKind: StatementSync;
  eventsCount: StatementSync;
  registryGet: StatementSync;
  registryList: StatementSync;
  registryPut: StatementSync;
  registryDelete: StatementSync;
  appliedGet: StatementSync;
  appliedSet: StatementSync;
  accountGet: StatementSync;
  accountSet: StatementSync;
  setupGet: StatementSync;
  setupSet: StatementSync;
  setupClear: StatementSync;
  trashGet: StatementSync;
  trashList: StatementSync;
  trashPut: StatementSync;
  trashDelete: StatementSync;
  repos: StatementSync;
  repoPut: StatementSync;
  repoDelete: StatementSync;
  roots: StatementSync;
  rootPut: StatementSync;
  rootDelete: StatementSync;
  rules: StatementSync;
  ruleOn: StatementSync;
  ruleOff: StatementSync;
  ruleDeleteRepo: StatementSync;
  added: StatementSync;
  addedOn: StatementSync;
  addedOff: StatementSync;
  addedDeleteRepo: StatementSync;
  addedRename: StatementSync;
  excluded: StatementSync;
  excludedOn: StatementSync;
  excludedOff: StatementSync;
  excludedDeleteRepo: StatementSync;
  excludedRename: StatementSync;
  modes: StatementSync;
  modeSet: StatementSync;
  modeClear: StatementSync;
  modeRename: StatementSync;
  dismissed: StatementSync;
  dismissPut: StatementSync;
  dismissDeleteRepo: StatementSync;
}

function prepare(db: DatabaseSync): Statements {
  return {
    settingsGet: db.prepare(`SELECT value FROM settings WHERE key = 'instance'`),
    settingsSet: db.prepare(
      `INSERT INTO settings (key, value) VALUES ('instance', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ),
    eventsAppend: db.prepare(
      `INSERT INTO events (ts, device, author, path, kind, commit_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    eventsList: db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`),
    eventsListKind: db.prepare(`SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT ?`),
    eventsCount: db.prepare(`SELECT count(*) AS n FROM events`),
    registryGet: db.prepare(`SELECT * FROM registry WHERE kind = ? AND key = ?`),
    registryList: db.prepare(`SELECT * FROM registry WHERE kind = ? ORDER BY key`),
    registryPut: db.prepare(
      `INSERT INTO registry (kind, key, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (kind, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ),
    registryDelete: db.prepare(`DELETE FROM registry WHERE kind = ? AND key = ?`),
    appliedGet: db.prepare(`SELECT state FROM applied_state WHERE id = 1`),
    appliedSet: db.prepare(
      `INSERT INTO applied_state (id, state) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state`,
    ),
    accountGet: db.prepare(`SELECT account FROM host_account WHERE id = 1`),
    accountSet: db.prepare(
      `INSERT INTO host_account (id, account) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET account = excluded.account`,
    ),
    setupGet: db.prepare(`SELECT state FROM setup_state WHERE id = 1`),
    setupSet: db.prepare(
      `INSERT INTO setup_state (id, state) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state`,
    ),
    setupClear: db.prepare(`DELETE FROM setup_state`),
    trashGet: db.prepare(`SELECT entry FROM trash WHERE id = ?`),
    trashList: db.prepare(`SELECT entry FROM trash ORDER BY trashed_at DESC, id DESC`),
    trashPut: db.prepare(
      `INSERT INTO trash (id, trashed_at, entry) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET trashed_at = excluded.trashed_at, entry = excluded.entry`,
    ),
    trashDelete: db.prepare(`DELETE FROM trash WHERE id = ?`),
    repos: db.prepare(`SELECT * FROM repo ORDER BY path, id`),
    repoPut: db.prepare(
      `INSERT INTO repo (id, path, remote, name, root, added_at, missing_since, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET path = excluded.path, remote = excluded.remote, name = excluded.name,
         root = excluded.root, added_at = excluded.added_at, missing_since = excluded.missing_since,
         hidden = excluded.hidden`,
    ),
    repoDelete: db.prepare(`DELETE FROM repo WHERE id = ?`),
    roots: db.prepare(`SELECT path FROM repo_root ORDER BY path`),
    rootPut: db.prepare(`INSERT OR IGNORE INTO repo_root (path) VALUES (?)`),
    rootDelete: db.prepare(`DELETE FROM repo_root WHERE path = ?`),
    rules: db.prepare(`SELECT repo, tag FROM repo_tag_rule ORDER BY repo, tag`),
    ruleOn: db.prepare(`INSERT OR IGNORE INTO repo_tag_rule (repo, tag) VALUES (?, ?)`),
    ruleOff: db.prepare(`DELETE FROM repo_tag_rule WHERE repo = ? AND tag = ?`),
    ruleDeleteRepo: db.prepare(`DELETE FROM repo_tag_rule WHERE repo = ?`),
    added: db.prepare(`SELECT repo, skill FROM repo_skill_added ORDER BY repo, skill`),
    addedOn: db.prepare(`INSERT OR IGNORE INTO repo_skill_added (repo, skill) VALUES (?, ?)`),
    addedOff: db.prepare(`DELETE FROM repo_skill_added WHERE repo = ? AND skill = ?`),
    addedDeleteRepo: db.prepare(`DELETE FROM repo_skill_added WHERE repo = ?`),
    addedRename: db.prepare(`UPDATE OR REPLACE repo_skill_added SET skill = ? WHERE skill = ?`),
    excluded: db.prepare(`SELECT repo, skill FROM repo_skill_excluded ORDER BY repo, skill`),
    excludedOn: db.prepare(`INSERT OR IGNORE INTO repo_skill_excluded (repo, skill) VALUES (?, ?)`),
    excludedOff: db.prepare(`DELETE FROM repo_skill_excluded WHERE repo = ? AND skill = ?`),
    excludedDeleteRepo: db.prepare(`DELETE FROM repo_skill_excluded WHERE repo = ?`),
    excludedRename: db.prepare(`UPDATE OR REPLACE repo_skill_excluded SET skill = ? WHERE skill = ?`),
    modes: db.prepare(`SELECT skill, mode FROM skill_placement ORDER BY skill`),
    modeSet: db.prepare(
      `INSERT INTO skill_placement (skill, mode) VALUES (?, ?) ON CONFLICT (skill) DO UPDATE SET mode = excluded.mode`,
    ),
    modeClear: db.prepare(`DELETE FROM skill_placement WHERE skill = ?`),
    modeRename: db.prepare(`UPDATE OR REPLACE skill_placement SET skill = ? WHERE skill = ?`),
    dismissed: db.prepare(`SELECT repo, tag FROM repo_suggestion_dismissed ORDER BY repo, tag`),
    dismissPut: db.prepare(`INSERT OR IGNORE INTO repo_suggestion_dismissed (repo, tag) VALUES (?, ?)`),
    dismissDeleteRepo: db.prepare(`DELETE FROM repo_suggestion_dismissed WHERE repo = ?`),
  };
}

interface RepoRow {
  id: string;
  path: string;
  remote: string | null;
  name: string;
  root: string | null;
  added_at: number;
  missing_since: number | null;
  hidden: number;
}

const toRepo = (row: RepoRow): RepoRecord => ({
  id: row.id,
  path: row.path,
  remote: row.remote,
  name: row.name,
  root: row.root,
  addedAt: row.added_at,
  missingSince: row.missing_since,
  hidden: row.hidden !== 0,
});

interface EventRow {
  id: number;
  ts: number;
  device: string;
  author: string | null;
  path: string | null;
  kind: string;
  commit_id: string | null;
  details: string;
}

interface RegistryRow {
  kind: string;
  key: string;
  data: string;
  updated_at: number;
}

const toEvent = (row: EventRow): StoredEvent => ({
  id: row.id,
  ts: row.ts,
  device: row.device,
  author: row.author,
  path: row.path,
  kind: row.kind,
  commit: row.commit_id,
  details: JSON.parse(row.details) as JsonValue,
});

const toRecord = (row: RegistryRow): RegistryRecord => ({
  kind: row.kind,
  key: row.key,
  data: JSON.parse(row.data) as JsonValue,
  updatedAt: row.updated_at,
});

function readers(s: Statements): ReadTx {
  return {
    settings: {
      get(): InstanceSettings {
        const row = s.settingsGet.get() as { value: string } | undefined;
        if (!row) return defaultInstanceSettings;
        const parsed = InstanceSettingsSchema.safeParse(JSON.parse(row.value));
        return parsed.success ? parsed.data : defaultInstanceSettings;
      },
    },
    events: {
      list(options = {}) {
        const limit = options.limit ?? -1;
        const rows = (options.kind === undefined
          ? s.eventsList.all(limit)
          : s.eventsListKind.all(options.kind, limit)) as unknown as EventRow[];
        return rows.map(toEvent);
      },
      count: () => (s.eventsCount.get() as { n: number }).n,
    },
    registry: {
      get(kind, key) {
        const row = s.registryGet.get(kind, key) as RegistryRow | undefined;
        return row && toRecord(row);
      },
      list: (kind) => (s.registryList.all(kind) as unknown as RegistryRow[]).map(toRecord),
    },
    appliedState: {
      get(): AppliedState | undefined {
        const row = s.appliedGet.get() as { state: string } | undefined;
        if (!row) return undefined;
        // An unreadable row is as good as none: links are then compared from scratch.
        const parsed = AppliedStateSchema.safeParse(JSON.parse(row.state));
        return parsed.success ? parsed.data : undefined;
      },
    },
    hostAccount: {
      get(): HostAccount | undefined {
        const row = s.accountGet.get() as { account: string } | undefined;
        if (!row) return undefined;
        const parsed = HostAccountSchema.safeParse(JSON.parse(row.account));
        return parsed.success ? parsed.data : undefined;
      },
    },
    setupState: {
      get(): SetupState | undefined {
        const row = s.setupGet.get() as { state: string } | undefined;
        if (!row) return undefined;
        const parsed = SetupStateSchema.safeParse(JSON.parse(row.state));
        return parsed.success ? parsed.data : undefined;
      },
    },
    trash: {
      get(id): TrashEntry | undefined {
        const row = s.trashGet.get(id) as { entry: string } | undefined;
        return row ? TrashEntrySchema.parse(JSON.parse(row.entry)) : undefined;
      },
      list: () =>
        (s.trashList.all() as unknown as Array<{ entry: string }>).map((row) =>
          TrashEntrySchema.parse(JSON.parse(row.entry)),
        ),
    },
    placement: {
      repos: () => (s.repos.all() as unknown as RepoRow[]).map(toRepo),
      roots: () => (s.roots.all() as unknown as Array<{ path: string }>).map((row) => row.path),
      tagRules: () => s.rules.all() as unknown as Array<{ repo: string; tag: string }>,
      added: () => s.added.all() as unknown as Array<{ repo: string; skill: string }>,
      excluded: () => s.excluded.all() as unknown as Array<{ repo: string; skill: string }>,
      modes: () =>
        (s.modes.all() as unknown as Array<{ skill: string; mode: string }>).flatMap((row) => {
          const mode = SkillModeSchema.safeParse(row.mode);
          return mode.success ? [{ skill: row.skill, mode: mode.data }] : [];
        }),
      dismissed: () => s.dismissed.all() as unknown as Array<{ repo: string; tag: string }>,
    },
  };
}

export class SqliteStore implements Store {
  readonly schemaVersion: number;
  readonly file: string;
  readonly #write: DatabaseSync;
  readonly #read: DatabaseSync;
  readonly #writeStatements: Statements;
  readonly #readStatements: Statements;
  #inWrite = false;

  private constructor(file: string, write: DatabaseSync, read: DatabaseSync, schemaVersion: number) {
    this.file = file;
    this.#write = write;
    this.#read = read;
    this.schemaVersion = schemaVersion;
    this.#writeStatements = prepare(write);
    this.#readStatements = prepare(read);
  }

  /**
   * Opens (or creates) the database and migrates it. Throws instance.newerData, leaving the file untouched, when it was
   * written by a newer app version.
   */
  static open(options: OpenOptions): { store: SqliteStore; migratedFrom: number; backups: string[] } {
    const migrations = [...(options.migrations ?? instanceMigrations)].sort((a, b) => a.version - b.version);
    const latest = latestVersion(migrations);
    const newer = (version: number) => new AppError('instance.newerData', { version, supported: latest });

    const onDisk = headerVersion(options.file);
    if (onDisk > latest) throw newer(onDisk);
    if (existsSync(`${options.file}-wal`)) {
      // The header may lag behind a write-ahead log the newer version left: ask SQLite, read-only.
      const peek = new DatabaseSync(options.file, { readOnly: true });
      try {
        const version = (peek.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
        if (version > latest) throw newer(version);
      } finally {
        peek.close();
      }
    }

    const existed = existsSync(options.file);
    const write = new DatabaseSync(options.file);
    try {
      write.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
      const from = (write.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (from > latest) throw newer(from);
      const backups: string[] = [];
      for (const migration of migrations.filter((m) => m.version > from)) {
        const current = (write.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
        if (existed && current > 0) {
          const backup = `${options.file}.v${current}.bak`;
          // An older backup of the same version wins: it's the data from before any attempt.
          if (!existsSync(backup)) write.prepare('VACUUM INTO ?').run(backup);
          backups.push(backup);
        }
        write.exec('BEGIN IMMEDIATE');
        try {
          migration.up(write);
          write.exec(`PRAGMA user_version = ${migration.version}`);
          write.exec('COMMIT');
        } catch (error) {
          write.exec('ROLLBACK');
          throw new AppError('instance.migrationFailed', { version: migration.version }, String(error));
        }
      }
      const read = new DatabaseSync(options.file, { readOnly: true });
      return { store: new SqliteStore(options.file, write, read, latest), migratedFrom: from, backups };
    } catch (error) {
      write.close();
      throw error;
    }
  }

  write<T>(fn: (tx: WriteTx) => T): T {
    if (this.#inWrite) throw new Error('nested write transaction');
    const s = this.#writeStatements;
    const read = readers(s);
    const tx: WriteTx = {
      settings: {
        ...read.settings,
        set: (settings) => void s.settingsSet.run(JSON.stringify(InstanceSettingsSchema.parse(settings))),
      },
      events: {
        append: (event: NewEvent) =>
          Number(
            s.eventsAppend.run(
              event.ts,
              event.device,
              event.author,
              event.path,
              event.kind,
              event.commit,
              JSON.stringify(event.details),
            ).lastInsertRowid,
          ),
        ...read.events,
      },
      registry: {
        ...read.registry,
        put: (kind: string, key: string, data: JsonValue, updatedAt: number) =>
          void s.registryPut.run(kind, key, JSON.stringify(data), updatedAt),
        delete: (kind: string, key: string) => void s.registryDelete.run(kind, key),
      },
      appliedState: {
        ...read.appliedState,
        set: (state) => void s.appliedSet.run(JSON.stringify(AppliedStateSchema.parse(state))),
      },
      hostAccount: {
        ...read.hostAccount,
        set: (account) => void s.accountSet.run(JSON.stringify(HostAccountSchema.parse(account))),
      },
      setupState: {
        ...read.setupState,
        set: (state) => void s.setupSet.run(JSON.stringify(SetupStateSchema.parse(state))),
        clear: () => void s.setupClear.run(),
      },
      trash: {
        ...read.trash,
        put: (entry) => {
          const checked = TrashEntrySchema.parse(entry);
          s.trashPut.run(checked.id, checked.trashedAt, JSON.stringify(checked));
        },
        delete: (id) => void s.trashDelete.run(id),
      },
      placement: {
        ...read.placement,
        putRepo: (repo) => {
          const r = RepoRecordSchema.parse(repo);
          s.repoPut.run(r.id, r.path, r.remote, r.name, r.root, r.addedAt, r.missingSince, r.hidden ? 1 : 0);
        },
        deleteRepo: (id) => {
          for (const statement of [s.ruleDeleteRepo, s.addedDeleteRepo, s.excludedDeleteRepo, s.dismissDeleteRepo]) {
            statement.run(id);
          }
          s.repoDelete.run(id);
        },
        putRoot: (path) => void s.rootPut.run(path),
        deleteRoot: (path) => void s.rootDelete.run(path),
        setTagRule: ({ repo, tag }, on) => void (on ? s.ruleOn : s.ruleOff).run(repo, tag),
        setAdded: ({ repo, skill }, on) => void (on ? s.addedOn : s.addedOff).run(repo, skill),
        setExcluded: ({ repo, skill }, on) => void (on ? s.excludedOn : s.excludedOff).run(repo, skill),
        setMode: (skill, mode: SkillMode) => {
          if (SkillModeSchema.parse(mode) === 'default') s.modeClear.run(skill);
          else s.modeSet.run(skill, mode);
        },
        dismiss: ({ repo, tag }) => void s.dismissPut.run(repo, tag),
        renameSkill: (from, to) => {
          if (from === to) return;
          for (const statement of [s.addedRename, s.excludedRename, s.modeRename]) statement.run(to, from);
        },
      },
    };
    this.#inWrite = true;
    this.#write.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(tx);
      if (result instanceof Promise) throw new Error('a write transaction must not span an await');
      this.#write.exec('COMMIT');
      return result;
    } catch (error) {
      this.#write.exec('ROLLBACK');
      throw error;
    } finally {
      this.#inWrite = false;
    }
  }

  read<T>(fn: (tx: ReadTx) => T): T {
    // One read transaction: every statement in `fn` sees the same committed snapshot.
    this.#read.exec('BEGIN');
    try {
      return fn(readers(this.#readStatements));
    } finally {
      this.#read.exec('COMMIT');
    }
  }

  /** Every table as JSON, for the test API's dumps (TESTING.md §6). */
  dumpTables(): Record<string, unknown[]> {
    const tables = this.#read
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const dump: Record<string, unknown[]> = {};
    this.read(() => {
      for (const { name } of tables) dump[name] = this.#read.prepare(`SELECT * FROM "${name}"`).all();
    });
    return dump;
  }

  close(): void {
    this.#read.close();
    this.#write.close();
  }

  /** A consistent copy of the whole database in one new file (PLAN.md §3.5 "automatic backup copies"). */
  backupTo(file: string): void {
    if (this.#inWrite) throw new Error('backup inside a write transaction');
    this.#write.prepare('VACUUM INTO ?').run(file);
  }

  /** SQLite's own quick check of every page: false when the file is damaged. */
  intact(): boolean {
    try {
      const rows = this.#read.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
      return rows.length === 1 && Object.values(rows[0] ?? {})[0] === 'ok';
    } catch {
      return false;
    }
  }
}
