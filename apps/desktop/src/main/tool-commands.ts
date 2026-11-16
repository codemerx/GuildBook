// The tools' own commands for the Doctor (PLAN.md §3.4): `version_command` for version drift, `list_command` to compare
// what a tool loaded. They're device facts, so main runs them: with the login shell's PATH (an app started from the
// Dock doesn't see a shell profile's), without a shell, and with a timeout. A list's output is filtered to names
// starting with a prefix in use before it leaves this module (PLAN.md §3.7 rule 3), and is never logged.
import {
  type Clock,
  type DeviceRegistry,
  effectivePrefix,
  filterListedSkills,
  type Logger,
  parseVersion,
  type Prefix,
  type ProcessRunner,
  splitCommand,
} from '@app/core';
import type { ToolCommandView } from '@app/ipc';
import type { Catalog } from '@app/tools';

export interface ToolCommandDeps {
  readonly catalog: () => Promise<Catalog>;
  readonly registry: DeviceRegistry;
  readonly process: ProcessRunner;
  /** The environment the commands get: PATH and HOME, from the login shell where it was read. */
  readonly env: () => Record<string, string>;
  readonly clock: Clock;
  readonly logger: Logger;
}

const TIMEOUT_MS = 15_000;
/** A version doesn't change while the app runs, often: it's asked again after this long. */
const VERSION_TTL_MS = 10 * 60 * 1000;

export class ToolCommandService {
  readonly #deps: ToolCommandDeps;
  readonly #versions = new Map<string, ToolCommandView>();

  constructor(deps: ToolCommandDeps) {
    this.#deps = deps;
  }

  #prefixes(): string[] {
    const { registry } = this.#deps;
    if (!registry.usable) return [];
    return [
      ...new Set(
        registry.file.instances.flatMap((instance) =>
          instance.gitPrefix
            ? [effectivePrefix(instance.gitPrefix as Prefix, (instance.localPrefix as Prefix | null) ?? null)]
            : [],
        ),
      ),
    ].sort();
  }

  async run(toolId: string, which: 'version' | 'list'): Promise<ToolCommandView> {
    const { clock, logger } = this.#deps;
    const now = clock.now();
    const cached = this.#versions.get(toolId);
    if (which === 'version' && cached && now - cached.ranAt < VERSION_TTL_MS) return cached;
    const tool = (await this.#deps.catalog()).tools.find((entry) => entry.id === toolId);
    const command = which === 'version' ? tool?.version_command : tool?.list_command;
    const base = { toolId, which, version: null, skills: [], ranAt: now } satisfies Omit<ToolCommandView, 'state'>;
    const split = command ? splitCommand(command) : null;
    if (!split) return { ...base, state: 'none' };
    let view: ToolCommandView;
    try {
      const result = await this.#deps.process.run(split.program, split.args, {
        env: this.#deps.env(),
        timeoutMs: TIMEOUT_MS,
      });
      const ok = result.code === 0 && !result.timedOut;
      view = !ok
        ? { ...base, state: 'failed' }
        : which === 'version'
          ? { ...base, state: 'ok', version: parseVersion(`${result.stdout}\n${result.stderr}`) }
          : { ...base, state: 'ok', skills: filterListedSkills(result.stdout, this.#prefixes()) };
      logger.info('tool command ran', { tool: toolId, which, state: view.state, code: result.code });
    } catch (error) {
      const missing = (error as { code?: unknown }).code === 'ENOENT';
      view = { ...base, state: missing ? 'not-found' : 'failed' };
      logger.info('tool command did not run', { tool: toolId, which, missing });
    }
    if (which === 'version') this.#versions.set(toolId, view);
    return view;
  }
}
