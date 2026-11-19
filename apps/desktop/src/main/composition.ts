// Main's composition root (IMPLEMENTATION.md §2.3): every device-level service is built and wired here, by
// constructor, with no global state. Test hooks are added only in test-hooks builds (`__TEST_HOOKS__`).
import {
  caBundle,
  createFileLogger,
  GuardedFileSystem,
  hostName,
  NodeFileSystem,
  nodeRandom,
  OffsetClock,
  NodeProcessRunner,
} from '@app/adapters';
import type { AuditEntry } from '@app/adapters';
import { brand } from '@app/brand';
import {
  type AbsPath,
  AppError,
  type DataLayout,
  DeviceOperationRunner,
  DeviceRegistry,
  type Env,
  type FaultPoints,
  type Logger,
  noFaults,
  PROXY_VARIABLES,
  type Random,
  readLoginShellEnv,
  Scheduler,
} from '@app/core';
import {
  type AppInfo,
  type Client,
  deviceApi,
  invokeLocal,
  type DeviceFacts,
  deviceServicesApi,
  type DeviceServicesApi,
  type InstanceView,
  type Server,
  type WindowMode,
} from '@app/ipc';
import type { WorkerTestApi } from '@app/ipc/test-api';
import type * as TestHooks from './test-hooks/index.ts';
import { homeEnvVariables, bundledCatalog } from '@app/tools';
import { app, type BrowserWindow, ipcMain, nativeTheme, net, session } from 'electron';
import path from 'node:path';
import { PACKAGED_CSP } from '../shared/csp.ts';
import { HELLO_CHANNEL, PORT_CHANNEL } from '../shared/ports-protocol.ts';
import { parseAssetUrl } from './asset-requests.ts';
import { pickedFileReader } from './picked-files.ts';
import type { MainConfig } from './config.ts';
import { deviceApiHandlers, settingsView } from './device-api.ts';
import { DiagnosticsService } from './diagnostics.ts';
import { translate } from '../shared/i18n.ts';
import { deviceServicesHandlers } from './device-services.ts';
import { messageChannel, utilityProcessLauncher } from './electron/launcher.ts';
import { electronOs } from './electron/os-integrations.ts';
import { MAX_RELEASE_FILE_BYTES, releaseFeed } from './release-feed.ts';
import { feedFileName } from './update-feed.ts';
import { UpdateService } from './updates.ts';
import { certificateViews } from './certificates.ts';
import { APP_ORIGIN, serveAssets, serveRenderer } from './electron/protocols.ts';
import { safeStorageCodec } from './electron/secret-codec.ts';
import { removeEverythingOperation } from './remove-everything.ts';
import { removeInstanceOperation } from './remove-instance.ts';
import { isSetupId, SetupManager } from './setups.ts';
import { hardenSession, hardenWebContents, routeThroughProxy } from './electron/security.ts';
import { watchSystem } from './electron/system-events.ts';
import { createWindow, sizeWindow } from './electron/window.ts';
import { InstanceManager } from './instances.ts';
import { LockService } from './locks.ts';
import { OPENED_AT_LOGIN_ARG, type OsIntegrations } from './os/integrations.ts';
import type { RecordingOs } from './os/recording.ts';
import { PortBroker } from './port-broker.ts';
import { PlainCodec, plainCodec, SecretsService } from './secrets.ts';
import { WorkerSupervisor } from './supervisor.ts';
import { ToolCommandService } from './tool-commands.ts';
import { ToolSettingsService } from './tool-settings.ts';
import { trayMenu } from './tray-model.ts';
import { InviteInbox, linkInArgs } from './invites.ts';
import { appImagePath, registerAppImageLinks, setLinuxAutostart } from './os/desktop-entry.ts';
import { onOpenUrl } from './electron/open-url.ts';

