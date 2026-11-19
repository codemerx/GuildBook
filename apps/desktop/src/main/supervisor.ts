// The worker supervisor (IMPLEMENTATION.md §2.1): starts one worker per instance, pings it, and restarts it with
// growing delays when it crashes or stops answering, without touching the other instances. It gives up, and the
// instance shows an error, when a worker keeps failing. The Electron part, forking the utility process, sits behind
// WorkerLauncher, so this logic is tested without Electron.
import {
  type Clock,
  defaultRestartPolicy,
  type FaultPoints,
  noFaults,
  type Logger,
  nextWorkerState,
  recentRestarts,
  restartDelay,
  type RestartPolicy,
  shouldGiveUp,
  type Timer,
  type WorkerEvent,
  type WorkerState,
} from '@app/core';
import type { ErrorView, SetupHandoff, SetupIntent } from '@app/schemas';
import { type Client, type LifecycleReport, RpcEndpoint, type RpcPort, workerApi, type WorkerApi } from '@app/ipc';

/** What a worker needs to start: sent as its first message. */
export interface WorkerInit {
  readonly instanceId: string;
  readonly name: string;
  readonly libraryPath: string;
  readonly dataFolder: string;
  readonly testRoot: string | undefined;
  readonly clockOffsetMs: number;
  readonly testHooks: boolean;
  /** Test mode: the seed for this worker's randomness; each start mixes in its generation (TESTING.md §1). */
  readonly randomSeed: number | undefined;
  /** Which start of this worker this is, counted by the supervisor. */
  readonly generation?: number;
  /** The instance's git URL (null for a test library), for sign-in and access checks (Step 4). */
  readonly gitUrl?: string | null;
  /** setting-up until the wizard's [Finish] (IMPLEMENTATION.md §2.1). */
  readonly phase?: 'setting-up' | 'ready';
  /** What the setup's pending worker handed over, on the instance worker's first start. */
  readonly handoff?: SetupHandoff | null;
  /** A setup's pending worker: no data folder or database (IMPLEMENTATION.md §2.1). */
  readonly setup?: PendingSetupInit;
}

/** What a setup's pending worker needs: the URL, the device's other libraries, and where it may keep files. */
export interface PendingSetupInit {
  readonly id: string;
  readonly intent: SetupIntent;
  readonly url: string;
  readonly connected: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly gitUrl: string | null;
    readonly libraryPath: string;
    readonly prefix: string | null;
  }>;
  /** Every instance's added code repos: the library folder can't go inside one (Step 6). */
  readonly repos: readonly string[];
  /** In the device-level log folder. */
  readonly logFile: string;
  /** For git's repo-less commands and app-kept SSH keys; removed when the setup ends. */
  readonly tmpDir: string;
  /** The client id an invite link carried, for a self-hosted server's sign-in (Step 15). */
  readonly clientId?: string | null;
}

export interface LaunchedWorker {
  readonly pid: number | undefined;
  /** Main's end of the worker's port. */
  readonly port: RpcPort;
  /** Posts a message to the worker's parent port, with ports to hand over. */
  post(message: unknown, transfer?: readonly unknown[]): void;
  /** Ends the process at once, as a crash would. */
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
}

export interface WorkerLauncher {
  launch(init: WorkerInit): LaunchedWorker;
}

export interface Supervised {
  readonly instanceId: string;
  /** What the next launch is given: it follows the instance's record, see `SupervisorDeps.refreshInit`. */
  init: WorkerInit;
  state: WorkerState;
  error: ErrorView | null;
  restarts: number;
  restartTimes: number[];
  /** Counts launches; a renderer port is valid for one generation. */
  generation: number;
  worker: LaunchedWorker | undefined;
  endpoint: RpcEndpoint | undefined;
  client: Client<WorkerApi> | undefined;
  stopping: boolean;
  timer: Timer | undefined;
  pingSeq: number;
}

