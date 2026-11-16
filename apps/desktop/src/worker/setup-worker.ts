// A setup's pending worker (IMPLEMENTATION.md §2.1, Step 4): the same utility process as an instance's worker, but
// without a data folder or a database. It keeps the setup in memory, logs to the device-level log folder, and writes
// only into the temporary download folder main recorded for it. It serves the worker API (so the supervisor can ping
// and stop it) and the setup API, which main forwards the wizard's calls to.
import {
  CatalogLoader,
  createFileLogger,
  DugiteGit,
  GIT_VARIABLES,
  gitBaseEnv,
  type GitRunRecord,
  GuardedFileSystem,
  NodeFileSystem,
  NodeHostProbe,
  NodeHttpClient,
  nodeEnv,
  nodeRandom,
  NodeVolumes,
  OffsetClock,
  sweepLeftoverKeys,
  testSshOptions,
} from '@app/adapters';
import { brand } from '@app/brand';
import {
  type AbsPath,
  AppError,
  expandHome,
  HostCredentials,
  isAppError,
  parseGitUrl,
  type Random,
  resolveTools,
  SetupSession,
  type SetupSnapshot,
} from '@app/core';
import { deviceServicesApi, RpcEndpoint, type RpcPort, type SetupView, setupWorkerApi, workerApi } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { bundledCatalog, trustedCatalogKeys } from '@app/tools';
import type { PendingSetupInit, WorkerInit } from '../main/supervisor.ts';
import { liveToolHomeOf } from '../shared/live.ts';
import { testClientIdOf } from '../shared/test-client-id.ts';
import { networkFor, remoteDeviceServices } from './device-services.ts';
import type { WorkerHost } from './host.ts';
import type * as TestHooks from './test-hooks.ts';

function errorView(error: unknown): ErrorView {
  return isAppError(error) ? { code: error.code, params: error.params } : { code: 'internal', params: {} };
}

/**
 * The app's own client id for github.com or gitlab.com; self-hosted servers need theirs typed in. A test-hooks build
 * can be given an id by a test (`testClientIdOf`), until the real ones are registered.
 */
export function builtInClientId(
  kind: 'github' | 'gitlab' | 'plain',
  selfHosted: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (selfHosted || kind === 'plain') return null;
  return testClientIdOf(env, kind) ?? (kind === 'github' ? brand.githubAppClientId : brand.gitlabClientId);
}

export function setupView(snapshot: SetupSnapshot): SetupView {
  return {
    ...snapshot,
    methods: [...snapshot.methods],
    deviceCode: null,
    signedIn: snapshot.signedIn && { ...snapshot.signedIn },
    folder: snapshot.folder && {
      path: snapshot.folder.path,
      problems: snapshot.folder.problems.map(({ code, ...params }) => ({ code, params })),
      warnings: snapshot.folder.warnings.map(({ code, ...params }) => ({ code, params })),
    },
    localPrefix: snapshot.localPrefix && {
      ...snapshot.localPrefix,
      check: snapshot.localPrefix.check && {
        ...snapshot.localPrefix.check,
        tooLong: [...snapshot.localPrefix.check.tooLong],
      },
      folders: [...snapshot.localPrefix.folders],
      folderChoices: snapshot.localPrefix.folderChoices && snapshot.localPrefix.folderChoices.map((c) => ({ ...c })),
    },
    error: snapshot.error && errorView(new AppError(snapshot.error.code as ErrorView['code'], snapshot.error.params)),
    instanceId: null,
  };
}