export interface StartOptions {
  readonly config: MainConfig;
  readonly env: Env;
  readonly layout: DataLayout;
  /** The folder of the main bundle (out/main). */
  readonly outDir: string;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startMain(options: StartOptions): Promise<void> {
  const { config, env, layout } = options;
  // Test hooks exist only in test-hooks builds: in production builds this import is removed at build time.
  let hooks: typeof TestHooks | undefined;
  if (__TEST_HOOKS__) hooks = await import('./test-hooks/index.ts');
  const testMode = hooks !== undefined && config.testRoot !== undefined;
  const testHooks = hooks !== undefined;
  // The session first, before anything uses it; in test mode all traffic goes through the recording proxy from here.
  hardenSession();
  if (config.testProxy) await routeThroughProxy(config.testProxy);

  // Time, logging, files; randomness once the data folder is there.
  const clock = hooks && testMode ? OffsetClock.startingAt(hooks.TEST_CLOCK_START) : new OffsetClock(0);
  const logger: Logger = createFileLogger({
    file: env.paths.join(layout.logs, 'main.log'),
    clock,
    level: testHooks ? 'debug' : 'info',
    echo: config.devBuild,
  });
  logger.info('starting', { version: __APP_VERSION__, variant: config.variant, testMode, platform: env.platform });
  const audit: AuditEntry[] = [];
  let instances: InstanceManager | undefined;
  let setups: SetupManager | undefined;
  // Files the user picked for the editor (PLAN.md §3.7): main may read each, and nothing else beside them.
  const pickedFiles: string[] = [];
  // Files the user chose to save diagnostics to (Step 16): main may write each.
  const savedFiles: string[] = [];
  const fs = new GuardedFileSystem({
    inner: new NodeFileSystem(),
    paths: env.paths,
    // Main writes its data folder, and for setups in progress their downloads and where they go (Step 4).
    roots: () => ({
      write: [layout.root, ...savedFiles, ...(setups?.roots.write ?? [])],
      read: [layout.root, ...(instances?.pickedFolders ?? []), ...pickedFiles, ...(setups?.roots.write ?? [])],
      removeTree: [layout.root, ...(setups?.roots.removeTree ?? [])],
    }),
    ...(env.testRoot === undefined
      ? {}
      : { testRoot: env.testRoot, audit: (entry: AuditEntry) => void audit.push(entry) }),
  });
  const readPickedFile = pickedFileReader(fs);
  const readPicked = (path: string, max: number) => {
    if (!pickedFiles.includes(path)) pickedFiles.push(path);
    return readPickedFile(path, max);
  };
  await fs.mkdirp(layout.root);

  // Test mode: deterministic randomness, with a new seed for each launch in the same test root (TESTING.md §1).
  let random: Random = nodeRandom;
  let randomSeed: number | undefined;
  if (hooks && testMode) {
    const seedFile = env.paths.join(layout.root, 'test-random-seed') as AbsPath;
    const launch = (await fs.lstat(seedFile)) ? Number(await fs.readText(seedFile)) + 1 : 1;
    await fs.writeTextAtomic(seedFile, String(launch));
    randomSeed = hooks.seedFrom(`launch:${launch}`);
    random = new hooks.SeededRandom(randomSeed);
  }

  // device.json: the device registry.
  const registry = new DeviceRegistry({
    fs,
    file: layout.deviceFile,
    clock,
    random,
    logger,
    deviceName: testMode ? 'test-device' : hostName(),
  });
  const registryState = await registry.load();
  logger.info('device.json loaded', { state: registryState });

  // Fault points and OS integrations: armed and recording in test builds.
  const armedFaults = hooks
    ? new hooks.ArmedFaults({ crash: () => process.kill(process.pid, 'SIGKILL'), wait })
    : undefined;
  const faults: FaultPoints = armedFaults ?? noFaults;
  // From an AppImage the app writes its own link handler: only into the user's applications folder (Step 15).
  const appImage = env.platform === 'linux' && !testMode ? appImagePath({ APPIMAGE: env.variable('APPIMAGE') }) : null;
  const dataHome = env.variable('XDG_DATA_HOME') ?? env.paths.join(env.home, '.local', 'share');
  const applications = env.paths.join(dataHome, 'applications');
  // Where updates come from (release-feed.ts, Step 18).
  const feed = releaseFeed({
    buildUrl: __RELEASE_URL__,
    repository: brand.releaseRepository,
    testUrl: testMode ? config.releaseUrl : undefined,
    testHooks,
  });
  const recordingOs: RecordingOs | undefined =
    hooks && testMode
      ? new hooks.RecordingOs({
          openedAtLogin: process.argv.includes(OPENED_AT_LOGIN_ARG),
          trayAvailable: !config.noTray,
        })
      : undefined;
  const platformOs: OsIntegrations =
    recordingOs ??
    electronOs({
      trayIcon: path.join(options.outDir, '../../resources/trayTemplate.png'),
      ...(appImage === null
        ? {}
        : {
            appImageLinks: (scheme: string) =>
              void registerAppImageLinks({
                fs: new GuardedFileSystem({
                  inner: new NodeFileSystem(),
                  paths: env.paths,
                  roots: () => ({ write: [applications], read: [applications], removeTree: [] }),
                }),
                process: new NodeProcessRunner(),
                paths: env.paths,
                dataHome,
                appImage,
                scheme,
                logger,
              }),
          }),
    });
  // Launch at login on Linux is the XDG autostart entry, which the app writes itself (Step 17). In test mode the config
  // folder is inside the test root, so tests read the entry that was written.
  const configHome = env.variable('XDG_CONFIG_HOME') ?? env.paths.join(env.home, '.config');
  const autostart = env.paths.join(configHome, 'autostart');
  const os: OsIntegrations =
    env.platform === 'linux'
      ? {
          ...platformOs,
          loginItem: {
            set: (on) => {
              platformOs.loginItem.set(on);
              void setLinuxAutostart({
                fs: new GuardedFileSystem({
                  inner: new NodeFileSystem(),
                  paths: env.paths,
                  roots: () => ({ write: [autostart], read: [autostart], removeTree: [] }),
                }),
                paths: env.paths,
                configHome,
                program: appImage ?? process.execPath,
                on,
                logger,
              });
            },
            openedAtLogin: () => platformOs.loginItem.openedAtLogin(),
          },
        }
      : platformOs;

  // Device services.
  const locks = new LockService(random);
  const secretCodec = testMode ? plainCodec : safeStorageCodec;
  const secrets = new SecretsService({ fs, file: layout.secrets, codec: secretCodec });
  let online = true;
  let shellEnv: Record<string, string> = {};
  const writeCaBundle = async () => {
    if (!registry.usable) return;
    // Tests use only the extra certificates, never the machine's trust store (TESTING.md §3).
    // Live tests (ADR 0033) talk to github.com, so they also trust the public roots, and still not the machine's own store.
    const pem = caBundle({
      includeSystem: !testMode,
      includePublicRoots: config.liveToolHome !== undefined,
      extra: registry.file.settings.extraCertificates,
    });
    await fs.writeTextAtomic(layout.caBundle, pem);
  };
  await writeCaBundle();
  const facts = (): DeviceFacts => ({
    deviceId: registry.usable ? registry.file.deviceId : 'unknown',
    deviceName: registry.usable ? registry.file.deviceName : 'unknown',
    online,
    caBundlePath: registry.usable ? layout.caBundle : null,
    secretStorage: secrets.storage,
  });
  const proxyFor = async (url: string): Promise<string | null> => {
    if (testMode) return config.testProxy ?? null;
    const resolved = await session.defaultSession.resolveProxy(url);
    const match = /PROXY ([^;\s]+)/.exec(resolved);
    if (match?.[1]) return `http://${match[1]}`;
    const fromShell = url.startsWith('https:')
      ? (shellEnv.https_proxy ?? shellEnv.HTTPS_PROXY)
      : (shellEnv.http_proxy ?? shellEnv.HTTP_PROXY);
    return fromShell ?? null;
  };

  // Tool settings kept once per device (PLAN.md §3.4). The tools' home_env variables come from the app's environment,
  // and from the login shell outside test mode (an app started from the Dock doesn't see a shell profile's).
  const homeEnvNames = homeEnvVariables(bundledCatalog);
  const toolSettings = new ToolSettingsService({
    registry,
    catalog: bundledCatalog,
    paths: env.paths,
    logger,
    homeEnv: () => {
      const vars: Record<string, string> = {};
      for (const name of homeEnvNames) {
        const value = shellEnv[name] ?? process.env[name];
        if (value) vars[name] = value;
      }
      return vars;
    },
    onChange: (view) => {
      broadcast('toolSettingsChanged', {});
      broker?.device?.emit('toolSettingsChanged', view);
    },
  });

  const scriptedTools = hooks && testMode ? new hooks.ScriptedTools() : undefined;
  // The tools' version and list commands for the Doctor (PLAN.md §3.4): scripted in test mode, where nothing real runs
  // (TESTING.md §3). The catalog is the one the app ships with (ADR 0037).
  const toolCommands = new ToolCommandService({
    catalog: async () => bundledCatalog,
    registry,
    process: scriptedTools ?? new NodeProcessRunner(),
    env: () => {
      const vars: Record<string, string> = {};
      for (const name of ['PATH', 'HOME', 'USERPROFILE', 'LANG']) {
        const value = shellEnv[name] ?? process.env[name];
        if (value) vars[name] = value;
      }
      return vars;
    },
    clock,
    logger,
  });

  // Workers.
  const servicesServers = new Map<string, Server<DeviceServicesApi>>();
  const workerTestClients = new Map<string, Client<WorkerTestApi>>();
  const workerTestApi = hooks?.workerTestApi;
  const workerEnv = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  let broker: PortBroker | undefined;
  const supervisor: WorkerSupervisor = new WorkerSupervisor({
    launcher: utilityProcessLauncher({
      entry: path.join(options.outDir, 'worker.cjs'),
      env: workerEnv,
      onOutput: (instanceId, line) => logger.debug('worker output', { instance: instanceId, line }),
    }),
    clock,
    logger,
    faults,
    // A worker that starts again gets the instance's settings as they are now, not those of its first start.
    refreshInit: (init) => instances?.refreshInit(init) ?? init,
    onChange: (instanceId) => {
      void instances
        ?.onWorkerChange(instanceId)
        .catch((error: unknown) => logger.error('instance update failed', { error: String(error) }));
      const worker = supervisor.get(instanceId);
      // A setup's pending worker talks to main only; the renderer reaches it through the device API.
      if (worker?.state === 'running' && !isSetupId(instanceId)) broker?.connectInstance(instanceId, worker.generation);
    },
    onExit: (instanceId) => {
      locks.releaseAll(instanceId);
      servicesServers.delete(instanceId);
      workerTestClients.delete(instanceId);
    },
    onConnect: (instanceId, endpoint) => {
      const server = endpoint.serve(
        deviceServicesApi,
        deviceServicesHandlers(
          {
            supervisor,
            locks,
            secrets,
            os,
            logger,
            facts,
            proxyFor,
            toolSettings: () => toolSettings.forWorker(),
            notificationSettings: () =>
              registry.usable ? registry.file.settings.notifications : { off: [], doNotDisturb: false },
            instructionsLinked: (id) => instances?.records().find((r) => r.id === id)?.instructionsLinked ?? false,
            instructionsLinkedBy: (id) =>
              instances?.records().find((r) => r.id !== id && r.instructionsLinked)?.name ?? null,
            prefixes: (id) => instances?.prefixes(id) ?? { localPrefix: null, instances: [] },
            setLocalPrefix: async (id, prefix) => {
              if (!instances) throw new AppError('device.newerData');
              await instances.setLocalPrefix(id, prefix);
            },
            setGitPrefix: async (id, prefix) => {
              if (!instances) throw new AppError('device.newerData');
              await instances.setGitPrefix(id, prefix);
            },
            locationContext: (id) => instances?.locationContext(id) ?? { libraries: [], repos: [] },
            setLibraryPath: async (id, path) => {
              if (!instances) throw new AppError('device.newerData');
              await instances.setLibraryPath(id, path);
            },
            restart: (id) => {
              void instances
                ?.restartWorker(id)
                .catch((error: unknown) => logger.error('the worker could not start again', { error: String(error) }));
            },
            onAttention: (id, count) => instances?.setAttention(id, count),
            onSync: (id, counts) => instances?.setSync(id, counts),
            onAccess: (id, lost) => instances?.setAccessLost(id, lost),
            onRepos: (id, paths) => instances?.setRepos(id, paths),
          },
          instanceId,
          endpoint,
        ),
      );
      servicesServers.set(instanceId, server);
      if (isSetupId(instanceId)) setups?.connect(instanceId, endpoint);
      else if (workerTestApi) workerTestClients.set(instanceId, endpoint.connect(workerTestApi));
    },
  });
  const broadcast = <K extends keyof DeviceServicesApi['events']>(
    name: K,
    payload: Parameters<Server<DeviceServicesApi>['emit']>[1] & object,
  ) => {
    for (const server of servicesServers.values()) server.emit(name, payload as never);
  };

  instances = new InstanceManager({
    registry,
    supervisor,
    fs,
    paths: env.paths,
    layout,
    clock,
    random,
    logger,
    testRoot: env.testRoot,
    testHooks,
    randomSeed,
    onInstructionsChanged: (ids) => {
      for (const id of ids) servicesServers.get(id)?.emit('instructionsChanged', {});
    },
    // The prefixes in use are part of every worker's tool settings (a moved folder's name, PLAN.md §3.8 S2).
    onPrefixesChanged: () => broadcast('toolSettingsChanged', {}),
    // So are the library folders: never taken as code repos (PLAN.md §3.6), and where no library can move (§3.9).
    onLibrariesChanged: () => broadcast('toolSettingsChanged', {}),
  });
  const manager = instances;
  setups = new SetupManager({
    registry,
    supervisor,
    secrets,
    fs,
    paths: env.paths,
    layout,
    clock,
    random,
    logger,
    instances: manager,
    baseInit: () => manager.baseInit(),
    onChange: () => broker?.device?.emit('setupsChanged', { setups: setupManager.views() }),
    faults,
  });
  const setupManager = setups;

  // Device operations, with the test-only sample in test builds.
  const runningWorker = async (instanceId: string) => {
    const record = manager.records().find((r) => r.id === instanceId);
    if (!record) throw new Error(`no instance ${instanceId}`);
    if (!supervisor.get(instanceId)) supervisor.start(manager.workerInit(record));
    for (;;) {
      const worker = supervisor.get(instanceId);
      if (worker?.state === 'running' && worker.client) return worker.client;
      if (worker?.state === 'failed') throw new Error(`worker for ${instanceId} failed`);
      await wait(50);
    }
  };
  const deviceOperations = new DeviceOperationRunner({
    registry,
    faults,
    clock,
    random,
    logger,
    host: {
      runWorkerStep: async (operation, step) => {
        if (!operation.instanceId) throw new Error('worker step without an instance');
        const client = await runningWorker(operation.instanceId);
        await client.command.runDeviceOperationStep({
          operationId: operation.id,
          kind: operation.kind,
          step,
          params: operation.params,
        });
      },
    },
  });
  deviceOperations.register(removeInstanceOperation({ fs, layout, supervisor, secrets, os, logger }));
  deviceOperations.register(
    removeEverythingOperation({
      runner: () => deviceOperations,
      cancelSetups: async () => {
        for (const setup of setupManager.views()) await setupManager.cancel(setup.id);
      },
      logger,
    }),
  );
  if (hooks) deviceOperations.register(hooks.sampleDeviceOperation({ fs, paths: env.paths, dataRoot: layout.root }));

  // The no-window mode: one device operation, its result on stdout, then exit (IMPLEMENTATION.md §2.6).
  if (config.deviceOperation) {
    const op = config.deviceOperation;
    const record = op.instance === undefined ? undefined : manager.find(op.instance);
    const outcome = registry.usable
      ? await deviceOperations
          .resumeAll()
          .then(() => deviceOperations.start(op.kind, record ? { instanceId: record.id } : {}))
          .catch((error: unknown) => ({
            status: 'failed' as const,
            error: { code: 'operation.failed', message: String(error) },
          }))
      : { status: 'failed' as const, error: { code: 'device.newerData', message: 'device.json is not usable' } };
    process.stdout.write(`DEVICE_OPERATION_RESULT ${JSON.stringify(outcome)}\n`);
    await supervisor.stopAll();
    app.exit(outcome.status === 'done' ? 0 : 1);
    return;
  }

  // The window, the renderer's ports and the protocols.
  const rendererDir = path.join(options.outDir, '../renderer');
  const devUrl = config.devBuild ? process.env.ELECTRON_RENDERER_URL : undefined;
  serveRenderer(rendererDir, PACKAGED_CSP);
  serveAssets(async (url) => {
    const request = parseAssetUrl(url);
    if (!request.ok) return { status: request.status };
    const worker = supervisor.get(request.instanceId);
    if (worker?.state !== 'running' || !worker.client) return { status: 404 };
    try {
      const asset = await worker.client.command.readAsset({ path: request.segments.join('/') });
      return { status: 200, bytes: asset.bytes, mimeType: asset.mimeType };
    } catch (error) {
      logger.info('asset refused', { instance: request.instanceId, error: String(error) });
      return { status: 404 };
    }
  });
  hardenWebContents({
    allowedOrigin: devUrl ?? APP_ORIGIN,
    openExternal: (url) => void os.shell.openExternal(url),
  });

  let window: BrowserWindow | undefined;
  const appInfo = (): AppInfo => ({
    version: __APP_VERSION__,
    platform: env.platform,
    arch: process.arch,
    homePath: env.home,
    testMode,
    features: { testLibraries: testHooks, developerPages: testHooks },
    deviceState: registry.usable ? 'ok' : 'newerData',
    clockOffsetMs: clock.offsetMs,
    ...(testHooks && config.locale === 'pseudo' ? { locale: 'pseudo' as const } : {}),
  });
  if (registry.usable) nativeTheme.themeSource = registry.file.settings.theme;

  // Settings → Extra certificates (PLAN.md §3.19): kept in device.json; the bundle that git and the API calls use is
  // written again, the workers hear of it, and so does the window.
  const certificatesChanged = async () => {
    await writeCaBundle();
    broadcast('factsChanged', {});
    broker?.device?.emit('settingsChanged', settingsView(registry));
  };
  const certificates = {
    add: async (pems: readonly string[]) => {
      let added = 0;
      await registry.update((file) => {
        for (const pem of pems) {
          if (file.settings.extraCertificates.includes(pem)) continue;
          file.settings.extraCertificates.push(pem);
          added += 1;
        }
      });
      if (added > 0) await certificatesChanged();
      return added;
    },
    remove: async (fingerprint: string) => {
      await registry.update((file) => {
        file.settings.extraCertificates = file.settings.extraCertificates.filter(
          (pem) => !certificateViews([pem]).some((view) => view.fingerprint === fingerprint),
        );
      });
      await certificatesChanged();
    },
  };

  // App updates, checked once a day and on [Check now] (PLAN.md §3.19, Step 18). The feed comes through the session:
  // the OS proxy, or the recording proxy in test mode.
  const fetchFile = async (url: string) => {
    const response = await net.fetch(url, {
      redirect: 'follow',
      cache: 'no-store',
      bypassCustomProtocolHandlers: true,
    });
    if (Number(response.headers.get('content-length') ?? 0) > MAX_RELEASE_FILE_BYTES) throw new Error('too large');
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
  };
  const updates = new UpdateService({
    version: __APP_VERSION__,
    clock,
    logger,
    deviceId: () => (registry.usable ? registry.file.deviceId : 'unknown'),
    feed: {
      url: feed.feedUrl(feedFileName(process.platform, process.arch)),
      releasePage: (version) => feed.releasePage(version),
    },
    fetchFile,
    openExternal: (url) => os.shell.openExternal(url),
    onChange: (view) => broker?.device?.emit('updatesChanged', view),
  });

  // Export diagnostics (Step 16): the logs and the running libraries' Doctor reports, redacted, saved by the user.
  const diagnostics = new DiagnosticsService({
    fs,
    paths: env.paths,
    layout,
    clock,
    logger,
    app: () => ({ version: __APP_VERSION__, platform: env.platform, arch: process.arch }),
    home: env.home,
    instances: () =>
      manager.views().map((view) => {
        const record = manager.records().find((r) => r.id === view.id);
        return {
          id: view.id,
          name: view.name,
          status: view.status,
          gitUrl: record?.gitUrl ?? null,
          prefix: record?.gitPrefix ?? null,
          localPrefix: record?.localPrefix ?? null,
          libraryPath: record?.libraryPath ?? '',
        };
      }),
    doctor: async (id) => {
      const worker = supervisor.get(id);
      return worker?.state === 'running' && worker.client ? worker.client.query.doctorReport({}) : null;
    },
    saveFile: (defaultName) =>
      os.dialogs.saveFile({ purpose: 'diagnostics', title: translate('dialogs.saveDiagnostics'), defaultName }),
    allowWrite: (path) => {
      if (!savedFiles.includes(path)) savedFiles.push(path);
    },
  });
  broker = new PortBroker({
    createChannel: messageChannel,
    logger,
    deviceHandlers: () =>
      deviceApiHandlers({
        instances: manager,
        registry,
        os,
        logger,
        appInfo,
        onSettingsChanged: (theme) => {
          nativeTheme.themeSource = theme;
          broker?.device?.emit('settingsChanged', settingsView(registry));
        },
        setups: setupManager,
        deviceOperations,
        worker: runningWorker,
        tools: toolSettings,
        toolCommands,
        readPicked,
        invites,
        diagnostics,
        updates,
        certificates,
        window: {
          mode: () => ({ mode: windowMode }),
          openFull: () => showWindow(),
          quit: () => app.quit(),
        },
      }),
    sendToRenderer: (meta, port) => {
      if (!window || window.isDestroyed()) return false;
      window.webContents.postMessage(PORT_CHANNEL, meta, [port as Electron.MessagePortMain]);
      return true;
    },
    sendToWorker: (instanceId, generation, port) =>
      supervisor.post(instanceId, { type: 'renderer-port', generation }, [port]),
    runningWorkers: () =>
      supervisor
        .list()
        .filter((w) => w.state === 'running' && !isSetupId(w.instanceId))
        .map((w) => ({ instanceId: w.instanceId, generation: w.generation })),
  });
  ipcMain.on(HELLO_CHANNEL, (event) => {
    if (!window || event.sender !== window.webContents) return;
    logger.info('renderer connected');
    broker?.connectRenderer();
  });

  // A desktop without a tray (PLAN.md §3.19): no tray icon, and the window stays open as a small status view.
  const trayAvailable = await os.tray.available();
  if (!trayAvailable) logger.info('the desktop has no tray: the window stays open as a status view');
  let windowMode: WindowMode['mode'] = 'full';
  let quitting = false;
  const setWindowMode = (mode: WindowMode['mode']) => {
    if (windowMode === mode) return;
    windowMode = mode;
    if (window && !window.isDestroyed()) sizeWindow(window, mode, testMode);
    broker?.device?.emit('windowModeChanged', { mode });
  };
  const refreshTray = (views: readonly InstanceView[]) =>
    trayAvailable &&
    os.tray.show(trayMenu(views), (action) => {
      if (action.type === 'quit') app.quit();
      else {
        showWindow();
        if (action.type === 'open-instance') broker?.device?.emit('showInstance', { instanceId: action.instanceId });
      }
    });
  manager.changes.subscribe(() => {
    const views = manager.views();
    broker?.device?.emit('instancesChanged', { instances: views });
    refreshTray(views);
  });

  // A test run on macOS opens the window without taking the focus, and the app never becomes the active one, so the
  // person at the computer keeps the keyboard (TESTING.md §3). The tests don't need the focus: they send their input
  // to the page, and the test API's windowFocus stands in for the window's focus.
  const inactive = testMode && config.inactiveWindow && env.platform === 'darwin';
  if (inactive) app.setActivationPolicy('accessory');
  const presentWindow = () => {
    if (window && !window.isDestroyed()) {
      if (inactive) {
        window.showInactive();
        return;
      }
      window.show();
      window.focus();
      return;
    }
    window = createWindow({
      preload: path.join(options.outDir, '../preload/index.cjs'),
      testMode,
      devTools: testHooks,
      show: true,
      inactive,
      mode: windowMode,
    });
    if (!trayAvailable) {
      // Without a tray, closing the window can't hide the app: the full window becomes the status view, and the
      // status view is minimized. Quit is in the status view.
      window.on('close', (event) => {
        if (quitting) return;
        event.preventDefault();
        if (windowMode === 'full') setWindowMode('status');
        else window?.minimize();
      });
    }
    window.on('focus', () => broadcast('focus', { focused: true }));
    window.on('blur', () => broadcast('focus', { focused: false }));
    window.on('closed', () => {
      window = undefined;
      broker?.disconnectRenderer();
    });
    // A window without its UI shows nothing, so the log says why.
    window.webContents.on('did-fail-load', (_event, code, description, url) =>
      logger.error('the window failed to load', { code, description, url }),
    );
    window.webContents.on('render-process-gone', (_event, details) =>
      logger.error("the window's renderer stopped", { reason: details.reason, exitCode: details.exitCode }),
    );
    window
      .loadURL(devUrl ?? `${APP_ORIGIN}/index.html`)
      .catch((error: unknown) => logger.error('the window failed to load', { error: String(error) }));
  };
  // Invite links (PLAN.md §3.17 step 1): from a second start of the app (Windows, Linux), or macOS's open-url event.
  // Everything that shows the window shows the full app: the tray, a link, a second start, the Dock.
  const showWindow = () => {
    setWindowMode('full');
    presentWindow();
  };
  const invites = new InviteInbox({
    logger,
    onInvite: (invite) => broker?.device?.emit('inviteOpened', invite),
  });
  const openLink = (url: string) => {
    invites.receive(url);
    showWindow();
  };
  app.on('second-instance', (_event, argv) => {
    const link = linkInArgs(argv);
    if (link) openLink(link);
    else showWindow();
  });
  app.on('activate', showWindow);
  onOpenUrl(openLink);

  // Network, power and the login shell.
  const scheduler = new Scheduler(clock);
  const setOnline = (value: boolean) => {
    if (value === online) return;
    online = value;
    broadcast('network', { online });
  };
  if (!testMode) {
    watchSystem({
      onPower: (state) => broadcast('power', { state }),
      onOnline: setOnline,
      every: (ms, task) => scheduler.every(ms, task),
    });
    if (env.platform !== 'win32') {
      void readLoginShellEnv({
        process: new NodeProcessRunner(),
        shell: env.variable('SHELL') ?? '/bin/sh',
        homeEnvVariables: homeEnvVariables(bundledCatalog),
        logger,
      }).then((vars) => {
        shellEnv = vars;
        if (PROXY_VARIABLES.some((name) => name in vars)) broadcast('factsChanged', {});
        if (homeEnvNames.some((name) => name in vars)) broadcast('toolSettingsChanged', {});
      });
    }
  }

  // The app opens its invite links (Step 15), and starts at login unless the user switched it off (PLAN.md §3.19).
  // Test mode records both; nothing reaches the OS (TESTING.md §3).
  if (!os.protocol.register(brand.protocolScheme)) {
    logger.warn('invite links are not registered with the OS', { scheme: brand.protocolScheme });
  }
  if (registry.usable) os.loginItem.set(registry.file.settings.launchAtLogin);

  // Test hooks: the test API (TESTING.md §6).
  if (hooks && armedFaults && recordingOs && config.testRoot) {
    hooks.installTestApi(
      hooks.testApiHandlers({
        testRoot: config.testRoot,
        mainLog: env.paths.join(layout.logs, 'main.log'),
        instances: manager,
        supervisor,
        registry,
        deviceOperations,
        os: recordingOs,
        faults: armedFaults,
        workerTest: (id) => workerTestClients.get(id),
        locks: () => locks.view(),
        clock: {
          now: () => clock.now(),
          advance: (ms) => {
            const now = clock.advance(ms);
            broadcast('clock', { offsetMs: clock.offsetMs });
            return now;
          },
          setTime: (time) => {
            const now = clock.setTime(time);
            broadcast('clock', { offsetMs: clock.offsetMs });
            return now;
          },
        },
        setOnline,
        power: (state) => broadcast('power', { state }),
        focus: (focused) => broadcast('focus', { focused }),
        wait,
        fetch: async (url) => (await net.fetch(url)).status,
        trustCertificate: async (pem) => void (await certificates.add([pem])),
        scriptToolCommand: (program, stdout, code) => scriptedTools?.script(program, stdout, code),
        simulateKeyring: (available) => {
          if (secretCodec instanceof PlainCodec) secretCodec.simulateKeyring(available);
        },
        setups: () => setupManager.views(),
        openLink,
        windows: () => (window && !window.isDestroyed() ? 1 : 0),
        device: (name, input) => {
          const handlers = deviceApiHandlers({
            instances: manager,
            registry,
            os,
            logger,
            appInfo,
            onSettingsChanged: (theme) => {
              nativeTheme.themeSource = theme;
            },
            setups: setupManager,
            deviceOperations,
            worker: runningWorker,
            tools: toolSettings,
            toolCommands,
            readPicked,
            invites,
            diagnostics,
          });
          return invokeLocal(deviceApi, handlers, 'command', name, input);
        },
      }),
    );
  }

  // Start: workers for every instance, unfinished device operations, then the window and the tray.
  if (registry.usable) {
    // Setups that were interrupted first: a finished download becomes its instance, the rest is removed (A4.11).
    await setupManager
      .resumeAll()
      .catch((error: unknown) => logger.error('setups could not be resumed', { error: String(error) }));
    manager.startAll();
    void deviceOperations
      .resumeAll()
      .then((outcomes) => outcomes.length && logger.info('device operations resumed', { count: outcomes.length }));
  }
  refreshTray(manager.views());
  // A start through the login item opens only the tray (PLAN.md §3.19); an invite link always opens the window.
  const startLink = linkInArgs(process.argv);
  if (startLink) invites.receive(startLink);
  const atLogin = !startLink && os.loginItem.openedAtLogin();
  if (!atLogin) showWindow();
  else if (!trayAvailable) {
    windowMode = 'status';
    presentWindow();
    logger.info('started at login: the status view');
  } else logger.info('started at login: only the tray');
  // The first update check comes a little later, then once a day.
  updates.start();

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    scheduler.stopAll();
    updates.stop();
    void supervisor
      .stopAll()
      .catch(() => undefined)
      .finally(() => {
        os.tray.destroy();
        logger.info('stopped');
        // Quit again in a new task. When nothing needed stopping, this runs while Electron is still inside the quit
        // that raised before-quit. If Electron started that quit itself (on SIGTERM), it then records it as cancelled,
        // overriding this one: the window closes, but the app stays in the tray (A1.20).
        setImmediate(() => app.quit());
      });
  });
  app.on('window-all-closed', () => {
    // The app keeps running in the tray (PLAN.md §3.19).
  });
}
