// What a worker adds in test-hooks builds: armed fault points, the test-only samples, and its part of the test API
// (TESTING.md §6). The worker imports this module only inside `if (__TEST_HOOKS__)`.
import type { AuditEntry, GitRunRecord, SqliteStore } from '@app/adapters';
import {
  type AbsPath,
  type Clock,
  defineCommand,
  type DeviceServices,
  type FileSystem,
  type InstanceEngine,
  type LibrarySnapshot,
  type OperationRunner,
  type PathFlavour,
  AddRepo,
  AddRepoRoot,
  ApplyPlacement,
  OverviewQuery,
  type PlacementEdit,
  PreviewPlacement,
  PreviewTools,
  SetTools,
  type Random,
  randomToken,
  type Timer,
  WATCH_MARKER_PREFIX,
  type WatchSet,
  SetupChooseTools,
  SetupGo,
  SetupSummaryQuery,
} from '@app/core';
import {
  type ArmedFaults,
  runSampleWorkerStep,
  SAMPLE_DEVICE_OPERATION,
  SAMPLE_OPERATION,
  sampleOperation,
} from '@app/core/samples';
import type { Handlers, InstanceStatusView, LibraryGitView } from '@app/ipc';
import type { WorkerTestApi } from '@app/ipc/test-api';

export { ArmedFaults, SeededRandom, seedFrom } from '@app/core/samples';
export { workerTestApi } from '@app/ipc/test-api';

const RunSampleOperation = defineCommand<{ dir: string }, unknown>(SAMPLE_OPERATION);

export function registerSamples(deps: {
  engine: InstanceEngine;
  operations: OperationRunner;
  fs: FileSystem;
  paths: PathFlavour;
}): void {
  deps.operations.register(sampleOperation(deps.fs, deps.paths));
  deps.engine.handle(RunSampleOperation, ({ dir }) => deps.operations.start(SAMPLE_OPERATION, { dir }));
}

/** The worker's part of test-only device operations. */
export async function runTestDeviceStep(
  deps: { fs: FileSystem; paths: PathFlavour; dataFolder: string },
  kind: string,
  operationId: string,
): Promise<boolean> {
  if (kind !== SAMPLE_DEVICE_OPERATION) return false;
  await runSampleWorkerStep({ fs: deps.fs, paths: deps.paths, instanceDataFolder: deps.dataFolder }, operationId);
  return true;
}

export function workerTestHandlers(deps: {
  services: DeviceServices;
  engine: InstanceEngine;
  store: SqliteStore;
  operations: OperationRunner;
  faults: ArmedFaults;
  audit: readonly AuditEntry[];
  status: () => InstanceStatusView;
  fs: FileSystem;
  paths: PathFlavour;
  random: Random;
  watchSet: WatchSet;
  clock: Clock;
  library: () => LibrarySnapshot | null;
  git: () => Promise<LibraryGitView>;
  gitRuns: readonly GitRunRecord[];
  /** The test root: arranged paths are relative to it. */
  testRoot: string | undefined;
  /** An automatic backup of instance.db now; returns its file. */
  backup: () => string;
  /** The role asked for again (Step 12). */
  checkAccess: () => Promise<void>;
}): Handlers<WorkerTestApi> {
  return {
    queries: {
      dump: async () =>
        ({
          status: deps.status(),
          tables: deps.store.dumpTables(),
          journals: await deps.operations.journals(),
          faultHits: deps.faults.hits.slice(-200),
          audit: deps.audit.slice(-500),
          library: deps.library(),
          gitRuns: deps.gitRuns.slice(-200),
        }) as never,
      git: () => deps.git(),
    },
    commands: {
      waitForIdle: async () => {
        // A command first: one that moves the library (Step 9) would take a marker along to the new place.
        await deps.engine.whenIdle();
        // Watcher events drained (TESTING.md §6): a marker file in each watched folder, and its own event, come after
        // every earlier change's.
        for (const dir of deps.watchSet.dirs) {
          // A watched folder that's gone (S9, the library moved away) has no events to wait for.
          if ((await deps.fs.lstat(dir))?.kind !== 'dir') continue;
          // In a git working copy the marker goes into its .git folder, which is watched too: git status never lists it
          // there, so the git screens (Step 11) never show a test's marker as a change.
          const gitDir = deps.paths.join(dir, '.git') as AbsPath;
          const into = (await deps.fs.lstat(gitDir))?.kind === 'dir' ? gitDir : dir;
          const marker = deps.paths.join(into, `${WATCH_MARKER_PREFIX}${randomToken(deps.random)}`) as AbsPath;
          const seen = deps.watchSet.waitForMarker(marker);
          // The folder may go meanwhile (a relocation's cleanup): then there's nothing to wait for.
          const written = await deps.fs.writeTextAtomic(marker, '').then(
            () => true,
            () => false,
          );
          if (!written) continue;
          // A watcher that stopped working mustn't hang the test: it then fails on what it checks next.
          let timer: Timer | undefined;
          await Promise.race([
            seen,
            new Promise((resolve) => (timer = deps.clock.setTimer(10_000, () => resolve(undefined)))),
          ]);
          timer?.cancel();
          await deps.fs.remove(marker).catch(() => undefined);
        }
        deps.watchSet.flush();
        await deps.engine.whenIdle();
        return {};
      },
      holdLock: async ({ name }) => {
        // Held until the process ends: the test kills the worker to see main release it (A1.12).
        await deps.services.lock(name);
        return { held: true };
      },
      setupDefaults: async () => {
        await deps.engine.execute(SetupChooseTools, { enabled: [] });
        await deps.engine.execute(SetupGo, { page: 'summary' });
        return { hash: (await deps.engine.query(SetupSummaryQuery, {})).hash };
      },
      enableTools: async ({ tools }) => {
        const preview = await deps.engine.query(PreviewTools, { enabled: tools });
        await deps.engine.execute(SetTools, { enabled: tools, planHash: preview.hash });
        return {};
      },
      arrangePlacement: async ({ repos, roots, edits }) => {
        const at = (relative: string) =>
          deps.paths.isAbsolute(relative) ? relative : deps.paths.join(deps.testRoot ?? '', ...relative.split('/'));
        for (const repo of repos) await deps.engine.execute(AddRepo, { path: at(repo) });
        for (const root of roots) await deps.engine.execute(AddRepoRoot, { path: at(root) });
        if (edits.length === 0) return {};
        const overview = await deps.engine.query(OverviewQuery, {});
        const id = (name: unknown) => overview.repos.find((repo) => repo.name === name)?.id ?? String(name);
        const resolved = edits.map((edit) =>
          'repo' in edit ? { ...edit, repo: id(edit.repo) } : edit,
        ) as unknown as PlacementEdit[];
        const plan = await deps.engine.query(PreviewPlacement, { edits: resolved });
        await deps.engine.execute(ApplyPlacement, { edits: resolved, planHash: plan.hash });
        return {};
      },
      backupDatabase: () => ({ file: deps.backup() }),
      checkAccess: async () => {
        await deps.checkAccess();
        return {};
      },
      faultsArm: ({ point, action, delayMs, skip }) => {
        deps.faults.arm(point, action, {
          ...(delayMs === undefined ? {} : { delayMs }),
          ...(skip === undefined ? {} : { skip }),
        });
        return {};
      },
    },
  };
}