export interface SupervisorDeps {
  readonly launcher: WorkerLauncher;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly policy?: RestartPolicy;
  /** Test builds: a fault point before each restart, e.g. to hold an instance in "restarting" for a screenshot. */
  readonly faults?: FaultPoints;
  /** Called whenever an instance's worker state changes. */
  readonly onChange: (instanceId: string) => void;
  /** Called when a worker process ended, before any restart: e.g. to release its locks (A1.12). */
  readonly onExit: (instanceId: string) => void;
  /** Called for each new connection to a worker: main serves its device services on it. */
  readonly onConnect: (instanceId: string, endpoint: RpcEndpoint) => void;
  /**
   * The settings for a worker that starts again after it ended (a crash, a missed ping, a retry). The settings of the
   * first start are old by then: a library whose wizard is finished is no longer "setting-up", and its URL, name or
   * folder may have changed. Without this, the new worker believes the wizard is still open and changes no link.
   */
  readonly refreshInit?: (init: WorkerInit) => WorkerInit;
}

export class WorkerSupervisor {
  readonly #deps: SupervisorDeps;
  readonly #policy: RestartPolicy;
  readonly #workers = new Map<string, Supervised>();
  /**
   * The last generation of each instance this run, also after its worker was stopped: an instance removed and added
   * again (the same library joined again) must never reuse a generation, or its new port would be ignored.
   */
  readonly #generations = new Map<string, number>();

  constructor(deps: SupervisorDeps) {
    this.#deps = deps;
    this.#policy = deps.policy ?? defaultRestartPolicy;
  }

  get(instanceId: string): Supervised | undefined {
    return this.#workers.get(instanceId);
  }

  list(): Supervised[] {
    return [...this.#workers.values()];
  }

  start(init: WorkerInit): void {
    if (this.#workers.has(init.instanceId)) throw new Error(`worker for ${init.instanceId} already started`);
    const supervised: Supervised = {
      instanceId: init.instanceId,
      init,
      state: 'stopped',
      error: null,
      restarts: 0,
      restartTimes: [],
      generation: this.#generations.get(init.instanceId) ?? 0,
      worker: undefined,
      endpoint: undefined,
      client: undefined,
      stopping: false,
      timer: undefined,
      pingSeq: 0,
    };
    this.#workers.set(init.instanceId, supervised);
    this.#launch(supervised);
  }

  /** Asks the worker to close its database and exit; kills it if it doesn't within the timeout. */
  async stop(instanceId: string, timeoutMs = 5000): Promise<void> {
    const supervised = this.#workers.get(instanceId);
    if (!supervised) return;
    supervised.stopping = true;
    supervised.timer?.cancel();
    const worker = supervised.worker;
    if (!worker) {
      this.#workers.delete(instanceId);
      return;
    }
    const exited = new Promise<void>((resolve) => worker.onExit(() => resolve()));
    const kill = this.#deps.clock.setTimer(timeoutMs, () => worker.kill());
    supervised.client?.command.shutdown({}).catch(() => worker.kill());
    await exited;
    kill.cancel();
    this.#workers.delete(instanceId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#workers.keys()].map((id) => this.stop(id)));
  }

  /** Ends a worker process at once (the test API's killWorker). It's restarted like any crashed worker. */
  kill(instanceId: string): void {
    this.#workers.get(instanceId)?.worker?.kill();
  }

  /** Starts a worker that gave up again, e.g. after the user asked to retry. */
  retry(instanceId: string): void {
    const supervised = this.#workers.get(instanceId);
    if (!supervised || supervised.state !== 'failed' || supervised.worker) return;
    supervised.restartTimes = [];
    supervised.error = null;
    this.#relaunch(supervised);
  }

  /** Posts to a running worker: e.g. a new renderer port. */
  post(instanceId: string, message: unknown, transfer?: readonly unknown[]): boolean {
    const worker = this.#workers.get(instanceId)?.worker;
    if (!worker) return false;
    worker.post(message, transfer);
    return true;
  }

  #transition(supervised: Supervised, event: WorkerEvent): void {
    const next = nextWorkerState(supervised.state, event);
    if (!next || next === supervised.state) return;
    supervised.state = next;
    this.#deps.onChange(supervised.instanceId);
  }

  /** A start after the worker ended: with the settings as the instance has them now. */
  #relaunch(supervised: Supervised): void {
    supervised.init = this.#deps.refreshInit?.(supervised.init) ?? supervised.init;
    this.#launch(supervised);
  }

