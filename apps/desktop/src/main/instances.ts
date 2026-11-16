// The instances main knows about (IMPLEMENTATION.md §2.1): their records in device.json, their workers, and what the
// switcher and the tray show for each. Step 1 adds instances only as test libraries (local folders, test and
// development builds only); Step 4 adds sign-in and the download.
import {
  type AbsPath,
  AppError,
  checkTestLibrary,
  type Clock,
  type DataLayout,
  type DeviceRegistry,
  EventBus,
  type FileSystem,
  linkedByDefault,
  type LinkingAction,
  linkingChange,
  type Logger,
  newInstanceId,
  type PathFlavour,
  type Random,
  shownStatus,
} from '@app/core';
import type { InstanceView } from '@app/ipc';
import type { InstanceRecord } from '@app/schemas';
import type { WorkerInit, WorkerSupervisor } from './supervisor.ts';

export interface InstanceManagerDeps {
  readonly registry: DeviceRegistry;
  readonly supervisor: WorkerSupervisor;
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly layout: DataLayout;
  readonly clock: Clock & { readonly offsetMs?: number };
  readonly random: Random;
  readonly logger: Logger;
  readonly testRoot: string | undefined;
  readonly testHooks: boolean;
  /** Test mode: the seed this launch's workers derive theirs from. */
  readonly randomSeed: number | undefined;
  /** The instances whose linked instructions changed: their workers check them again (PLAN.md §3.12). */
  readonly onInstructionsChanged?: (instanceIds: readonly string[]) => void;
  /** An instance's local prefix changed: the other workers see another prefix in use (Step 8). */
  readonly onPrefixesChanged?: () => void;
  /** A library moved (Step 9): the other workers see its folder at the new place. */
  readonly onLibrariesChanged?: () => void;
}

export class InstanceManager {
  /** Fires whenever what the switcher or the tray shows may have changed. */
  readonly changes = new EventBus<void>();
  readonly #deps: InstanceManagerDeps;
  /** Folders the user picked in a dialog: main may look at them (PLAN.md §3.7 "files the user picks"). */
  readonly #picked = new Set<string>();
  /** Each instance's count of red warnings, as its worker last reported it. */
  readonly #attention = new Map<string, number>();
  /** Each instance's ↓ incoming and ↑ to push, as its worker last reported them (Step 11). */
  readonly #sync = new Map<string, { incoming: number; toPush: number }>();
  /** The instances that lost their access to the host, as their workers last reported (Step 4). */
  readonly #accessLost = new Set<string>();
  /** Each instance's added code repos, as its worker last reported them (PLAN.md §3.9 location check). */
  readonly #repos = new Map<string, readonly string[]>();

  constructor(deps: InstanceManagerDeps) {
    this.#deps = deps;
  }

