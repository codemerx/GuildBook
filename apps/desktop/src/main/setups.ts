// Setups while their instance is pending (IMPLEMENTATION.md §2.1, Step 4). Each gets its own worker at the start, so
// even sign-in and the download run outside main. Main forwards the wizard's calls to it, records the download's
// temporary folder in device.json before it starts, and records the instance once the download is complete:
//   1. device.json: the instance (setting up) and, on the setup's record, its id and the handoff
//   2. the setup's secrets become the instance's
//   3. the pending worker stops
//   4. the download is renamed into place
//   5. the instance's own worker starts with the handoff, and the setup's record goes
// Each step is idempotent, so a crash at any point is finished at the next start; a setup that crashed before step 1
// leaves nothing, and its temporary folder is removed at the next start (A4.11).
import {
  type AbsPath,
  AppError,
  checkLibraryUrl,
  type Clock,
  type DataLayout,
  type DeviceRegistry,
  type FaultPoints,
  type FileSystem,
  type Logger,
  libraryName,
  linkedByDefault,
  parseGitUrl,
  type PathFlavour,
  type Random,
  randomHex,
  randomToken,
} from '@app/core';
import {
  type Client,
  type RpcEndpoint,
  type SetupView,
  type SetupWorkerApi,
  setupWorkerApi,
  type SignInInputView,
  type UrlCheckView,
} from '@app/ipc';
import type { GitIdentityValue, InstanceRecord, SetupFolderChoice, SetupIntent, SetupRecord } from '@app/schemas';
import type { InstanceManager } from './instances.ts';
import type { SecretsService } from './secrets.ts';
import type { WorkerInit, WorkerSupervisor } from './supervisor.ts';

export const SETUP_PREFIX = 'setup_';

export function isSetupId(id: string): boolean {
  return id.startsWith(SETUP_PREFIX);
}

export interface SetupManagerDeps {
  readonly registry: DeviceRegistry;
  readonly supervisor: WorkerSupervisor;
  readonly secrets: SecretsService;
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly layout: DataLayout;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  readonly instances: InstanceManager;
  /** The parts of a worker's start that every worker gets (clock offset, test root, …). */
  readonly baseInit: () => Omit<WorkerInit, 'instanceId' | 'name' | 'libraryPath' | 'dataFolder'>;
  readonly onChange: () => void;
  /** Test builds: e.g. a crash while a download runs (A4.11). */
  readonly faults?: FaultPoints;
}

/** The fault point after a download is recorded in device.json, while the clone runs. */
export const SETUP_DOWNLOAD_FAULT = 'setup:download:recorded';

interface Entry {
  readonly id: string;
  readonly intent: SetupIntent;
  readonly url: string;
  view: SetupView | null;
  client: Client<SetupWorkerApi> | undefined;
  /** Folders the worker may look at: the default one, and those the user picked. */
  readonly allowed: Set<string>;
  /** Whether main listens to this worker's events yet. */
  subscribed: boolean;
}

export class SetupManager {
  readonly #deps: SetupManagerDeps;
  readonly #entries = new Map<string, Entry>();

  constructor(deps: SetupManagerDeps) {
    this.#deps = deps;
  }