export async function runSetupWorker(
  host: WorkerHost,
  settings: WorkerInit & { readonly setup: PendingSetupInit },
  mainPort: RpcPort,
  hooks: typeof TestHooks | undefined,
): Promise<void> {
  const setup = settings.setup;
  const liveToolHome = liveToolHomeOf(process.env, settings.testRoot);
  const env = nodeEnv({
    allow: GIT_VARIABLES,
    ...(settings.testRoot === undefined ? {} : { testRoot: settings.testRoot }),
    ...(liveToolHome === undefined ? {} : { liveToolHome }),
  });
  const { paths } = env;
  const clock = new OffsetClock(settings.clockOffsetMs);
  const random: Random =
    hooks && settings.randomSeed !== undefined
      ? new hooks.SeededRandom(hooks.seedFrom(`${settings.randomSeed}:${setup.id}:${settings.generation ?? 0}`))
      : nodeRandom;
  // What the worker may touch grows as main hands it folders: the one to check, then the download (§2.10).
  // The default location (~/<brand.defaultLibraryFolderName>) may be looked at, for the default folder's number (PLAN.md §3.16).
  const readRoots = new Set<string>([
    setup.tmpDir,
    settings.catalogDir,
    paths.join(env.home, brand.defaultLibraryFolderName),
  ]);
  const downloadRoots = new Set<string>();
  // The tools' skills folders: only the names in them are listed, to find a prefix in use (PLAN.md §3.3 "Detection").
  let skillFolders: string[] = [];
  const fs = new GuardedFileSystem({
    inner: new NodeFileSystem(),
    paths,
    roots: () => ({
      write: [setup.tmpDir, ...downloadRoots],
      read: [...readRoots, ...downloadRoots],
      removeTree: [setup.tmpDir, ...downloadRoots],
      exact: skillFolders,
      lists: skillFolders,
    }),
    ...(env.testRoot === undefined ? {} : { testRoot: env.testRoot }),
    ...(env.liveToolHome === undefined ? {} : { liveToolHome: env.liveToolHome }),
  });
  await fs.mkdirp(setup.tmpDir as AbsPath);
  const logger = createFileLogger({
    file: setup.logFile,
    clock,
    level: settings.testHooks ? 'debug' : 'info',
  }).child({ setup: setup.id });

  const main = new RpcEndpoint(mainPort, {
    onError: (report) => logger.warn('port to main: message rejected', { code: report.code, message: report.message }),
  });
  const services = main.connect(deviceServicesApi);
  await services.command.reportLifecycle({ state: 'starting', error: null });
  const deviceServices = remoteDeviceServices(services);
  const network = networkFor(services);
  const http = new NodeHttpClient({ network, requireProxy: settings.testRoot !== undefined });
  const probe = new NodeHostProbe(http, () => clock.now());
  const credentials = new HostCredentials({ services: deviceServices, clock, logger, host: (e) => probe.host(e) });
  const leftoverKeys = await sweepLeftoverKeys(setup.tmpDir);
  if (leftoverKeys > 0) logger.info('removed leftover SSH key files', { count: leftoverKeys });
  const gitRuns: GitRunRecord[] = [];
  const git = new DugiteGit({
    paths,
    platform: env.platform,
    baseEnv: gitBaseEnv(env),
    clock,
    logger,
    libraryRoots: () => [...downloadRoots],
    neutralDir: setup.tmpDir as AbsPath,
    keyDir: setup.tmpDir as AbsPath,
    credentials: (url) => credentials.gitAuth(url),
    network,
    sshOptions: testSshOptions(env),
    ...(hooks ? { onRun: (run: GitRunRecord) => void (gitRuns.push(run) > 500 && gitRuns.shift()) } : {}),
  });
  const catalog = await new CatalogLoader({
    fs,
    bundled: bundledCatalog,
    file: paths.join(settings.catalogDir, 'catalog.json') as AbsPath,
    signatureFile: paths.join(settings.catalogDir, 'catalog.json.sig') as AbsPath,
    keys: trustedCatalogKeys({ development: settings.testHooks }),
    logger,
  }).load();
  // Every tool's skills folders, enabled or not, with the device's custom tools and changed folders (PLAN.md §3.3).
  const toolSettings = await services.query.toolSettings({});
  skillFolders = resolveTools(
    catalog,
    env.home,
    { customTools: toolSettings.customTools, toolFolders: toolSettings.toolFolders, homeEnv: toolSettings.homeEnv },
    paths,
  )
    .flatMap((tool) => tool.skillDirs)
    .filter(
      (dir) =>
        settings.testRoot === undefined ||
        paths.isInside(settings.testRoot, dir) ||
        (env.liveToolHome !== undefined && paths.same(dir, paths.join(env.liveToolHome, 'skills'))),
    );
  const toolFolders = catalog.tools.flatMap((tool) =>
    [...tool.detect, ...tool.user_skill_dirs].map((dir) => ({
      tool: tool.name,
      path: expandHome(dir, env.home, paths),
    })),
  );

  const parsed = parseGitUrl(setup.url);
  if (!parsed.ok) throw new AppError('setup.urlInvalid', { problem: parsed.error });
  let server: ReturnType<typeof main.serve<typeof setupWorkerApi>> | undefined;
  const session = new SetupSession({
    id: setup.id,
    intent: setup.intent,
    url: parsed.value,
    git,
    probe,
    credentials,
    services: deviceServices,
    fs,
    volumes: new NodeVolumes({ platform: env.platform, testRoot: settings.testRoot }),
    clock,
    random,
    logger,
    paths,
    platform: env.platform,
    home: env.home,
    appVersion: __APP_VERSION__,
    connected: () => setup.connected,
    repos: () => setup.repos ?? [],
    toolFolders,
    skillFolders: () => skillFolders,
    inviteClientId: setup.clientId ?? null,
    builtInClientId: (endpoint) => builtInClientId(endpoint.kind, endpoint.selfHosted),
    onChange: (snapshot) => server?.emit('changed', setupView(snapshot)),
  });

  let stopping = false;
  const refuse = () => {
    throw new AppError('setup.wrongStep', { step: 'pending' });
  };
  main.serve(workerApi, {
    queries: { ping: ({ seq }) => ({ seq, busy: false, queued: 0 }), doctorReport: () => null },
    commands: {
      shutdown: () => {
        if (!stopping) {
          stopping = true;
          setTimeout(() => {
            logger.info('setup worker stopped');
            host.exit(0);
          }, 10);
        }
        return {};
      },
      readAsset: refuse,
      runDeviceOperationStep: refuse,
      finishSetup: refuse,
      changeUrl: refuse,
    },
  });
  server = main.serve(setupWorkerApi, {
    queries: {
      view: () => setupView(session.snapshot()),
      result: () => session.result(),
    },
    commands: {
      start: async () => setupView(await session.start()),
      signIn: async (input, context) =>
        setupView(
          await session.signIn(input, {
            signal: context.signal,
            onCode: (code) => context.progress({ userCode: code.userCode, verificationUri: code.verificationUri }),
          }),
        ),
      setIdentity: async ({ identity }) => setupView(await session.setIdentity(identity)),
      checkFolder: async ({ path }) => {
        readRoots.add(path);
        return setupView(await session.checkFolder(path));
      },
      download: async ({ libraryPath, downloadPath }, context) => {
        readRoots.add(libraryPath);
        downloadRoots.add(downloadPath);
        const outcome = await session.download(
          { libraryPath, downloadPath },
          {
            signal: context.signal,
            onProgress: (progress) => context.progress({ phase: progress.phase, percent: progress.percent }),
          },
        );
        return { kind: outcome.kind };
      },
      createLibrary: async ({ prefix }) => ({ kind: (await session.createLibrary(prefix)).kind }),
      joinInstead: async (_input, context) => ({ kind: (await session.joinInstead(context.signal)).kind }),
      checkLocalPrefix: async ({ prefix }) => setupView(await session.checkLocalPrefix(prefix)),
      chooseLocalPrefix: async ({ prefix }) => ({ kind: (await session.chooseLocalPrefix(prefix)).kind }),
      chooseFolders: async ({ choices }) => ({ kind: (await session.chooseFolders(choices)).kind }),
    },
  });
  await services.command.reportLifecycle({ state: 'ready', error: null });
  logger.info('setup worker ready', { intent: setup.intent, host: parsed.value.host });
}
