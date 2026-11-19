// One instance's worker: its composition root (IMPLEMENTATION.md §2.1, §2.3). It creates the instance's data folder
// and opens instance.db with its migrations, runs the engine, resumes unfinished operations, answers main's pings and
// the renderer's queries, and writes its own log. A database from a newer app version is left untouched: the worker
// reports the failure and exits (A1.17).
import {
  createFileLogger,
  DugiteGit,
  GIT_VARIABLES,
  gitBaseEnv,
  type GitRunRecord,
  GuardedFileSystem,
  NodeFileSystem,
  NodeHostProbe,
  NodeHttpClient,
  NodeSigningKeys,
  NodeVolumes,
  backupDue,
  backupInstanceDatabase,
  BACKUPS_FOLDER,
  openInstanceDatabase,
  nodeEnv,
  nodeLinks,
  nodeRandom,
  OffsetClock,
  ParcelWatcher,
  type SqliteStore,
  ZipArchive,
  sweepLeftoverKeys,
  testSshOptions,
  type AuditEntry,
} from '@app/adapters';
import {
  AppError,
  AppliedStateBaseline,
  type AccessSnapshot,
  withDeviceLock,
  type DeviceCode,
  defineCommand,
  defineQuery,
  type FaultPoints,
  HostCredentials,
  InstanceAccess,
  readLibraryConfig,
  Scheduler,
  type SignInRequest,
  instanceLayout,
  InstanceEngine,
  isAppError,
  LibraryModel,
  LibraryService,
  LibrarySnapshotQuery,
  type LinksChanged,
  noFaults,
  OperationRunner,
  type AbsPath,
  type Random,
  ResumeOperations,
  isFetchBookkeeping,
  FinishSetup,
  SetupAnswerName,
  SetupChooseTools,
  SetupGo,
  SetupSetLibraryTags,
  SetupSetSkillTags,
  SetupSummaryQuery,
  SetupTickTag,
  SetupWizard,
  SetupWizardQuery,
  WatchSet,
  workingTreeSource,
  expandHome,
  buildSnapshot,
  scanLibrary,
  type LibrarySource,
} from '@app/core';
import {
  type AccessView,
  deviceServicesApi,
  instanceApi,
  type InstanceStatusView,
  type LibraryGitView,
  RpcEndpoint,
  type RpcPort,
  type Server,
  workerApi,
} from '@app/ipc';
import {
  type ErrorView,
  LIBRARY_FILE,
  PROJECTION_FOLDER,
  readLibraryYaml,
  SETUP_PAGES,
  type SetupState,
} from '@app/schemas';
import { bundledCatalog, instructionLimits } from '@app/tools';
import type { WorkerInit } from '../main/supervisor.ts';
import { liveToolHomeOf } from '../shared/live.ts';
import { readAsset } from './assets.ts';
import { libraryGitView } from './git-view.ts';
import { networkFor, remoteDeviceServices } from './device-services.ts';
import { WorkerEditing } from './editing.ts';
import { WorkerImports } from './imports.ts';
import { entriesJoiner } from './joined-entries.ts';
import { libraryView } from './library-view.ts';
import { joinedOnce, WorkerLinks } from './links.ts';
import { WorkerPrefix } from './prefix.ts';
import { WorkerReview } from './review.ts';
import { WorkerSync } from './sync.ts';
import { REMOVE_INSTANCE, REMOVE_FILES_STEP } from '../main/remove-instance.ts';
import { builtInClientId, runSetupWorker } from './setup-worker.ts';
import type { WorkerHost, WorkerMessage } from './host.ts';
import type * as TestHooks from './test-hooks.ts';

const StatusQuery = defineQuery<Record<string, never>, InstanceStatusView>('status');
const LibraryGitQuery = defineQuery<Record<string, never>, LibraryGitView>('LibraryGit');
// Not background work: a user command would cancel it, and the role would wait for the next start.
const CheckAccess = defineCommand<Record<string, never>, AccessSnapshot>('check-access');
const ChangeUrl = defineCommand<{ url: string }, void>('change-url');
const SignInAgain = defineCommand<
  { input: { method: SignInRequest }; onCode: (code: DeviceCode) => void },
  AccessSnapshot
>('sign-in-again');

/** Core's results are deeply readonly; the contracts' views are the same shapes without the modifier. */
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
const view = <T>(value: T): Mutable<T> => value as Mutable<T>;

function accessView(snapshot: AccessSnapshot): AccessView {
  return { ...snapshot };
}

const DeviceOperationStep = defineCommand<{ operationId: string; kind: string; step: string }, void>(
  'device-operation-step',
);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorView(error: unknown): ErrorView {
  return isAppError(error) ? { code: error.code, params: error.params } : { code: 'internal', params: {} };
}

export interface WorkerOptions {
  /** Whether this build has test hooks; the app passes the build flag. */
  readonly testHooks: boolean;
}

