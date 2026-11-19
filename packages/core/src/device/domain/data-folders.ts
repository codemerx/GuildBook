// Where the app keeps its data (PLAN.md §3.1): ~/Library/Application Support/<name> on macOS, %LOCALAPPDATA%\<name> on
// Windows (the local, non-roaming folder), $XDG_CONFIG_HOME or ~/.config/<name> on Linux. In test mode everything is
// under the test root's appdata/ (TESTING.md §3).
import { brand } from '@app/brand';
import type { Platform } from '../../ports/env.ts';
import type { AbsPath } from '../../shared/brand.ts';
import type { PathFlavour } from '../../shared/paths.ts';

export interface DataRootInputs {
  readonly platform: Platform;
  readonly paths: PathFlavour;
  readonly home: string;
  /** %LOCALAPPDATA% on Windows. */
  readonly localAppData: string | undefined;
  /** $XDG_CONFIG_HOME on Linux. */
  readonly xdgConfigHome: string | undefined;
  readonly testRoot: string | undefined;
}

export function dataRoot(inputs: DataRootInputs): AbsPath {
  const { paths } = inputs;
  if (inputs.testRoot !== undefined) return paths.join(inputs.testRoot, 'appdata', brand.dataFolderName) as AbsPath;
  switch (inputs.platform) {
    case 'darwin':
      return paths.join(inputs.home, 'Library', 'Application Support', brand.dataFolderName) as AbsPath;
    case 'win32': {
      const base =
        inputs.localAppData && paths.isAbsolute(inputs.localAppData)
          ? inputs.localAppData
          : paths.join(inputs.home, 'AppData', 'Local');
      return paths.join(base, brand.dataFolderName) as AbsPath;
    }
    case 'linux': {
      const base =
        inputs.xdgConfigHome && paths.isAbsolute(inputs.xdgConfigHome)
          ? inputs.xdgConfigHome
          : paths.join(inputs.home, '.config');
      return paths.join(base, brand.dataFolderName) as AbsPath;
    }
  }
}

export interface DataLayout {
  readonly root: AbsPath;
  readonly deviceFile: AbsPath;
  /** The device-level log folder: main's log, and pending workers' logs (IMPLEMENTATION.md §2.1). */
  readonly logs: AbsPath;
  readonly crashDumps: AbsPath;
  /** Electron's own userData: Chromium's caches and the single-instance lock. */
  readonly electron: AbsPath;
  readonly secrets: AbsPath;
  readonly caBundle: AbsPath;
  readonly instances: AbsPath;
  instance(id: string): InstanceLayout;
}

export interface InstanceLayout {
  readonly root: AbsPath;
  readonly database: AbsPath;
  readonly logs: AbsPath;
  readonly journal: AbsPath;
  readonly trash: AbsPath;
}

export function dataLayout(root: AbsPath, paths: PathFlavour): DataLayout {
  const at = (...parts: string[]) => paths.join(root, ...parts) as AbsPath;
  return {
    root,
    deviceFile: at('device.json'),
    logs: at('logs'),
    crashDumps: at('crash-dumps'),
    electron: at('electron'),
    secrets: at('secrets.json'),
    caBundle: at('ca-bundle.pem'),
    instances: at('instances'),
    instance: (id) => instanceLayout(paths.join(root, 'instances', id) as AbsPath, paths),
  };
}

/** An instance's data folder (PLAN.md §3.1): its database, logs, journals and trash. */
export function instanceLayout(root: AbsPath, paths: PathFlavour): InstanceLayout {
  return {
    root,
    database: paths.join(root, 'instance.db') as AbsPath,
    logs: paths.join(root, 'logs') as AbsPath,
    journal: paths.join(root, 'journal') as AbsPath,
    trash: paths.join(root, 'trash') as AbsPath,
  };
}
