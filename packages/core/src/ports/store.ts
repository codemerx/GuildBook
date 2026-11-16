// An instance's persistence: SQLite in WAL mode behind repositories (IMPLEMENTATION.md §2.7, ADR 0010, ADR 0011).
// A command collects its changes and writes them in one transaction. `write` takes a synchronous function, so a
// transaction can never span an await. `read` uses the read connection, which sees only committed state.
import type {
  AppliedState,
  HostAccount,
  InstanceSettings,
  JsonValue,
  RepoRecord,
  SetupState,
  SkillMode,
  TrashEntry,
} from '@app/schemas';

export interface Store {
  write<T>(fn: (tx: WriteTx) => T): T;
  read<T>(fn: (tx: ReadTx) => T): T;
  /** The schema version after migrations. */
  readonly schemaVersion: number;
}

export interface ReadTx {
  readonly settings: { get(): InstanceSettings };
  readonly events: { list(options?: { limit?: number; kind?: string }): StoredEvent[]; count(): number };
  readonly registry: RegistryReader;
  readonly appliedState: { get(): AppliedState | undefined };
  readonly hostAccount: { get(): HostAccount | undefined };
  readonly setupState: { get(): SetupState | undefined };
  readonly trash: TrashReader;
  readonly placement: PlacementReader;
}

/** A repo and a skill, or a repo and a tag: the rows of the placement tables (PLAN.md §3.6 "Stored where"). */
export interface RepoSkill {
  readonly repo: string;
  readonly skill: string;
}

export interface RepoTag {
  readonly repo: string;
  readonly tag: string;
}

/**
 * The placement choices (PLAN.md §3.6 "Stored where"): added repos and parent folders, tag rules, individual additions
 * and exclusions, each skill's mode, and the tag suggestions the user turned down. Lists are sorted.
 */
export interface PlacementReader {
  repos(): RepoRecord[];
  roots(): string[];
  tagRules(): RepoTag[];
  added(): RepoSkill[];
  excluded(): RepoSkill[];
  /** Only skills with a mode other than `default`. */
  modes(): Array<{ readonly skill: string; readonly mode: SkillMode }>;
  dismissed(): RepoTag[];
}

export interface PlacementWriter {
  putRepo(repo: RepoRecord): void;
  /** Removes the repo with its tag rules, additions, exclusions and dismissed suggestions. */
  deleteRepo(id: string): void;
  putRoot(path: string): void;
  deleteRoot(path: string): void;
  setTagRule(rule: RepoTag, on: boolean): void;
  setAdded(entry: RepoSkill, on: boolean): void;
  setExcluded(entry: RepoSkill, on: boolean): void;
  /** `default` removes the row. */
  setMode(skill: string, mode: SkillMode): void;
  dismiss(suggestion: RepoTag): void;
  /** A skill renamed in git (§3.8 S6): its additions, exclusions and mode move to the new name. */
  renameSkill(from: string, to: string): void;
}

/** What went to the instance's trash (PLAN.md §3.8 "Retention"), newest first. */
export interface TrashReader {
  get(id: string): TrashEntry | undefined;
  list(): TrashEntry[];
}

export interface WriteTx {
  readonly settings: { get(): InstanceSettings; set(settings: InstanceSettings): void };
  readonly events: {
    append(event: NewEvent): number;
    list(options?: { limit?: number; kind?: string }): StoredEvent[];
  };
  readonly registry: RegistryReader & RegistryWriter;
  /** The applied-state baseline (PLAN.md §3.10): the commit and skill list links were last adjusted for. */
  readonly appliedState: { get(): AppliedState | undefined; set(state: AppliedState): void };
  /** The sign-in without its secrets (PLAN.md §3.17 step 2): host, method, account, role. Tokens stay in main. */
  readonly hostAccount: { get(): HostAccount | undefined; set(account: HostAccount): void };
  /** Where the setup wizard is, until [Finish] clears it (IMPLEMENTATION.md §2.1). */
  readonly setupState: { get(): SetupState | undefined; set(state: SetupState): void; clear(): void };
  readonly trash: TrashReader & { put(entry: TrashEntry): void; delete(id: string): void };
  readonly placement: PlacementReader & PlacementWriter;
}

/** The activity log's row (PLAN.md §3.13): what happened, when, on which device, by whom, to which path. */
export interface NewEvent {
  readonly ts: number;
  readonly device: string;
  readonly author: string | null;
  readonly path: string | null;
  readonly kind: string;
  readonly commit: string | null;
  readonly details: JsonValue;
}

export interface StoredEvent extends NewEvent {
  readonly id: number;
}

/**
 * What the app created outside the library, per reconciler kind (PLAN.md §3.5). Each reconciler keeps its records
 * under its own kind, keyed by the exact path it manages.
 */
export interface RegistryRecord {
  readonly kind: string;
  readonly key: string;
  readonly data: JsonValue;
  readonly updatedAt: number;
}

export interface RegistryReader {
  get(kind: string, key: string): RegistryRecord | undefined;
  list(kind: string): RegistryRecord[];
}

export interface RegistryWriter {
  put(kind: string, key: string, data: JsonValue, updatedAt: number): void;
  delete(kind: string, key: string): void;
}
