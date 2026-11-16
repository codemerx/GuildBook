// The device API's handlers (IMPLEMENTATION.md §2.8): what the renderer asks of main.
import { AppError, checkLibraryUrl, type DeviceOperationRunner, type DeviceRegistry, type Logger } from '@app/core';
import type {
  AppInfo,
  Client,
  DeviceApi,
  DeviceSettingsView,
  Handlers,
  UpdateView,
  WindowMode,
  WorkerApi,
} from '@app/ipc';
import { FILE_SIZE_MAX, type ProtectedFolder, ProtectedFolderSchema, type Theme } from '@app/schemas';
import { translate } from '../shared/i18n.ts';

/** The last part of a path, with either separator. */
const basename = (path: string) =>
  path
    .split(/[\\/]/)
    .filter((part) => part !== '')
    .at(-1) ?? path;
import type { DiagnosticsService } from './diagnostics.ts';
import type { InstanceManager } from './instances.ts';
import type { InviteInbox } from './invites.ts';
import type { OsIntegrations } from './os/integrations.ts';
import { REMOVE_EVERYTHING } from './remove-everything.ts';
import { REMOVE_INSTANCE } from './remove-instance.ts';
import type { SetupManager } from './setups.ts';
import type { ToolCommandService } from './tool-commands.ts';
import type { ToolSettingsService } from './tool-settings.ts';
import type { UpdateService } from './updates.ts';
import { CERTIFICATE_FILE_MAX, certificateViews, parseCertificates } from './certificates.ts';

export interface DeviceApiDeps {
  readonly instances: InstanceManager;
  readonly registry: DeviceRegistry;
  readonly os: OsIntegrations;
  readonly logger: Logger;
  readonly appInfo: () => AppInfo;
  readonly onSettingsChanged: (theme: Theme) => void;
  readonly setups: SetupManager;
  readonly deviceOperations: DeviceOperationRunner;
  /** The running worker of an instance, waiting while it starts. */
  readonly worker: (instanceId: string) => Promise<Client<WorkerApi>>;
  readonly tools: ToolSettingsService;
  /** The tools' version and list commands (the Doctor, PLAN.md §3.4). */
  readonly toolCommands: ToolCommandService;
  /** Reads a file the user picked (PLAN.md §3.7): its size, and its bytes unless it's larger than `max`. */
  readonly readPicked: (path: string, max: number) => Promise<{ size: number; bytes: Uint8Array | null }>;
  /** Invite links the OS handed over (Step 15). */
  readonly invites?: InviteInbox;
  /** Export diagnostics (Step 16). */
  readonly diagnostics?: DiagnosticsService;
  /** The window's form, and the status view's buttons (Step 17, PLAN.md §3.19). */
  readonly window?: {
    mode(): WindowMode;
    openFull(): void;
    quit(): void;
  };
  /** App updates and the catalog refresh (Step 18). */
  readonly updates?: UpdateService;
  /** Settings → Extra certificates (Step 18): kept in device.json, and the certificate bundle written again. */
  readonly certificates?: {
    /** Adds the ones not there yet; returns how many. */
    add(pems: readonly string[]): Promise<number>;
    remove(fingerprint: string): Promise<void>;
  };
}

/** Where no update service runs (the test API's window-less calls): nothing to update. */
const NO_UPDATES = (version: string): UpdateView => ({
  version,
  supported: false,
  phase: 'idle',
  available: null,
  dismissed: false,
  lastCheckedAt: null,
  error: null,
  catalog: { source: 'bundled', refreshedAt: null, rejected: null },
});

const DIALOG_TITLES = {
  library: 'dialogs.chooseLibraryFolder',
  'test-library': 'dialogs.chooseTestLibraryFolder',
  'tool-folder': 'dialogs.chooseToolFolder',
  repo: 'dialogs.chooseRepoFolder',
  'repo-root': 'dialogs.chooseRepoRoot',
  relocation: 'dialogs.chooseNewLocation',
  locate: 'dialogs.locateLibrary',
  'import-folder': 'dialogs.chooseImportFolder',
  'import-skill': 'dialogs.chooseExistingSkill',
} as const;