export async function startWorker(host: WorkerHost, options: WorkerOptions): Promise<void> {
  // One listener from the start: renderer ports that arrive while the worker is still starting wait in a queue.
  const rendererPorts: RpcPort[] = [];
  let onRendererPort: ((port: RpcPort) => void) | undefined;
  const init = await new Promise<WorkerMessage>((resolve) => {
    let initialized = false;
    host.onMessage((message) => {
      const type = (message.data as { type?: unknown } | null)?.type;
      if (type === 'init' && !initialized) {
        initialized = true;
        resolve(message);
      } else if (type === 'renderer-port' && message.ports[0]) {
        if (onRendererPort) onRendererPort(message.ports[0]);
        else rendererPorts.push(message.ports[0]);
      }
    });
  });
  const settings = (init.data as { init: WorkerInit }).init;
  const mainPort = init.ports[0];
  if (!mainPort) throw new Error('the worker needs its port to main');

  // Test hooks exist only in test-hooks builds: in production builds this import is removed at build time.
  let hooks: typeof TestHooks | undefined;
  if (__TEST_HOOKS__ && options.testHooks) hooks = await import('./test-hooks.ts');
  // A setup whose instance is still pending has a worker of its own, without a data folder (§2.1, Step 4).
  if (settings.setup) {
    await runSetupWorker(host, { ...settings, setup: settings.setup }, mainPort, hooks);
    return;
  }

  // git may also see where its global config is, and the temporary folder (GIT_VARIABLES).
  const liveToolHome = liveToolHomeOf(process.env, settings.testRoot);
  const env = nodeEnv({
    allow: GIT_VARIABLES,
    ...(settings.testRoot === undefined ? {} : { testRoot: settings.testRoot }),
    ...(liveToolHome === undefined ? {} : { liveToolHome }),
  });
  // Test mode: deterministic randomness, seeded per launch, instance and start, so a restart never repeats an id.
  const random: Random =
    hooks && settings.randomSeed !== undefined
      ? new hooks.SeededRandom(
          hooks.seedFrom(`${settings.randomSeed}:${settings.instanceId}:${settings.generation ?? 0}`),
        )
      : nodeRandom;
  const paths = env.paths;
  const clock = new OffsetClock(settings.clockOffsetMs);
  const layout = instanceLayout(settings.dataFolder as AbsPath, paths);
  const audit: AuditEntry[] = [];
  // The link engine, once it's built (below): it adds the exact link paths of its plans, and the tool folders.
  let links: WorkerLinks | undefined;
  // Where the library is read: device.json's place, until a relocation's rewrite step reads it at the new one (Step 9).
  let libraryPath = settings.libraryPath;
  // Main asked the worker to stop: nothing new starts.
  let stopping = false;
  // Imports (Step 13), once they're built (below): the picked folder is read while its import runs, and the originals
  // waiting for [Replace] may be moved to the trash.
  let imports: WorkerImports | undefined;
  // The prefix change (Step 14), once it's built (below): the link checks ask it first.
  let prefix: WorkerPrefix | undefined;
  const withOriginals = entriesJoiner();
  // The same array while its parts are: the guard keeps a lookup per array, and asks at every file operation (Step 17).
  const exactRoots = joinedOnce();
  const NO_PATHS: readonly string[] = [];
  const fs = new GuardedFileSystem({
    inner: new NodeFileSystem(),
    paths,
    // An instance writes only in its data folder, its library and the exact paths of an approved link plan
    // (IMPLEMENTATION.md §2.10).
    roots: () => {
      const linkRoots = links?.roots();
      // A relocation also reaches the old and the new place, and the folders the user named for it (Step 9).
      const moving = links?.relocation.roots();
      const importing = imports?.service.roots();
      const originals = importing?.originals ?? [];
      return {
        write: [settings.dataFolder, settings.libraryPath, ...(moving?.write ?? [])],
        read: [settings.dataFolder, settings.libraryPath, ...(moving?.read ?? []), ...(importing?.read ?? [])],
        removeTree: [settings.dataFolder],
        ...(linkRoots
          ? {
              entries: {
                write: withOriginals(linkRoots.entries, originals),
                read: withOriginals(linkRoots.entries, originals),
              },
              exact: exactRoots([linkRoots.exact, moving?.exact ?? NO_PATHS]),
              lists: linkRoots.lists,
              made: linkRoots.made,
            }
          : {}),
      };
    },
    ...(env.testRoot === undefined
      ? {}
      : { testRoot: env.testRoot, audit: (entry: AuditEntry) => void audit.push(entry) }),
    ...(env.liveToolHome === undefined ? {} : { liveToolHome: env.liveToolHome }),
  });
  // The worker creates its data folder (Step 1's thin slice).
  await fs.mkdirp(layout.logs);
  const logger = createFileLogger({
    file: paths.join(layout.logs, 'worker.log'),
    clock,
    level: options.testHooks ? 'debug' : 'info',
  }).child({ instance: settings.instanceId });

  const main = new RpcEndpoint(mainPort, {
    onError: (report) => logger.warn('port to main: message rejected', { code: report.code, message: report.message }),
  });
  const services = main.connect(deviceServicesApi);
  await services.command.reportLifecycle({ state: 'starting', error: null });
  const deviceServices = remoteDeviceServices(services);

  // Git (ADR 0013): the library's repo, with the sign-in main keeps (ADR 0014), and the proxy and certificate bundle main
  // resolves for each URL (ADR 0015). App-kept SSH keys live in tmp/ for one command, and leftovers from a crash are
  // deleted now.
  const gitTmp = paths.join(settings.dataFolder, 'tmp') as AbsPath;
  await fs.mkdirp(gitTmp);
  const leftoverKeys = await sweepLeftoverKeys(gitTmp);
  if (leftoverKeys > 0) logger.info('removed leftover SSH key files', { count: leftoverKeys });
  const gitRuns: GitRunRecord[] = [];
  const network = networkFor(services);
  const http = new NodeHttpClient({ network, requireProxy: settings.testRoot !== undefined });
  const probe = new NodeHostProbe(http, () => clock.now());
  const credentials = new HostCredentials({ services: deviceServices, clock, logger, host: (e) => probe.host(e) });
  // Roles, change requests and signing (Step 12), once they're built (below): the library's commits are signed where
  // the host requires it.
  let review: WorkerReview | undefined;
  const git = new DugiteGit({
    paths,
    platform: env.platform,
    baseEnv: gitBaseEnv(env),
    clock,
    logger,
    libraryRoots: () => [settings.libraryPath, ...(links?.relocation.roots().read ?? [])],
    importRoots: () => imports?.service.roots().git ?? [],
    neutralDir: gitTmp,
    keyDir: gitTmp,
    credentials: (url) => credentials.gitAuth(url),
    network,
    sshOptions: testSshOptions(env),
    signing: async (repo) => (review && repo === libraryPath ? review.service.signing.gitSigning() : null),
    // Test mode keeps the commands it ran, for the privacy checks (TESTING.md §9.4).
    ...(hooks ? { onRun: (run: GitRunRecord) => void (gitRuns.push(run) > 500 && gitRuns.shift()) } : {}),
  });

  let store: SqliteStore;
  // A damaged or missing database is replaced by its latest automatic backup; without one the connections wait for
  // [Recover connections] (PLAN.md §3.5). A setup's new instance has no database yet: that isn't a loss.
  const backupsDir = paths.join(settings.dataFolder, BACKUPS_FOLDER);
  let opened: ReturnType<typeof openInstanceDatabase>;
  try {
    opened = openInstanceDatabase({
      file: layout.database,
      backupsDir,
      existing: settings.phase === 'ready',
      now: clock.now(),
    });
    store = opened.store;
    logger.info('database open', {
      schema: store.schemaVersion,
      migratedFrom: opened.migratedFrom,
      backups: opened.backups.length,
      restored: opened.restoredFrom !== null,
      damaged: opened.damagedCopy !== null,
      lost: opened.lost,
    });
  } catch (error) {
    logger.error('database not usable; leaving it untouched', {
      code: isAppError(error) ? error.code : 'internal',
      error: String(error),
    });
    await services.command.reportLifecycle({ state: 'failed', error: errorView(error) });
    host.exit(0);
    return;
  }

  const armed = hooks ? new hooks.ArmedFaults({ crash: () => process.kill(process.pid, 'SIGKILL'), wait }) : undefined;
  const faults: FaultPoints = armed ?? noFaults;
  const engine = new InstanceEngine({ clock, random, logger });
  const operations = new OperationRunner({ fs, paths, journalDir: layout.journal, clock, random, faults, logger });
  if (hooks) hooks.registerSamples({ engine, operations, fs, paths });

  // The tool catalog: the one the app ships with. A change to it comes with a new version (ADR 0037).
  const catalog = bundledCatalog;

  // The library: its snapshot, refreshed from the watcher's events (IMPLEMENTATION.md Step 2).
  const libraryRoot = settings.libraryPath as AbsPath;
  const snapshotContext = () => ({
    appVersion: __APP_VERSION__,
    platform: env.platform,
    libraryRoot,
    projection: null,
    instructionLimits: instructionLimits(catalog),
  });
  const libraryModel = new LibraryModel({
    source: workingTreeSource(fs, paths, libraryRoot),
    context: snapshotContext,
  });
  const library = new LibraryService({ engine, model: libraryModel, root: libraryRoot, paths, clock, logger });
  // The git screens (Step 11), once they're built (below).
  let sync: WorkerSync | undefined;
  // The renderer's port, once it's connected (below).
  let renderer: { endpoint: RpcEndpoint; server: Server<typeof instanceApi> } | undefined;
  // The projected copies (Step 8): edits made through the links land there, and go back into the library at once.
  const projectionRoot = paths.join(settings.dataFolder, PROJECTION_FOLDER);
  const inCopies = (path: string) => paths.isInside(projectionRoot, path);
  const watchSet = new WatchSet({
    watcher: new ParcelWatcher(),
    clock,
    onBatch: (events) => {
      const copies = events.filter((event) => inCopies(event.path));
      const inFolder = events.filter((event) => !inCopies(event.path));
      // A fetch's own files (FETCH_HEAD, remote-tracking refs) change only what is incoming: the git screens follow,
      // and the library isn't read again. A refresh for them would interrupt the fetch that writes them.
      const fetchOnly = (path: string) => {
        const relative = paths.relative(libraryRoot, path);
        return relative !== undefined && isFetchBookkeeping(relative.split(paths.sep).join('/'));
      };
      const inLibrary = inFolder.filter((event) => !fetchOnly(event.path));
      if (inFolder.length > 0) renderer?.server.emit('gitChanged', {});
      if (inLibrary.length > 0) {
        // Any other change in the folder or its .git (HEAD, local branches, the index) may change the library and
        // the links: a pull, a branch switch or a skill deleted through a link, made with any tool (PLAN.md §3.10).
        library.onWatchEvents(inLibrary);
      }
      if (copies.length > 0 || inLibrary.length > 0) {
        links?.check(copies.length > 0 ? 'copies changed' : 'library changed');
      }
    },
    onError: (dir, error) => {
      logger.warn('watching stopped', { dir, error: error.message });
      // The library folder may be gone: the check tells (S9).
      links?.check('watching stopped');
    },
  });

  const status = (): InstanceStatusView => {
    const running = engine.status.running;
    return {
      instanceId: settings.instanceId,
      name: settings.name,
      libraryPath: settings.libraryPath,
      dataFolder: settings.dataFolder,
      schemaVersion: store.schemaVersion,
      busy: running ? { command: running.command, progress: running.progress } : null,
      queued: engine.status.queued,
    };
  };
  engine.handleQuery(StatusQuery, status);
  const libraryRepo = git.repo(settings.libraryPath as AbsPath);
  engine.handleQuery(LibraryGitQuery, () => libraryGitView(libraryRepo));

  // Sign-in and access (Step 4): the role is asked for at every start, and a lost access has three ways out.
  let gitUrl = settings.gitUrl ?? null;
  const access = new InstanceAccess({
    credentials,
    probe,
    git,
    repo: libraryRepo,
    store,
    clock,
    random,
    logger,
    gitUrl: () => gitUrl,
    builtInClientId,
    onChange: (snapshot) => {
      renderer?.server.emit('accessChanged', accessView(snapshot));
      renderer?.server.emit('reviewChanged', {});
      void services.command.reportAccess({ lost: snapshot.state === 'lost' }).catch(() => undefined);
    },
  });
  engine.handle(CheckAccess, (_input, context) => access.check(context.signal));
  engine.handle(SignInAgain, ({ input, onCode }, context) =>
    access.signInAgain(input, { signal: context.signal, onCode }),
  );
  engine.handle(ChangeUrl, async ({ url }) => {
    // The new URL must hold this very library: its library.yaml id decides (PLAN.md §3.1).
    const head = await libraryRepo.fetchUrl(url);
    const entry = (await libraryRepo.listTree(head)).find((e) => e.path === LIBRARY_FILE && e.kind !== 'dir');
    const text = entry ? new TextDecoder().decode(await libraryRepo.readBlob(entry.oid)) : null;
    const id = text === null ? undefined : readLibraryYaml(text).value.id;
    if (id !== settings.instanceId) throw new AppError('instance.otherLibrary', { found: id ?? '' });
    await libraryRepo.setRemoteUrl(url);
    gitUrl = url;
    logger.info('library URL changed');
    void engine.execute(CheckAccess, {}).catch(() => undefined);
  });

  // The setup wizard after the download (IMPLEMENTATION.md §2.1): its state survives a restart until [Finish].
  const setupState = (): SetupState | undefined => store.read((tx) => tx.setupState.get());
  if (settings.phase === 'setting-up') {
    const handoff = settings.handoff ?? null;
    store.write((tx) => {
      if (handoff && !tx.hostAccount.get()) tx.hostAccount.set(handoff.account);
      if (!tx.setupState.get()) {
        const intent = handoff?.intent ?? 'join';
        tx.setupState.set({
          intent,
          page: handoff?.needsUpdate ? 'needsUpdate' : SETUP_PAGES[intent][0],
          needsUpdate: handoff?.needsUpdate ?? null,
          tools: null,
          tags: [],
          names: {},
          folders: handoff?.folders ?? [],
        });
      }
    });
    const state = setupState();
    if (state?.page === 'needsUpdate') {
      // After an update the library may be fine now.
      const file = paths.join(libraryRoot, LIBRARY_FILE) as AbsPath;
      const text = (await fs.lstat(file)) ? await fs.readText(file) : null;
      if (readLibraryConfig(text, __APP_VERSION__).compatibility === 'ok') {
        store.write((tx) => tx.setupState.set({ ...state, page: SETUP_PAGES[state.intent][0], needsUpdate: null }));
      }
    }
  } else if (setupState()) store.write((tx) => tx.setupState.clear());

  // Each added code repo's git folder is watched for its worktree list (PLAN.md §3.6 "Worktrees"): a worktree an agent
  // creates gets the repo's links within seconds. Only events below `worktrees/` matter; git's other files change on
  // every command and are ignored. No marker files: nothing of the app's is ever written in a code repo's .git.
  const repoWatch = new WatchSet({
    watcher: new ParcelWatcher(),
    clock,
    onBatch: (events) => {
      if (events.some((event) => /[\\/]worktrees([\\/]|$)/.test(event.path))) links?.check('worktrees changed');
    },
    onError: (dir, error) => logger.warn('watching a repo stopped', { dir, error: error.message }),
  });
  const watchRepos = async (repos: readonly { gitDir: string | null }[]) => {
    const wanted = new Set(repos.flatMap((repo) => (repo.gitDir ? [repo.gitDir] : [])));
    for (const dir of repoWatch.dirs) if (!wanted.has(dir)) await repoWatch.remove(dir);
    for (const dir of wanted) {
      await repoWatch
        .add(dir as AbsPath, {
          ignore: ['objects/**', 'logs/**', 'refs/**', 'lfs/**', 'hooks/**', 'modules/**', 'info/**', 'rr-cache/**'],
        })
        .catch((error: unknown) => logger.warn('a repo can not be watched', { error: String(error) }));
    }
  };
  let reportedRepos = '';

  // The link engine (Step 5): skill links in every enabled tool, checked at start, on focus, every 3 minutes and
  // after git changes (PLAN.md §3.8 "When"). Placement (Step 6) decides where each skill goes.
  const facts = await services.query.facts({});
  // Whether the company's instructions are linked on this device: main's device.json, followed on every change.
  let instructionsLinked = (await services.query.instructionsLinked({})).linked;
  const baseline = new AppliedStateBaseline({ repo: libraryRepo, store, clock });
  const workerLinks = new WorkerLinks({
    instanceId: settings.instanceId,
    instructionsLinked: () => instructionsLinked,
    engine,
    store,
    fs,
    links: fs.links(nodeLinks),
    paths,
    clock,
    random,
    logger,
    faults,
    home: env.home,
    dataFolder: settings.dataFolder,
    libraryRoot: () => libraryPath,
    catalog: () => catalog,
    snapshot: () => libraryModel.snapshot ?? null,
    repo: libraryRepo,
    baseline,
    baselineMoved: (diff) => {
      void sync?.service
        .baselineMoved(diff)
        .catch((error: unknown) =>
          logger.warn('a change made with another git tool was not announced', { error: String(error) }),
        );
    },
    deviceName: () => facts.deviceName,
    // Nothing outside the library changes before [Finish] (§2.1), or while the library moves (Step 9).
    active: () => setupState() === undefined && links?.relocation.busy !== true,
    testRoot: env.testRoot,
    liveToolHome: env.liveToolHome,
    notify: (notification) => void services.command.notify(notification).catch(() => undefined),
    git,
    lock: (name, fn) => withDeviceLock(deviceServices, name, fn),
    operations,
    gitUrl: () => gitUrl,
    prefix: () => prefix?.service,
    prefixes: {
      context: () => services.query.prefixes({}),
      setLocalPrefix: async (localPrefix) => {
        await services.command.setLocalPrefix({ localPrefix });
      },
      setGitPrefix: async (gitPrefix) => {
        await services.command.setGitPrefix({ gitPrefix });
      },
    },
    relocation: {
      volumes: new NodeVolumes({ platform: env.platform, testRoot: settings.testRoot }),
      journalDir: layout.journal,
      repo: (folder) => {
        const repo = git.repo(folder as AbsPath);
        return {
          state: () => repo.state(),
          status: () => repo.status(),
          // A folder the user picked (S9 [Locate folder…]) isn't the library yet: git answers only what a code repo
          // may be asked (PLAN.md §3.7 rule 4).
          remoteUrl: async () => (await git.codeRepo(folder as AbsPath).remoteUrl()) ?? '',
        };
      },
      clone: async (dest) => {
        if (gitUrl === null) throw new AppError('feature.unavailable', { feature: 'download' });
        await git.clone({ url: gitUrl, dest: dest as AbsPath });
      },
      location: async () => {
        const context = await services.query.locationContext({});
        return {
          platform: env.platform,
          paths,
          home: env.home,
          toolFolders: catalog.tools.flatMap((tool) =>
            [...tool.detect, ...tool.user_skill_dirs].map((dir) => ({
              tool: tool.name,
              path: expandHome(dir, env.home, paths),
            })),
          ),
          libraries: context.libraries,
          repos: context.repos,
        };
      },
      // Step 1 of PLAN.md §3.9: the timers stop and the library isn't watched; the link checks wait (`active`).
      pause: async () => {
        links?.stop();
        if (watchSet.dirs.some((dir) => paths.same(dir, libraryRoot))) await watchSet.remove(libraryRoot);
      },
      useRoot: (root) => {
        libraryPath = root;
      },
      setLibraryPath: async (path) => {
        await services.command.setLibraryPath({ path });
      },
      // Main starts the worker again from device.json, once this command's answer went out.
      restart: () => {
        setTimeout(() => {
          if (!stopping) void services.command.restart({}).catch(() => undefined);
        }, 0);
      },
    },
    onRepos: (repos) => {
      void watchRepos(repos);
      // Main keeps every instance's repo folders: a library folder can't go inside one (PLAN.md §3.9).
      const paths = repos.map((repo) => repo.path).sort();
      if (paths.join('\u0000') === reportedRepos) return;
      reportedRepos = paths.join('\u0000');
      void services.command.reportRepos({ paths }).catch(() => undefined);
    },
  });
  workerLinks.setToolSettings(await services.query.toolSettings({}));
  links = workerLinks;
  // instance.db was lost or damaged (PLAN.md §3.5): restored from a backup, or the connections wait for recovery.
  if (opened.lost) {
    workerLinks.recovery.markLost();
    logger.warn('the database was lost and no backup could replace it: connections wait for recovery');
  } else if (opened.restoredFrom !== null) {
    workerLinks.activity.append([
      {
        kind: 'database-restored',
        path: null,
        details: { damaged: opened.damagedCopy !== null, backup: paths.basename(opened.restoredFrom) },
      },
    ]);
  }
  // A move that was under way when the app stopped (Step 9): its folders are reachable, the links wait for it.
  await workerLinks.relocation.load();
  // The editor (Step 10): the library's files, version history and "What the agent sees".
  const editing = new WorkerEditing({
    engine,
    fs,
    paths,
    logger,
    libraryRoot: () => libraryPath,
    snapshot: () => libraryModel.snapshot ?? null,
    repo: libraryRepo,
    links: workerLinks,
  });

  // Imports (Step 13): skills from a repo, a folder or a zip, each reviewed before [Add]. An import that was under way
  // when the app stopped left its temporary folder: it goes now.
  const workerImports = new WorkerImports({
    engine,
    fs,
    links: fs.links(nodeLinks),
    paths,
    git,
    archive: new ZipArchive(),
    store,
    random,
    clock,
    logger,
    activity: workerLinks.activity,
    trash: workerLinks.trash,
    credentials,
    repo: libraryRepo,
    dataFolder: settings.dataFolder,
    libraryRoot: () => libraryPath,
    snapshot: () => libraryModel.snapshot ?? null,
    skillsChanged: (reason) => workerLinks.check(reason),
    onChange: () => renderer?.server.emit('importChanged', {}),
  });
  imports = workerImports;
  await workerImports.service
    .start()
    .catch((error: unknown) => logger.warn('import leftovers not removed', { error: String(error) }));

  // The git screens (Step 11): changes, fetch, the incoming preview, pull, conflicts, push, branches, stashes, history.
  sync = new WorkerSync({
    engine,
    store,
    fs,
    paths,
    clock,
    logger,
    repo: libraryRepo,
    baseline,
    libraryRoot: () => libraryPath,
    snapshot: () => libraryModel.snapshot ?? null,
    scan: async (source: LibrarySource) => buildSnapshot(await scanLibrary(source), snapshotContext()),
    reload: (emit) => library.reloadNow(emit),
    links: workerLinks,
    appVersion: __APP_VERSION__,
    deviceName: () => facts.deviceName,
    libraryName: () => settings.name,
    notify: (notification) => void services.command.notify(notification).catch(() => undefined),
    onChange: (counts) => {
      renderer?.server.emit('syncChanged', counts);
      void services.command.reportSync(counts).catch(() => undefined);
    },
  });
  const workerSync = sync;
  review = new WorkerReview({
    engine,
    store,
    clock,
    logger,
    activity: workerLinks.activity,
    repo: libraryRepo,
    sync: workerSync.service,
    services: deviceServices,
    keys: new NodeSigningKeys(),
    credentials,
    probe,
    gitUrl: () => gitUrl,
    deviceName: () => facts.deviceName,
    // In its own command, after the one that saw the rejection (PLAN.md §3.11 "When").
    recheckAccess: () =>
      void engine.execute(CheckAccess, {}).catch((error: unknown) => {
        logger.info('access not checked again', { error: String(error) });
      }),
    onChange: () => renderer?.server.emit('reviewChanged', {}),
  });
  const workerReview = review;
  // The prefix lock and the prefix change (Step 14): the pull and the link checks ask it about a new git prefix.
  const workerPrefix = new WorkerPrefix({
    engine,
    store,
    fs,
    paths,
    clock,
    logger,
    operations,
    repo: libraryRepo,
    libraryRoot: () => libraryPath,
    snapshot: () => libraryModel.snapshot ?? null,
    device: {
      context: () => services.query.prefixes({}),
      setLocalPrefix: async (localPrefix) => {
        await services.command.setLocalPrefix({ localPrefix });
      },
      setGitPrefix: async (gitPrefix) => {
        await services.command.setGitPrefix({ gitPrefix });
      },
    },
    links: workerLinks,
    sync: workerSync.service,
    review: workerReview.service,
    reload: (emit) => library.reloadNow(emit),
    appVersion: __APP_VERSION__,
    deviceName: () => facts.deviceName,
    libraryName: () => settings.name,
    notify: (notification) => void services.command.notify(notification).catch(() => undefined),
    onChange: () => renderer?.server.emit('prefixChanged', {}),
  });
  prefix = workerPrefix;

  // The setup wizard's pages after the download (Step 15): every answer is recorded until [Finish] applies them.
  new SetupWizard({
    engine,
    store,
    fs,
    paths,
    clock,
    logger,
    activity: workerLinks.activity,
    links: workerLinks.service,
    placement: workerLinks.placement,
    instructions: workerLinks.instructions,
    repo: libraryRepo,
    libraryRoot: () => libraryPath,
    snapshot: () => libraryModel.snapshot ?? null,
    libraryName: () => settings.name,
    gitUrl: () => gitUrl,
    clientId: () => {
      const account = store.read((tx) => tx.hostAccount.get());
      return account?.selfHosted && account.method === 'device' ? account.clientId : null;
    },
    instructionsLinked: async () => {
      const answer = await services.query.instructionsLinked({});
      return { linked: answer.linked, linkedBy: answer.linkedBy ?? null };
    },
    reload: (emit) => library.reloadNow(emit),
    // From [Finish] on, links and instruction files may change (IMPLEMENTATION.md §2.1).
    finished: async (emit) => {
      await workerLinks.instructions.checkNow(emit);
      workerLinks.check('setup finished');
    },
  });

  engine.handle(DeviceOperationStep, async ({ operationId, kind, step }) => {
    if (kind === REMOVE_INSTANCE && step === REMOVE_FILES_STEP) {
      // Everything the app makes outside the library goes through a reconciler (§2.5): removing the instance is a
      // reconcile to an empty desired state. Steps 6–8 add their reconcilers here.
      access.stop();
      workerLinks.stop();
      const removed = await workerLinks.removeAll();
      logger.info('removing the instance: its links are gone', { steps: removed });
      return;
    }
    if (hooks && (await hooks.runTestDeviceStep({ fs, paths, dataFolder: settings.dataFolder }, kind, operationId)))
      return;
    throw new AppError('operation.unknown', { kind });
  });

  // The automatic backups of instance.db (PLAN.md §3.5): one a day, the newest three kept.
  const backups = new Scheduler(clock);
  const backup = () => {
    if (stopping || !backupDue(backupsDir, clock.now())) return;
    try {
      const file = backupInstanceDatabase(store, backupsDir, clock.now());
      logger.info('database backed up', { file: paths.basename(file) });
    } catch (error) {
      logger.warn('the database backup failed', { error: String(error) });
    }
  };

  main.serve(workerApi, {
    queries: {
      ping: async ({ seq }) => {
        await faults.hit('worker:ping');
        return { seq, busy: engine.status.running !== null, queued: engine.status.queued };
      },
      doctorReport: async () => (links ? await links.doctorReport() : null),
    },
    commands: {
      shutdown: () => {
        if (!stopping) {
          stopping = true;
          access.stop();
          links?.stop();
          sync?.service.stop();
          backups.stopAll();
          setTimeout(() => {
            void Promise.all([watchSet.close(), repoWatch.close()])
              .catch(() => undefined)
              .then(() => engine.stop())
              .finally(() => {
                store.close();
                logger.info('worker stopped');
                host.exit(0);
              });
          }, 10);
        }
        return {};
      },
      readAsset: ({ path }) => readAsset({ fs, paths, libraryPath: settings.libraryPath }, path),
      runDeviceOperationStep: async ({ operationId, kind, step }) => {
        await engine.execute(DeviceOperationStep, { operationId, kind, step });
        return {};
      },
      finishSetup: async ({ planHash }) => {
        await engine.execute(FinishSetup, { planHash });
        return {};
      },
      changeUrl: async ({ url }) => {
        await engine.execute(ChangeUrl, { url });
        return {};
      },
    },
  });
  if (hooks && armed) {
    main.serve(
      hooks.workerTestApi,
      hooks.workerTestHandlers({
        services: deviceServices,
        engine,
        store,
        operations,
        faults: armed,
        audit,
        status,
        fs,
        paths,
        random,
        watchSet,
        clock,
        library: () => libraryModel.snapshot ?? null,
        git: () => engine.query(LibraryGitQuery, {}),
        gitRuns,
        testRoot: env.testRoot,
        backup: () => backupInstanceDatabase(store, backupsDir, clock.now()),
        checkAccess: async () => {
          await engine.execute(CheckAccess, {});
        },
      }),
    );
  }

  services.on('clock', ({ offsetMs }) => clock.setOffset(offsetMs));
  services.on('network', ({ online }) => {
    logger.info('network changed', { online });
    workerSync.service.setOnline(online);
  });
  services.on('power', ({ state }) => {
    logger.info('power changed', { state });
    // After a sleep (Step 17, A17.3): timers didn't run and the disk or the server may have changed, so one link check
    // and one fetch run. Each joins a run of its kind that waits, so a wake never starts the same work twice.
    if (state === 'resume') {
      workerLinks.check('wake');
      workerSync.service.fetch('wake');
    }
  });
  services.on('focus', ({ focused }) => {
    logger.debug('window focus changed', { focused });
    if (focused) {
      workerLinks.check('focus');
      workerSync.service.fetch('focus');
    }
  });
  services.on('instructionsChanged', () => {
    void services.query
      .instructionsLinked({})
      .then(({ linked }) => {
        instructionsLinked = linked;
        workerLinks.checkInstructions('linking changed');
      })
      .catch((error: unknown) => logger.warn('linked instructions not read', { error: String(error) }));
  });
  services.on('toolSettingsChanged', () => {
    void services.query
      .toolSettings({})
      .then((tools) => {
        workerLinks.setToolSettings(tools);
        workerLinks.check('tool settings');
        renderer?.server.emit('linksChanged', { attention: workerLinks.service.attention().length });
      })
      .catch((error: unknown) => logger.warn('tool settings not read', { error: String(error) }));
  });

  // This instance's local prefix, from main's device.json (Step 8): the links' names follow it from the first check.
  await workerLinks.projection.load();

  // The renderer's port: the instance API. A new port replaces the old one after a reload.
  const linkHandlers = workerLinks.handlers();
  const editorHandlers = editing.handlers();
  const syncHandlers = workerSync.handlers();
  const reviewHandlers = workerReview.handlers();
  const importHandlers = workerImports.handlers();
  const prefixHandlers = workerPrefix.handlers();
  onRendererPort = (port) => {
    renderer?.endpoint.dispose('rpc.disconnected');
    const endpoint = new RpcEndpoint(port, {
      onError: (report) =>
        logger.warn('renderer port: message rejected', { code: report.code, message: report.message }),
    });
    const server = endpoint.serve(instanceApi, {
      queries: {
        status: () => engine.query(StatusQuery, {}),
        librarySnapshot: async () => libraryView(await engine.query(LibrarySnapshotQuery, {})),
        libraryGit: () => engine.query(LibraryGitQuery, {}),
        access: () => accessView(access.snapshot()),
        setupWizard: async () => view(await engine.query(SetupWizardQuery, {})),
        setupSummary: async () => view(await engine.query(SetupSummaryQuery, {})),
        removalCheck: async () => {
          try {
            const current = await libraryRepo.status();
            return { unpushedCommits: current.ahead, changedFiles: current.entries.length };
          } catch {
            return { unpushedCommits: 0, changedFiles: 0 };
          }
        },
        ...linkHandlers.queries,
        ...editorHandlers.queries,
        ...syncHandlers.queries,
        ...reviewHandlers.queries,
        ...importHandlers.queries,
        ...prefixHandlers.queries,
      },
      commands: {
        checkAccess: async () => accessView(await engine.execute(CheckAccess, {})),
        signInAgain: async (input, context) =>
          accessView(
            await engine.execute(
              SignInAgain,
              {
                input,
                onCode: (code) => context.progress({ userCode: code.userCode, verificationUri: code.verificationUri }),
              },
              { signal: context.signal },
            ),
          ),
        setupGo: async ({ page }) => {
          await engine.execute(SetupGo, { page });
          return {};
        },
        setupChooseTools: async ({ enabled }) => {
          await engine.execute(SetupChooseTools, { enabled });
          return {};
        },
        setupTickTag: async (input) => {
          await engine.execute(SetupTickTag, input);
          return {};
        },
        setupAnswerName: async (input) => {
          await engine.execute(SetupAnswerName, input);
          return {};
        },
        setupSetSkillTags: async (input) => {
          await engine.execute(SetupSetSkillTags, input);
          return {};
        },
        setupSetLibraryTags: async (input) => {
          await engine.execute(SetupSetLibraryTags, input);
          return {};
        },
        ...linkHandlers.commands,
        ...editorHandlers.commands,
        ...syncHandlers.commands,
        ...reviewHandlers.commands,
        ...importHandlers.commands,
        ...prefixHandlers.commands,
      },
    });
    renderer = { endpoint, server };
  };
  for (const port of rendererPorts.splice(0)) onRendererPort(port);
  engine.events.subscribe((event) => {
    if (event.type === 'CommandStarted' || event.type === 'CommandProgressed' || event.type === 'CommandFinished') {
      renderer?.server.emit('statusChanged', status());
    }
    if (event.type === 'LibraryChanged') {
      renderer?.server.emit('libraryChanged', {});
      workerLinks.check('library changed');
    }
    if (event.type === 'InstructionsChanged') renderer?.server.emit('instructionsChanged', {});
    if (event.type === 'SetupChanged') renderer?.server.emit('setupChanged', {});
    // Tools enabled or disabled: the instructions follow them (PLAN.md §3.12).
    const finished = event as { type: string; command?: string; ok?: boolean };
    if (finished.type === 'CommandFinished' && finished.command === 'SetTools' && finished.ok === true) {
      workerLinks.checkInstructions('tools changed');
    }
    if (event.type === 'LinksChanged') {
      const attention = (event as LinksChanged).attention;
      renderer?.server.emit('linksChanged', { attention });
      void services.command.reportAttention({ count: attention }).catch(() => undefined);
    }
  });

  // The library folder, and git's HEAD and refs in it; git's object store and logs change on every git command and say
  // nothing the snapshot needs.
  try {
    await watchSet.add(libraryRoot, { ignore: ['.git/objects/**', '.git/logs/**', '.git/lfs/**'] });
  } catch (error) {
    logger.warn('the library folder can not be watched', { error: String(error) });
  }
  try {
    await fs.mkdirp(projectionRoot as AbsPath);
    await watchSet.add(projectionRoot as AbsPath);
  } catch (error) {
    logger.warn('the projected copies can not be watched', { error: String(error) });
  }

  await services.command.reportLifecycle({ state: 'ready', error: null });
  logger.info('worker ready', { library: settings.libraryPath });
  // The role at every start (PLAN.md §3.11 "When"): a changed permission or a lost access shows without a sign-in.
  engine
    .execute(CheckAccess, {})
    .catch((error: unknown) => logger.warn('access check failed', { error: String(error) }));
  // The first scan runs after "ready", as a command: queries see the library loading until it finishes. The first
  // health check follows it (PLAN.md §3.8 "When": at app start).
  library
    .start()
    .catch((error: unknown) => logger.warn('library scan failed', { error: String(error) }))
    // Unfinished operations resume at start (IMPLEMENTATION.md §2.6), once the library is read: their steps reconcile
    // the links to it.
    .then(() => engine.execute(ResumeOperations, {}))
    .then(async (resumed) => {
      if (resumed > 0) logger.info('operations resumed', { count: resumed });
      await workerLinks.relocation.afterResume();
    })
    .catch((error: unknown) => {
      if (!stopping) logger.warn('operations not resumed', { error: String(error) });
    })
    .finally(() => {
      // A worker asked to stop meanwhile has closed its database: nothing more starts.
      if (stopping) return;
      workerLinks.check('start');
      workerLinks.start();
      // The fetch at start, then every 3 minutes (PLAN.md §3.10); offline at start shows at once.
      if (!facts.online) workerSync.service.setOnline(false);
      workerSync.service.start();
      backup();
      backups.every(BACKUP_CHECK_MS, backup);
    });
}

/** How often the worker looks whether the daily backup is due (PLAN.md §3.5). */
const BACKUP_CHECK_MS = 60 * 60 * 1000;
