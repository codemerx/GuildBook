// Tool settings kept once per device (PLAN.md §3.4 "Custom tools", "Moved tool folders"): a tool belongs to the device,
// not to a library, so custom tools and tool folders the user changed live in device.json, which only main writes.
// Each instance still enables the tools it uses. Workers get these settings, with the tools' `home_env` variables and
// the prefixes in use on the device, through the device services.
import {
  AppError,
  customToolId,
  type DeviceRegistry,
  effectivePrefix,
  type Logger,
  type PathFlavour,
  type Prefix,
} from '@app/core';
import type { ToolSettings, ToolSettingsView } from '@app/ipc';
import type { Catalog } from '@app/tools';

export interface ToolSettingsDeps {
  readonly registry: DeviceRegistry;
  readonly catalog: Catalog;
  readonly paths: PathFlavour;
  readonly logger: Logger;
  /** The `home_env` variables that are set: from the app's environment, or the login shell's (PLAN.md §3.4). */
  readonly homeEnv: () => Record<string, string>;
  /** Called after every change, to tell the workers and the renderer. */
  readonly onChange: (view: ToolSettingsView) => void;
}

/** A folder the user typed or picked: absolute, or in the home folder (`~/…`). */
function checkFolder(path: string, paths: PathFlavour): string {
  const trimmed = path.trim();
  const home = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\');
  if (!home && !paths.isAbsolute(trimmed)) throw new AppError('tools.folderInvalid', { path });
  return home ? trimmed : paths.normalize(trimmed);
}

export class ToolSettingsService {
  readonly #deps: ToolSettingsDeps;

  constructor(deps: ToolSettingsDeps) {
    this.#deps = deps;
  }

  view(): ToolSettingsView {
    const { registry } = this.#deps;
    if (!registry.usable) return { customTools: [], toolFolders: {} };
    return { customTools: registry.file.customTools, toolFolders: registry.file.toolFolders };
  }

  /** What a worker gets. */
  forWorker(): ToolSettings {
    const { registry } = this.#deps;
    const prefixes = registry.usable
      ? registry.file.instances.flatMap((instance) =>
          instance.gitPrefix
            ? [effectivePrefix(instance.gitPrefix as Prefix, (instance.localPrefix as Prefix | null) ?? null)]
            : [],
        )
      : [];
    const libraryFolders = registry.usable ? registry.file.instances.map((instance) => instance.libraryPath) : [];
    return {
      ...this.view(),
      homeEnv: this.#deps.homeEnv(),
      prefixesInUse: [...new Set(prefixes)].sort(),
      libraryFolders: [...new Set(libraryFolders)].sort(),
    };
  }

  async setToolFolder(toolId: string, path: string | null): Promise<void> {
    if (!this.#deps.catalog.tools.some((tool) => tool.id === toolId))
      throw new AppError('tools.unknown', { tool: toolId });
    const folder = path === null ? null : checkFolder(path, this.#deps.paths);
    await this.#deps.registry.update((file) => {
      if (folder === null) delete file.toolFolders[toolId];
      else file.toolFolders[toolId] = folder;
    });
    this.#deps.logger.info('tool folder changed', { tool: toolId, reset: folder === null });
    this.#deps.onChange(this.view());
  }

  /**
   * A custom tool, or with `copy` a copy target (Step 16): a folder that gets copies of the skills, such as a WSL
   * distribution's folder through `\\wsl.localhost\…`, a folder mounted into a container or VM, or a sandboxed app's.
   */
  async addCustomTool(
    name: string,
    skillDir: string,
    instructions: { method: 'marked-block' | 'owned-file'; path: string } | null = null,
    copy = false,
  ): Promise<string> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 100) throw new AppError('tools.customInvalid', { name });
    const dir = checkFolder(skillDir, this.#deps.paths);
    // An instructions file is checked like a folder: absolute, or in the home folder.
    const how = instructions
      ? { method: instructions.method, path: checkFolder(instructions.path, this.#deps.paths) }
      : null;
    const taken = [
      ...this.#deps.catalog.tools.map((tool) => tool.id),
      ...this.view().customTools.map((tool) => tool.id),
    ];
    if (this.view().customTools.some((tool) => tool.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new AppError('tools.customInvalid', { name });
    }
    const id = customToolId(trimmed, taken);
    await this.#deps.registry.update((file) => {
      file.customTools.push({ id, name: trimmed, skillDirs: [dir], instructions: how, copy });
    });
    this.#deps.logger.info('custom tool added', { tool: id, copy });
    this.#deps.onChange(this.view());
    return id;
  }

  async removeCustomTool(id: string): Promise<void> {
    if (!this.view().customTools.some((tool) => tool.id === id)) throw new AppError('tools.unknown', { tool: id });
    await this.#deps.registry.update((file) => {
      file.customTools = file.customTools.filter((tool) => tool.id !== id);
    });
    this.#deps.logger.info('custom tool removed', { tool: id });
    this.#deps.onChange(this.view());
  }
}