  get pickedFolders(): readonly string[] {
    return [...this.#picked];
  }

  allowPicked(path: string): void {
    this.#picked.add(this.#deps.paths.normalize(path));
  }

  records(): readonly InstanceRecord[] {
    return this.#deps.registry.usable ? this.#deps.registry.file.instances : [];
  }

  /** An instance by id, or by name ignoring case (for tests and the no-window mode). */
  find(ref: string): InstanceRecord | undefined {
    const records = this.records();
    return records.find((r) => r.id === ref) ?? records.find((r) => r.name.toLowerCase() === ref.toLowerCase());
  }

  views(): InstanceView[] {
    return this.records().map((record) => {
      const worker = this.#deps.supervisor.get(record.id);
      return {
        id: record.id,
        name: record.name,
        status: shownStatus(record.status, worker?.state ?? 'stopped'),
        error: worker?.error ?? null,
        libraryPath: record.libraryPath,
        gitUrl: record.gitUrl,
        prefix: record.localPrefix ?? record.gitPrefix,
        localPrefix: record.localPrefix,
        gitPrefix: record.gitPrefix,
        restarts: worker?.restarts ?? 0,
        attention: this.#attention.get(record.id) ?? 0,
        ...(this.#sync.get(record.id) ?? {}),
        instructionsLinked: record.instructionsLinked,
        ...(this.#accessLost.has(record.id) ? { accessLost: true } : {}),
      };
    });
  }

  /** A worker's count of red warnings ("Needs attention", PLAN.md §3.8): the switcher and the tray show it. */
  setRepos(instanceId: string, paths: readonly string[]): void {
    this.#repos.set(instanceId, [...paths]);
  }

  /** The code repos every instance added: a new library folder can't go inside one. */
  repoFolders(): string[] {
    const ids = new Set(this.records().map((record) => record.id));
    return [...this.#repos].filter(([id]) => ids.has(id)).flatMap(([, paths]) => paths);
  }

  setAttention(instanceId: string, count: number): void {
    if ((this.#attention.get(instanceId) ?? 0) === count) return;
    this.#attention.set(instanceId, count);
    this.changes.emit();
  }

  /** A worker's report that its library lost its access to the host, or has it again: the badge and the tray follow. */
  setAccessLost(instanceId: string, lost: boolean): void {
    if (this.#accessLost.has(instanceId) === lost) return;
    if (lost) this.#accessLost.add(instanceId);
    else this.#accessLost.delete(instanceId);
    this.changes.emit();
  }

  setSync(instanceId: string, counts: { incoming: number; toPush: number }): void {
    const known = this.#sync.get(instanceId);
    if (known?.incoming === counts.incoming && known.toPush === counts.toPush) return;
    this.#sync.set(instanceId, { ...counts });
    this.changes.emit();
  }

  /** What every worker gets, an instance's or a setup's. */
  baseInit(): Omit<WorkerInit, 'instanceId' | 'name' | 'libraryPath' | 'dataFolder'> {
    return {
      catalogDir: this.#deps.layout.catalog,
      testRoot: this.#deps.testRoot,
      clockOffsetMs: this.#deps.clock.offsetMs ?? 0,
      testHooks: this.#deps.testHooks,
      randomSeed: this.#deps.randomSeed,
    };
  }

  workerInit(record: InstanceRecord): WorkerInit {
    return {
      ...this.baseInit(),
      instanceId: record.id,
      name: record.name,
      libraryPath: record.libraryPath,
      dataFolder: this.#deps.layout.instance(record.id).root,
      gitUrl: record.gitUrl,
      phase: record.status === 'setting-up' ? 'setting-up' : 'ready',
    };
  }

  /**
   * The settings for a worker that starts again after a crash: the instance's record as it is now, so a library whose
   * wizard was finished since the first start is "ready" (not "setting-up") and a changed URL or folder is used. The
   * handoff of a setup stays only while the library is still being set up. Workers of setups are not instances.
   * A test library has no git URL and no wizard: its worker keeps the settings of its first start (its folder is a
   * plain folder, not a library, so the settings of a finished setup would only make it report a missing library).
   */
  refreshInit(init: WorkerInit): WorkerInit {
    const record = this.records().find((r) => r.id === init.instanceId);
    if (!record || init.setup || record.gitUrl === null) return init;
    const fresh = this.workerInit(record);
    return record.status === 'setting-up' && init.handoff ? { ...fresh, handoff: init.handoff } : fresh;
  }

  /** Starts a worker for every instance in device.json at app start. */
  startAll(): void {
    for (const record of this.records()) {
      if (record.status === 'removing') {
        // Its device operation resumes it (IMPLEMENTATION.md §2.6); the worker starts when that needs it.
        continue;
      }
      // A setup finished at this start already started its worker, with its handoff.
      if (this.#deps.supervisor.get(record.id)) continue;
      this.#deps.supervisor.start(this.workerInit(record));
    }
    this.changes.emit();
  }

  /** Called when a worker's state changed: a test library becomes ready once its worker is. */
  async onWorkerChange(instanceId: string): Promise<void> {
    const record = this.records().find((r) => r.id === instanceId);
    const worker = this.#deps.supervisor.get(instanceId);
    // A worker that does not run knows nothing of its access: the next one reports it again after its first check.
    if (worker?.state !== 'running') this.#accessLost.delete(instanceId);
    if (record?.status === 'setting-up' && record.gitUrl === null && worker?.state === 'running') {
      await this.#deps.registry.update((file) => {
        const target = file.instances.find((r) => r.id === instanceId);
        if (target) target.status = 'ready';
      });
      this.#deps.logger.info('test library ready', { instance: instanceId });
    }
    this.changes.emit();
  }

  /**
   * The Instructions page's [Link], [Link anyway], [Unlink Acme's and link Globex's] and [Unlink] (PLAN.md §3.12): the
   * choice goes into device.json, and the workers whose choice changed check their instructions again.
   */
  async setInstructionsLinked(instanceId: string, action: LinkingAction): Promise<void> {
    if (!this.records().some((r) => r.id === instanceId)) throw new AppError('instance.notFound', { instanceId });
    const result = linkingChange(this.records(), instanceId, action);
    if (result.kind === 'warning') throw new AppError('instructions.othersLinked', { names: result.linked.join(', ') });
    if (result.changes.length === 0) return;
    await this.#deps.registry.update((file) => {
      for (const change of result.changes) {
        const target = file.instances.find((i) => i.id === change.id);
        if (target) target.instructionsLinked = change.linked;
      }
    });
    this.#deps.logger.info('instructions linking changed', { changes: result.changes });
    this.#deps.onInstructionsChanged?.(result.changes.map((change) => change.id));
    this.changes.emit();
  }

  /** An instance's local prefix, and the other instances' effective prefixes, as its worker asks (PLAN.md §3.3). */
  prefixes(instanceId: string): {
    gitPrefix: string | null;
    localPrefix: string | null;
    instances: Array<{ prefix: string; name: string }>;
  } {
    const records = this.records();
    const own = records.find((r) => r.id === instanceId);
    return {
      gitPrefix: own?.gitPrefix ?? null,
      localPrefix: own?.localPrefix ?? null,
      instances: records.flatMap((r) => {
        const prefix = r.localPrefix ?? r.gitPrefix;
        return r.id === instanceId || prefix === null ? [] : [{ prefix, name: r.name }];
      }),
    };
  }

  /**
   * Records an instance's local prefix (PLAN.md §3.3 step 2): the step of its worker's durable operation that tells
   * main, so it's idempotent. Every worker then sees the new prefix in use.
   */
  async setLocalPrefix(instanceId: string, prefix: string | null): Promise<void> {
    const record = this.records().find((r) => r.id === instanceId);
    if (!record) throw new AppError('instance.notFound', { instanceId });
    if (record.localPrefix === prefix) return;
    await this.#deps.registry.update((file) => {
      const target = file.instances.find((i) => i.id === instanceId);
      if (target) target.localPrefix = prefix;
    });
    this.#deps.logger.info('local prefix recorded', { instance: instanceId, localPrefix: prefix });
    this.#deps.onPrefixesChanged?.();
    this.changes.emit();
  }

  /**
   * Records an instance's git prefix after a prefix change (PLAN.md §3.2 step 3): a step of its worker's durable
   * operation, so it's idempotent. Every worker then sees the new prefix in use, and the switcher and the tray show it.
   */
  async setGitPrefix(instanceId: string, prefix: string): Promise<void> {
    const record = this.records().find((r) => r.id === instanceId);
    if (!record) throw new AppError('instance.notFound', { instanceId });
    if (record.gitPrefix === prefix) return;
    await this.#deps.registry.update((file) => {
      const target = file.instances.find((i) => i.id === instanceId);
      if (target) target.gitPrefix = prefix;
    });
    this.#deps.logger.info('git prefix recorded', { instance: instanceId, gitPrefix: prefix });
    this.#deps.onPrefixesChanged?.();
    this.changes.emit();
  }