const FILE_DIALOG_TITLES = {
  instructions: 'dialogs.loadInstructions',
  'skill-file': 'dialogs.chooseSkillFile',
  'signing-key': 'dialogs.chooseSigningKey',
  'import-archive': 'dialogs.chooseImportFile',
  certificate: 'dialogs.chooseCertificate',
} as const;

/** A public key file is one line; anything larger isn't one. */
const KEY_FILE_MAX = 20_000;

/** Only web pages open in the browser (IMPLEMENTATION.md §2.12). */
export function isWebUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** The folders the app reads again at every start, whose access macOS asks about: repos (Step 17). */
const NOTICE_PURPOSES: ReadonlySet<string> = new Set(['repo', 'repo-root']);

/** The macOS folder a path is in, when the system asks before an app reads it: Desktop, Documents or Downloads. */
export function protectedFolder(path: string, home: string): ProtectedFolder | null {
  const trimmed = home.replace(/\/+$/, '');
  for (const folder of ProtectedFolderSchema.options) {
    const root = `${trimmed}/${folder}`;
    if (path === root || path.startsWith(`${root}/`)) return folder;
  }
  return null;
}

export function settingsView(registry: DeviceRegistry): DeviceSettingsView {
  if (!registry.usable)
    return {
      theme: 'system',
      extraCertificateCount: 0,
      extraCertificates: [],
      launchAtLogin: true,
      notifications: { off: [], doNotDisturb: false },
    };
  const { settings } = registry.file;
  return {
    theme: settings.theme,
    extraCertificateCount: settings.extraCertificates.length,
    extraCertificates: certificateViews(settings.extraCertificates),
    launchAtLogin: settings.launchAtLogin,
    notifications: settings.notifications,
  };
}