  /** The paths main may write for setups in progress: their temporary folders and where they go. */
  get roots(): { write: string[]; removeTree: string[] } {
    const setups = this.#deps.registry.usable ? this.#deps.registry.file.setups : [];
    return {
      write: [...setups.flatMap((s) => [s.downloadPath, s.libraryPath]), this.#tmpRoot()],
      removeTree: [...setups.map((s) => s.downloadPath), this.#tmpRoot()],
    };
  }

  views(): SetupView[] {
    return [...this.#entries.values()].flatMap((entry) => (entry.view ? [entry.view] : []));
  }

  /** The URL page's check: the host and repo shown before cloning, and "already connected" (A4.4, A4.12). */
  checkUrl(url: string): UrlCheckView {
    const checked = checkLibraryUrl(url, this.#connected());
    if (checked.ok) {
      const { url, host, repo } = checked.value;
      return { ok: true, url: url.url, name: libraryName(url), host, repo };
    }
    const error = checked.error;
    return {
      ok: false,
      problem: error.code,
      name: error.code === 'gitUrl.alreadyConnected' ? error.name : null,
      instanceId: error.code === 'gitUrl.alreadyConnected' ? error.instanceId : null,
    };
  }

  /** Starts a setup's pending worker for this URL. A second start for the same URL returns the one running. */
  async start(url: string, intent: SetupIntent, clientId: string | null = null): Promise<string> {
    if (!this.#deps.registry.usable) throw new AppError('device.newerData');
    const checked = checkLibraryUrl(url, this.#connected());
    if (!checked.ok) {
      if (checked.error.code === 'gitUrl.alreadyConnected') {
        throw new AppError('setup.alreadyConnected', { name: checked.error.name });
      }
      throw new AppError('setup.urlInvalid', { problem: checked.error.code });
    }
    const key = checked.value.url.key;
    const running = [...this.#entries.values()].find((e) => {
      const parsed = parseGitUrl(e.url);
      return parsed.ok && parsed.value.key === key && e.intent === intent;
    });
    if (running) return running.id;
    const id = `${SETUP_PREFIX}${randomHex(this.#deps.random, 8)}`;
    const entry: Entry = {
      id,
      intent,
      url: checked.value.url.url,
      view: null,
      client: undefined,
      allowed: new Set(),
      subscribed: false,
    };
    this.#entries.set(id, entry);
    const tmpDir = this.#deps.paths.join(this.#tmpRoot(), id);
    await this.#deps.fs.mkdirp(tmpDir as AbsPath);
    this.#deps.supervisor.start({
      ...this.#deps.baseInit(),
      instanceId: id,
      name: checked.value.repo,
      libraryPath: '',
      dataFolder: '',
      setup: {
        id,
        intent,
        url: entry.url,
        connected: this.#connected().map((c) => ({ ...c, libraryPath: c.libraryPath, prefix: c.prefix })),
        repos: this.#deps.instances.repoFolders(),
        logFile: this.#deps.paths.join(this.#deps.layout.logs, `${id}.log`),
        tmpDir,
        clientId,
      },
    });
    this.#deps.logger.info('setup started', { setup: id, intent });
    try {
      entry.view = await (await this.#client(id)).command.start({});
      entry.allowed.add(entry.view.defaultFolder);
    } catch (error) {
      await this.cancel(id);
      throw error;
    }
    this.#deps.onChange();
    return id;
  }

  /** The supervisor connected a setup's worker: its own API, and its events. */
  connect(id: string, endpoint: RpcEndpoint): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    const restarted = entry.client !== undefined;
    const client = endpoint.connect(setupWorkerApi);
    entry.client = client;
    if (restarted) {
      // The worker crashed and lost the setup: nothing of it is kept, and it starts again (IMPLEMENTATION.md §2.1).
      this.#deps.logger.warn('a setup worker restarted; the setup starts again', { setup: id });
      void this.#forget(id, this.#record(id))
        .then(() => client.command.start({}))
        .then((view) => {
          entry.view = view;
          this.#deps.onChange();
        })
        .catch((error: unknown) =>
          this.#deps.logger.error('setup restart failed', { setup: id, error: String(error) }),
        );
    }
    entry.subscribed = false;
  }

  /** The worker's events, once it serves them: a subscription sent before is refused (it isn't ready yet). */
  #subscribe(id: string, entry: Entry, client: Client<SetupWorkerApi>): void {
    if (entry.subscribed) return;
    entry.subscribed = true;
    client.on('changed', (view) => {
      if (this.#entries.get(id) !== entry || entry.client !== client) return;
      entry.view = { ...view, deviceCode: view.step === 'signIn' ? (entry.view?.deviceCode ?? null) : null };
      this.#deps.onChange();
    });
  }

  /** A folder the user picked in the dialog may be checked (PLAN.md §3.7 "files the user picks"). */
  allowFolder(id: string, path: string): void {
    this.#entries.get(id)?.allowed.add(this.#deps.paths.normalize(path));
  }

  signIn(id: string, input: SignInInputView, onCode: (code: { userCode: string; verificationUri: string }) => void) {
    return this.#act(id, async (client, entry) => {
      try {
        const view = await client.command.signIn(input, {
          onProgress: (code) => {
            if (entry.view) entry.view = { ...entry.view, deviceCode: code };
            this.#deps.onChange();
            onCode(code);
          },
        });
        return { ...view, deviceCode: null };
      } catch (error) {
        // The code was used: a sign-in that failed shows its reason, not the code any more.
        if (entry.view) entry.view = { ...entry.view, deviceCode: null };
        throw error;
      }
    });
  }

  setIdentity(id: string, identity: GitIdentityValue) {
    return this.#act(id, (client) => client.command.setIdentity({ identity }));
  }

  checkFolder(id: string, path: string) {
    return this.#act(id, (client, entry) => {
      const folder = this.#deps.paths.normalize(path);
      if (!entry.allowed.has(folder)) throw new AppError('fs.outsideAllowedRoots', { path: folder });
      return client.command.checkFolder({ path: folder });
    });
  }

  /** The download: recorded in device.json first, so a crash leaves a folder the next start removes. */
  download(id: string, onProgress: (progress: { phase: string; percent: number | null }) => void) {
    return this.#act(id, async (client, entry) => {
      const libraryPath = entry.view?.folder?.path;
      if (!libraryPath || (entry.view?.folder?.problems.length ?? 1) > 0) {
        throw new AppError('setup.wrongStep', { step: entry.view?.step ?? 'folder' });
      }
      const { paths } = this.#deps;
      const downloadPath = paths.join(
        paths.dirname(libraryPath),
        `.${paths.basename(libraryPath)}.download-${randomToken(this.#deps.random, 6)}`,
      );
      await this.#deps.registry.update((file) => {
        file.setups = file.setups.filter((s) => s.id !== id);
        file.setups.push({
          id,
          downloadPath,
          libraryPath,
          instanceId: null,
          handoff: null,
          startedAt: new Date(this.#deps.clock.now()).toISOString(),
        });
      });
      // Settled at once, so a failure while the fault point waits is never an unhandled rejection.
      const download = client.command.download({ libraryPath, downloadPath }, { onProgress }).then(
        (outcome) => ({ outcome, error: undefined }),
        (error: unknown) => ({ outcome: undefined, error }),
      );
      await this.#deps.faults?.hit(SETUP_DOWNLOAD_FAULT);
      const { outcome, error } = await download;
      if (!outcome) {
        await this.#dropRecord(id);
        throw error;
      }
      return this.#after(id, client, outcome.kind);
    });
  }

  createLibrary(id: string, prefix: string) {
    return this.#act(id, async (client) =>
      this.#after(id, client, (await client.command.createLibrary({ prefix })).kind),
    );
  }

  joinInstead(id: string) {
    return this.#act(id, async (client) => this.#after(id, client, (await client.command.joinInstead({})).kind));
  }

  /** The local-prefix page (Step 8): a prefix checked against the device while the user types. */
  checkLocalPrefix(id: string, prefix: string) {
    return this.#act(id, (client) => client.command.checkLocalPrefix({ prefix }));
  }

  /** The prefix check's answers for the user's own folders (PLAN.md §3.17 step 5): the download is complete. */
  chooseFolders(id: string, choices: readonly SetupFolderChoice[]) {
    return this.#act(id, async (client) =>
      this.#after(id, client, (await client.command.chooseFolders({ choices: [...choices] })).kind),
    );
  }

  /** The local prefix chosen: the download is complete, and the instance is recorded with it (PLAN.md §3.3 step 2). */
  chooseLocalPrefix(id: string, prefix: string) {
    return this.#act(id, async (client) =>
      this.#after(id, client, (await client.command.chooseLocalPrefix({ prefix })).kind),
    );
  }

  /** Before the download is complete nothing is kept: the worker stops and its folders go (A4.11). */
  async cancel(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    this.#entries.delete(id);
    await this.#deps.supervisor.stop(id).catch(() => undefined);
    const record = this.#record(id);
    if (record?.instanceId) {
      // The instance is recorded already: it's set up, and removing it is the device operation's job.
      throw new AppError('setup.wrongStep', { step: 'done', instanceId: record.instanceId });
    }
    await this.#forget(id, record);
    if (entry) this.#deps.logger.info('setup cancelled', { setup: id });
    this.#deps.onChange();
  }

  /** At start, before instances' workers: finishes completed downloads and removes the rest (A4.11). */
  async resumeAll(): Promise<void> {
    if (!this.#deps.registry.usable) return;
    for (const record of [...this.#deps.registry.file.setups]) {
      const instance = record.instanceId
        ? this.#deps.registry.file.instances.find((i) => i.id === record.instanceId)
        : undefined;
      if (instance && record.handoff) {
        this.#deps.logger.info('finishing a setup that was interrupted after its download', { setup: record.id });
        await this.#finish(record, instance);
      } else {
        this.#deps.logger.info('removing the download of a setup that was interrupted', { setup: record.id });
        await this.#forget(record.id, record);
      }
    }
    // Setups that never recorded a download leave only their secrets and temporary folders.
    for (const key of await this.#deps.secrets.keys(SETUP_PREFIX)) {
      await this.#deps.secrets.deletePrefix(`${key.split('/')[0] ?? key}/`);
    }
    if (await this.#deps.fs.lstat(this.#tmpRoot() as AbsPath))
      await this.#deps.fs.removeTree(this.#tmpRoot() as AbsPath);
  }

  // ---- Internals ------------------------------------------------------------------------------------------------

  async #after(
    id: string,
    client: Client<SetupWorkerApi>,
    kind: 'downloaded' | 'prefix' | 'localPrefix' | 'offer' | 'refused',
  ) {
    if (kind === 'downloaded') return this.#complete(id, client);
    const view = await client.query.view({});
    // A refused download, or the same library under another URL, keeps nothing: the worker removed the folder.
    if (kind === 'refused' || view.offer?.kind === 'sameLibrary') await this.#dropRecord(id);
    return view;
  }

  async #complete(id: string, client: Client<SetupWorkerApi>): Promise<SetupView> {
    const entry = this.#entries.get(id);
    const record = this.#record(id);
    if (!entry || !record) throw new AppError('setup.notFound', { setup: id });
    const result = await client.query.result({});
    const view = await client.query.view({});
    if (this.#deps.registry.file.instances.some((i) => i.id === result.libraryId)) {
      // Connected meanwhile, under another URL: the same library never gets a second folder.
      await this.#forget(id, record);
      throw new AppError('setup.alreadyConnected', { name: result.libraryId });
    }
    const parsed = parseGitUrl(entry.url);
    const instance: InstanceRecord = {
      id: result.libraryId,
      name: parsed.ok ? libraryName(parsed.value) : result.libraryId,
      gitUrl: entry.url,
      status: 'setting-up',
      gitPrefix: result.prefix,
      localPrefix: result.localPrefix,
      libraryPath: record.libraryPath,
      instructionsLinked: false,
      addedAt: new Date(this.#deps.clock.now()).toISOString(),
    };
    await this.#deps.registry.update((file) => {
      // Only one company's instructions are linked by default (PLAN.md §3.12).
      file.instances.push({ ...instance, instructionsLinked: linkedByDefault(file.instances) });
      const setup = file.setups.find((s) => s.id === id);
      if (setup) Object.assign(setup, { instanceId: instance.id, handoff: result.handoff });
    });
    this.#deps.logger.info('setup downloaded; the instance is setting up', { setup: id, instance: instance.id });
    await this.#finish({ ...record, instanceId: instance.id, handoff: result.handoff }, instance);
    this.#entries.delete(id);
    this.#deps.onChange();
    return { ...view, instanceId: instance.id, deviceCode: null };
  }

  /** Steps 2–5: idempotent, so the next start can run them again. */
  async #finish(record: SetupRecord, instance: InstanceRecord): Promise<void> {
    await this.#deps.secrets.movePrefix(`${record.id}/`, `${instance.id}/`);
    await this.#deps.supervisor.stop(record.id).catch(() => undefined);
    const { fs } = this.#deps;
    if (await fs.lstat(record.downloadPath as AbsPath)) {
      const target = await fs.lstat(record.libraryPath as AbsPath);
      if (target?.kind === 'dir' && (await fs.list(record.libraryPath as AbsPath)).length === 0) {
        await fs.remove(record.libraryPath as AbsPath);
      }
      await fs.rename(record.downloadPath as AbsPath, record.libraryPath as AbsPath);
    }
    if (!this.#deps.supervisor.get(instance.id)) {
      this.#deps.supervisor.start({ ...this.#deps.instances.workerInit(instance), handoff: record.handoff });
    }
    await this.#dropRecord(record.id);
    await this.#removeTmp(record.id);
  }

  async #forget(id: string, record: SetupRecord | undefined): Promise<void> {
    if (record && (await this.#deps.fs.lstat(record.downloadPath as AbsPath))) {
      await this.#deps.fs.removeTree(record.downloadPath as AbsPath);
    }
    await this.#dropRecord(id);
    await this.#deps.secrets.deletePrefix(`${id}/`);
    await this.#removeTmp(id);
  }

  async #dropRecord(id: string): Promise<void> {
    if (!this.#record(id)) return;
    await this.#deps.registry.update((file) => {
      file.setups = file.setups.filter((s) => s.id !== id);
    });
  }

  async #removeTmp(id: string): Promise<void> {
    const dir = this.#deps.paths.join(this.#tmpRoot(), id) as AbsPath;
    if (await this.#deps.fs.lstat(dir)) await this.#deps.fs.removeTree(dir);
  }

  #record(id: string): SetupRecord | undefined {
    return this.#deps.registry.usable ? this.#deps.registry.file.setups.find((s) => s.id === id) : undefined;
  }

  #tmpRoot(): string {
    return this.#deps.paths.join(this.#deps.layout.root, 'setups');
  }

  #connected() {
    return this.#deps.instances.records().map((r) => ({
      id: r.id,
      name: r.name,
      gitUrl: r.gitUrl,
      libraryPath: r.libraryPath,
      prefix: r.localPrefix ?? r.gitPrefix,
    }));
  }

  /** Runs a wizard action on the setup's worker, and keeps the latest view. */
  async #act(
    id: string,
    action: (client: Client<SetupWorkerApi>, entry: Entry) => Promise<SetupView>,
  ): Promise<SetupView> {
    const entry = this.#entries.get(id);
    if (!entry) throw new AppError('setup.notFound', { setup: id });
    const client = await this.#client(id);
    try {
      const view = await action(client, entry);
      if (this.#entries.get(id) === entry) entry.view = view;
      return view;
    } finally {
      this.#deps.onChange();
    }
  }

  async #client(id: string): Promise<Client<SetupWorkerApi>> {
    for (let waited = 0; ; waited += 25) {
      const worker = this.#deps.supervisor.get(id);
      const entry = this.#entries.get(id);
      if (!entry || !worker) throw new AppError('setup.notFound', { setup: id });
      if (worker.state === 'running' && entry.client) {
        this.#subscribe(id, entry, entry.client);
        return entry.client;
      }
      if (worker.state === 'failed') throw new AppError('instance.workerFailed', { setup: id });
      if (waited > 60_000) throw new AppError('rpc.timeout', { setup: id });
      await new Promise<void>((resolve) => this.#deps.clock.setTimer(25, resolve));
    }
  }
}