  #launch(supervised: Supervised): void {
    const logger = this.#deps.logger.child({ instance: supervised.instanceId });
    this.#transition(supervised, 'start');
    supervised.generation += 1;
    const generation = supervised.generation;
    this.#generations.set(supervised.instanceId, generation);
    let worker: LaunchedWorker;
    try {
      worker = this.#deps.launcher.launch({ ...supervised.init, generation });
    } catch (error) {
      logger.error('worker could not be started', { error: String(error) });
      this.#lost(supervised, generation);
      return;
    }
    supervised.worker = worker;
    const endpoint = new RpcEndpoint(worker.port, {
      onError: (report) => logger.warn('worker port problem', { code: report.code, message: report.message }),
    });
    supervised.endpoint = endpoint;
    const client = endpoint.connect(workerApi);
    supervised.client = client;
    this.#deps.onConnect(supervised.instanceId, endpoint);
    logger.info('worker started', { pid: worker.pid, generation });

    worker.onExit((code) => {
      if (supervised.generation !== generation) return;
      endpoint.dispose('rpc.disconnected');
      supervised.worker = undefined;
      supervised.endpoint = undefined;
      supervised.client = undefined;
      supervised.timer?.cancel();
      this.#deps.onExit(supervised.instanceId);
      if (supervised.stopping) {
        logger.info('worker stopped', { code });
        this.#transition(supervised, 'stopped');
        return;
      }
      if (supervised.state === 'failed') {
        logger.info('worker exited after reporting a failure', { code });
        return;
      }
      logger.warn('worker exited unexpectedly', { code });
      this.#lost(supervised, generation);
    });
  }

  /** A worker's report on its start, through the device services it calls on main. */
  reportLifecycle(instanceId: string, endpoint: RpcEndpoint, report: LifecycleReport): void {
    const supervised = this.#workers.get(instanceId);
    if (!supervised || supervised.endpoint !== endpoint) return;
    const logger = this.#deps.logger.child({ instance: instanceId });
    if (report.state === 'ready') {
      supervised.error = null;
      this.#transition(supervised, 'ready');
      this.#schedulePing(supervised, supervised.generation);
    } else if (report.state === 'failed') {
      logger.error('worker reported a failure', { code: report.error?.code });
      supervised.error = report.error;
      this.#transition(supervised, 'failed');
    }
  }

  #lost(supervised: Supervised, generation: number): void {
    const now = this.#deps.clock.now();
    supervised.restartTimes = [...recentRestarts(this.#policy, supervised.restartTimes, now), now];
    if (shouldGiveUp(this.#policy, supervised.restartTimes.slice(0, -1), now)) {
      supervised.error = { code: 'instance.workerFailed', params: { restarts: supervised.restartTimes.length - 1 } };
      this.#transition(supervised, 'failed');
      return;
    }
    this.#transition(supervised, 'lost');
    const delay = restartDelay(this.#policy, supervised.restartTimes.length - 1);
    supervised.timer = this.#deps.clock.setTimer(delay, () => {
      void (this.#deps.faults ?? noFaults).hit(`supervisor:restart:${supervised.instanceId}`).then(() => {
        if (supervised.generation !== generation || supervised.stopping) return;
        supervised.restarts += 1;
        this.#relaunch(supervised);
      });
    });
  }

  #schedulePing(supervised: Supervised, generation: number): void {
    supervised.timer?.cancel();
    supervised.timer = this.#deps.clock.setTimer(this.#policy.pingIntervalMs, () => {
      if (supervised.generation !== generation || !supervised.client) return;
      const controller = new AbortController();
      const timeout = this.#deps.clock.setTimer(this.#policy.pingTimeoutMs, () => controller.abort());
      supervised.pingSeq += 1;
      supervised.client.query
        .ping({ seq: supervised.pingSeq }, { signal: controller.signal })
        .then(() => {
          timeout.cancel();
          if (supervised.generation === generation) this.#schedulePing(supervised, generation);
        })
        .catch(() => {
          timeout.cancel();
          if (supervised.generation !== generation || supervised.stopping) return;
          this.#deps.logger.warn('worker stopped answering health pings; restarting it', {
            instance: supervised.instanceId,
          });
          supervised.worker?.kill();
        });
    });
  }
}