  /** Where an instance's library folder can't go (PLAN.md §3.9 step 0): the other libraries, and every repo. */
  locationContext(instanceId: string): { libraries: Array<{ name: string; path: string }>; repos: string[] } {
    return {
      libraries: this.records()
        .filter((r) => r.id !== instanceId)
        .map((r) => ({ name: r.name, path: r.libraryPath })),
      repos: this.repoFolders(),
    };
  }

  /**
   * Records the library's new place (PLAN.md §3.9 step 6): the step of its worker's relocation that tells main, so
   * it's idempotent. The other workers see the folder at its new place.
   */
  async setLibraryPath(instanceId: string, path: string): Promise<void> {
    const record = this.records().find((r) => r.id === instanceId);
    if (!record) throw new AppError('instance.notFound', { instanceId });
    const folder = this.#deps.paths.normalize(path);
    if (record.libraryPath === folder) return;
    await this.#deps.registry.update((file) => {
      const target = file.instances.find((i) => i.id === instanceId);
      if (target) target.libraryPath = folder;
    });
    this.#deps.logger.info('library location recorded', { instance: instanceId });
    this.#deps.onLibrariesChanged?.();
    this.changes.emit();
  }

  /** Starts an instance's worker again from device.json, e.g. at its library's new place (PLAN.md §3.9 step 8). */
  async restartWorker(instanceId: string): Promise<void> {
    const record = this.records().find((r) => r.id === instanceId);
    if (!record || record.status === 'removing') return;
    await this.#deps.supervisor.stop(instanceId);
    const now = this.records().find((r) => r.id === instanceId);
    if (now && now.status !== 'removing' && !this.#deps.supervisor.get(instanceId)) {
      this.#deps.supervisor.start(this.workerInit(now));
    }
    this.changes.emit();
  }

  /** Step 1's thin slice: a local folder as a library, recorded and given its worker (test and dev builds only). */
  async addTestLibrary(name: string, path: string): Promise<string> {
    const checked = checkTestLibrary({ name, path }, this.records(), this.#deps.paths);
    if (!checked.ok) throw checked.error;
    const folder = checked.value.path;
    let entry: Awaited<ReturnType<FileSystem['lstat']>>;
    try {
      entry = this.#picked.has(folder) ? await this.#deps.fs.lstat(folder as AbsPath) : undefined;
    } catch {
      entry = undefined;
    }
    if (entry?.kind !== 'dir') throw new AppError('testLibrary.pathInvalid', { path: folder });
    const record: InstanceRecord = {
      id: newInstanceId(this.#deps.random),
      name: checked.value.name,
      gitUrl: null,
      status: 'setting-up',
      gitPrefix: null,
      localPrefix: null,
      libraryPath: folder,
      instructionsLinked: false,
      addedAt: new Date(this.#deps.clock.now()).toISOString(),
    };
    await this.#deps.registry.update((file) => {
      // Only one company's instructions are linked by default (PLAN.md §3.12).
      file.instances.push({ ...record, instructionsLinked: linkedByDefault(file.instances) });
    });
    this.#deps.logger.info('test library added', { instance: record.id });
    this.#deps.supervisor.start(this.workerInit(record));
    this.changes.emit();
    return record.id;
  }
}