export function deviceApiHandlers(deps: DeviceApiDeps): Handlers<DeviceApi> {
  const diagnostics = () => {
    if (!deps.diagnostics) throw new AppError('feature.unavailable', { feature: 'diagnostics' });
    return deps.diagnostics;
  };
  return {
    queries: {
      appInfo: () => deps.appInfo(),
      instances: () => deps.instances.views(),
      settings: () => settingsView(deps.registry),
      checkUrl: ({ url }) => deps.setups.checkUrl(url),
      setups: () => deps.setups.views(),
      toolSettings: () => deps.tools.view(),
      invite: () => deps.invites?.pending() ?? null,
      windowMode: () => deps.window?.mode() ?? { mode: 'full' },
      updates: () => deps.updates?.view() ?? NO_UPDATES(deps.appInfo().version),
    },
    commands: {
      addTestLibrary: async ({ name, path }) => {
        if (!deps.appInfo().features.testLibraries)
          throw new AppError('feature.unavailable', { feature: 'testLibraries' });
        return { id: await deps.instances.addTestLibrary(name, path) };
      },
      chooseFolder: async ({ purpose }) => {
        const path = await deps.os.dialogs.chooseFolder({
          purpose,
          title: translate(DIALOG_TITLES[purpose]),
        });
        if (path === null) return { path };
        deps.instances.allowPicked(path);
        for (const setup of deps.setups.views()) deps.setups.allowFolder(setup.id, path);
        const info = deps.appInfo();
        const folder =
          info.platform === 'darwin' && NOTICE_PURPOSES.has(purpose) ? protectedFolder(path, info.homePath) : null;
        const noticed = deps.registry.usable ? deps.registry.file.settings.folderAccessNoticed : [];
        return folder && !noticed.includes(folder) ? { path, accessNotice: folder } : { path };
      },
      noticeFolderAccess: async ({ folder }) => {
        await deps.registry.update((file) => {
          if (!file.settings.folderAccessNoticed.includes(folder)) file.settings.folderAccessNoticed.push(folder);
        });
        deps.logger.info('the notice about a protected folder was read', { folder });
        return {};
      },
      chooseImportFile: async () => {
        const path = await deps.os.dialogs.chooseFile({
          purpose: 'import-archive',
          title: translate(FILE_DIALOG_TITLES['import-archive']),
        });
        return { path };
      },
      pickFile: async ({ purpose }) => {
        const path = await deps.os.dialogs.chooseFile({ purpose, title: translate(FILE_DIALOG_TITLES[purpose]) });
        if (path === null) return null;
        // Over 50 MB a file can't go into a skill (PLAN.md §3.19): only its size goes back.
        const { size, bytes } = await deps.readPicked(path, FILE_SIZE_MAX);
        return { name: basename(path), size, bytes };
      },
      pickSigningKey: async () => {
        const path = await deps.os.dialogs.chooseFile({
          purpose: 'signing-key',
          title: translate(FILE_DIALOG_TITLES['signing-key']),
        });
        if (path === null) return null;
        const { bytes } = await deps.readPicked(path, KEY_FILE_MAX);
        const line = bytes === null ? '' : (new TextDecoder().decode(bytes).split('\n')[0] ?? '').trim();
        return { path, publicKey: line.slice(0, KEY_FILE_MAX) };
      },
      startSetup: async ({ url, intent, clientId }) => ({
        setupId: await deps.setups.start(url, intent, clientId ?? null),
      }),
      setupSignIn: ({ setupId, ...input }, context) =>
        deps.setups.signIn(setupId, input, (code) => context.progress(code)),
      setupIdentity: ({ setupId, identity }) => deps.setups.setIdentity(setupId, identity),
      setupCheckFolder: ({ setupId, path }) => deps.setups.checkFolder(setupId, path),
      setupDownload: ({ setupId }, context) => deps.setups.download(setupId, (p) => context.progress(p)),
      setupCreate: ({ setupId, prefix }) => deps.setups.createLibrary(setupId, prefix),
      setupJoinInstead: ({ setupId }) => deps.setups.joinInstead(setupId),
      setupCheckLocalPrefix: ({ setupId, prefix }) => deps.setups.checkLocalPrefix(setupId, prefix),
      setupChooseLocalPrefix: ({ setupId, prefix }) => deps.setups.chooseLocalPrefix(setupId, prefix),
      setupChooseFolders: ({ setupId, choices }) => deps.setups.chooseFolders(setupId, choices),
      cancelSetup: async ({ setupId }) => {
        await deps.setups.cancel(setupId);
        return {};
      },
      finishSetup: async ({ instanceId, planHash }) => {
        const record = deps.instances.find(instanceId);
        if (!record || record.id !== instanceId) throw new AppError('instance.notFound', { instanceId });
        if (record.status !== 'setting-up') throw new AppError('setup.wrongStep', { step: record.status });
        await (await deps.worker(instanceId)).command.finishSetup({ planHash });
        await deps.registry.update((file) => {
          const target = file.instances.find((i) => i.id === instanceId);
          if (target) target.status = 'ready';
        });
        deps.instances.changes.emit();
        deps.logger.info('setup finished', { instance: instanceId });
        return {};
      },
      changeUrl: async ({ instanceId, url }) => {
        const record = deps.instances.find(instanceId);
        if (!record || record.id !== instanceId) throw new AppError('instance.notFound', { instanceId });
        const others = deps.instances.records().filter((r) => r.id !== instanceId);
        const checked = checkLibraryUrl(url, others);
        if (!checked.ok) {
          if (checked.error.code === 'gitUrl.alreadyConnected') {
            throw new AppError('setup.alreadyConnected', { name: checked.error.name });
          }
          throw new AppError('setup.urlInvalid', { problem: checked.error.code });
        }
        await (await deps.worker(instanceId)).command.changeUrl({ url: checked.value.url.url });
        await deps.registry.update((file) => {
          const target = file.instances.find((i) => i.id === instanceId);
          if (target) target.gitUrl = checked.value.url.url;
        });
        deps.instances.changes.emit();
        deps.logger.info('library URL changed', { instance: instanceId });
        return {};
      },
      removeInstance: async ({ instanceId, deleteFolder }) => {
        if (!deps.instances.records().some((r) => r.id === instanceId)) {
          throw new AppError('instance.notFound', { instanceId });
        }
        const outcome = await deps.deviceOperations.start(REMOVE_INSTANCE, { instanceId, params: { deleteFolder } });
        deps.instances.changes.emit();
        if (outcome.status === 'failed')
          throw new AppError('operation.failed', { kind: REMOVE_INSTANCE, code: outcome.error.code });
        return {};
      },
      removeEverything: async () => {
        const before = deps.instances.records().length;
        const outcome = await deps.deviceOperations.start(REMOVE_EVERYTHING);
        deps.instances.changes.emit();
        if (outcome.status === 'failed')
          throw new AppError('operation.failed', { kind: REMOVE_EVERYTHING, code: outcome.error.code });
        return { removed: before - deps.instances.records().length };
      },
      setTheme: async ({ theme }) => {
        await deps.registry.update((file) => {
          file.settings.theme = theme;
        });
        deps.onSettingsChanged(theme);
        return {};
      },
      setToolFolder: async ({ toolId, path }) => {
        await deps.tools.setToolFolder(toolId, path);
        return {};
      },
      addCustomTool: async ({ name, skillDir, instructions, copy }) => ({
        id: await deps.tools.addCustomTool(name, skillDir, instructions ?? null, copy ?? false),
      }),
      setInstructionsLinked: async ({ instanceId, action }) => {
        await deps.instances.setInstructionsLinked(instanceId, action);
        return {};
      },
      runToolCommand: ({ toolId, which }) => deps.toolCommands.run(toolId, which),
      takeInvite: ({ seq }) => {
        deps.invites?.take(seq);
        return {};
      },
      setLaunchAtLogin: async ({ on }) => {
        await deps.registry.update((file) => {
          file.settings.launchAtLogin = on;
        });
        deps.os.loginItem.set(on);
        deps.logger.info('launch at login changed', { on });
        deps.onSettingsChanged(deps.registry.file.settings.theme);
        return {};
      },
      openFullWindow: () => {
        deps.window?.openFull();
        return {};
      },
      quitApp: () => {
        deps.logger.info('quit from the status view');
        deps.window?.quit();
        return {};
      },
      addCertificate: async () => {
        if (!deps.certificates) throw new AppError('feature.unavailable', { feature: 'certificates' });
        const path = await deps.os.dialogs.chooseFile({
          purpose: 'certificate',
          title: translate(FILE_DIALOG_TITLES.certificate),
        });
        if (path === null) return { added: 0 };
        const { bytes } = await deps.readPicked(path, CERTIFICATE_FILE_MAX);
        const found = bytes === null ? [] : parseCertificates(new TextDecoder().decode(bytes));
        if (found.length === 0) throw new AppError('certificate.invalid');
        const added = await deps.certificates.add(found.map((c) => c.pem));
        deps.logger.info('extra certificates added', { added });
        return { added };
      },
      removeCertificate: async ({ fingerprint }) => {
        if (!deps.certificates) throw new AppError('feature.unavailable', { feature: 'certificates' });
        await deps.certificates.remove(fingerprint);
        deps.logger.info('an extra certificate was removed');
        return {};
      },
      checkForUpdates: async () => (deps.updates ? deps.updates.check() : NO_UPDATES(deps.appInfo().version)),
      openUpdateDownload: async () => {
        if (!deps.updates) throw new AppError('update.notAvailable');
        await deps.updates.openDownload();
        return {};
      },
      dismissUpdate: async () => {
        deps.updates?.dismiss();
        return {};
      },
      setNotifications: async ({ off, doNotDisturb }) => {
        await deps.registry.update((file) => {
          file.settings.notifications = { off: [...new Set(off)], doNotDisturb };
        });
        deps.logger.info('notification settings changed', { off, doNotDisturb });
        deps.onSettingsChanged(deps.registry.file.settings.theme);
        return {};
      },
      copyText: async ({ text }) => {
        await deps.os.clipboard.writeText(text);
        return {};
      },
      prepareDiagnostics: () => diagnostics().prepare(),
      saveDiagnostics: ({ id }) => diagnostics().save(id),
      removeCustomTool: async ({ id }) => {
        await deps.tools.removeCustomTool(id);
        return {};
      },
      openExternal: async ({ url }) => {
        if (!isWebUrl(url)) throw new AppError('url.notAllowed');
        await deps.os.shell.openExternal(url);
        return {};
      },
      reportRendererError: ({ message, stack }) => {
        deps.logger.error('renderer error', { message, stack });
        return {};
      },
    },
  };
}
