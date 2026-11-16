// Export diagnostics (PLAN.md §3.13, §3.19 "Telemetry", IMPLEMENTATION.md Step 16): the only way a problem report
// leaves the device, and only when the user saves it. Main gathers one text:
// - the app's version and platform, and each library's state
// - each running library's Doctor report, from its worker
// - the end of every log file: main's, the setups', and each instance's worker log
// Nothing else is read: no skill, instruction or tool file. The text is redacted (secrets, as in the logs, and the
// home folder shown as ~), the user reviews exactly this text, and [Save…] writes exactly it.
import { brand } from '@app/brand';
import {
  type AbsPath,
  AppError,
  type Clock,
  type DataLayout,
  type FileSystem,
  type Logger,
  type PathFlavour,
} from '@app/core';
import { redactText } from '@app/adapters';
import type { DiagnosticsView, DoctorView } from '@app/ipc';

/** The end of each log file that goes in: enough for support, small enough to review. */
export const LOG_TAIL_BYTES = 256 * 1024;

export interface DiagnosticsInstance {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly gitUrl: string | null;
  readonly prefix: string | null;
  readonly localPrefix: string | null;
  readonly libraryPath: string;
}

export interface DiagnosticsDeps {
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly layout: DataLayout;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly app: () => { readonly version: string; readonly platform: string; readonly arch: string };
  readonly home: string;
  readonly instances: () => readonly DiagnosticsInstance[];
  /** A running instance's Doctor report; null when its worker isn't running or has no report. */
  readonly doctor: (instanceId: string) => Promise<DoctorView | null>;
  /** Where the user saves the file; null when they cancel. */
  readonly saveFile: (defaultName: string) => Promise<string | null>;
  /** Lets main write the one file the user chose. */
  readonly allowWrite: (path: string) => void;
}

const decoder = new TextDecoder();

/** Secrets masked as in the logs, and the home folder shown as ~ (with either separator on Windows). */
export function redactDiagnostics(text: string, home: string): string {
  let out = redactText(text);
  const homes = [...new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')])]
    .filter((h) => h.length > 1)
    .sort((a, b) => b.length - a.length);
  for (const h of homes) out = out.split(h).join('~');
  return out;
}

/** The last `max` bytes of a log, from the first whole line. */
export function logTail(bytes: Uint8Array, max = LOG_TAIL_BYTES): { text: string; truncated: boolean } {
  if (bytes.length <= max) return { text: decoder.decode(bytes), truncated: false };
  const text = decoder.decode(bytes.subarray(bytes.length - max));
  const newline = text.indexOf('\n');
  return { text: newline === -1 ? text : text.slice(newline + 1), truncated: true };
}

export class DiagnosticsService {
  readonly #deps: DiagnosticsDeps;
  #prepared: { id: string; text: string } | null = null;
  #seq = 0;

  constructor(deps: DiagnosticsDeps) {
    this.#deps = deps;
  }

  /** The text to review, with what it holds. The same text is what [Save…] writes. */
  async prepare(): Promise<DiagnosticsView> {
    const { clock, home } = this.#deps;
    const parts: Array<DiagnosticsView['parts'][number]> = [];
    const sections: string[] = [];
    const app = this.#deps.app();
    const created = new Date(clock.now()).toISOString();
    const instances = this.#deps.instances();
    const summary = [
      `${brand.displayName} diagnostics`,
      `Created: ${created}`,
      `Version: ${app.version} (${app.platform} ${app.arch})`,
      'The home folder is shown as ~. Secrets are masked as [redacted].',
      '',
      'Libraries:',
      ...(instances.length === 0 ? ['- none'] : []),
      ...instances.map(
        (instance) =>
          `- ${instance.name} (${instance.id}): ${instance.status}; prefix ${instance.prefix ?? 'none'}` +
          `${instance.localPrefix ? `, local prefix ${instance.localPrefix}` : ''}; folder ${instance.libraryPath}` +
          `; ${instance.gitUrl ?? 'test library'}`,
      ),
    ].join('\n');
    sections.push(summary);
    parts.push({ kind: 'summary', title: 'Summary', size: summary.length, truncated: false });

    for (const instance of instances) {
      const report = await this.#deps.doctor(instance.id).catch((error: unknown) => {
        this.#deps.logger.warn('no Doctor report for diagnostics', { instance: instance.id, error: String(error) });
        return null;
      });
      const title = `Doctor report: ${instance.name}`;
      const body = report === null ? 'Not available: the library is not running.' : JSON.stringify(report, null, 2);
      sections.push(`=== ${title} ===\n${body}`);
      parts.push({ kind: 'doctor', title, size: body.length, truncated: false });
    }

    for (const log of await this.#logFiles()) {
      const { text, truncated } = logTail(await this.#deps.fs.readBytes(log.path));
      const title = `Log: ${log.name}${truncated ? ' (the end only)' : ''}`;
      sections.push(`=== ${title} ===\n${text.trimEnd()}`);
      parts.push({ kind: 'log', title: `Log: ${log.name}`, size: text.length, truncated });
    }

    const text = `${redactDiagnostics(sections.join('\n\n'), home)}\n`;
    const id = `diag_${++this.#seq}`;
    this.#prepared = { id, text };
    return { id, text, parts };
  }

  /** Saves the reviewed text where the user chooses; null when they cancel. */
  async save(id: string): Promise<{ path: string | null }> {
    const prepared = this.#prepared;
    if (!prepared || prepared.id !== id) throw new AppError('diagnostics.expired');
    const stamp = new Date(this.#deps.clock.now()).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const path = await this.#deps.saveFile(`${brand.packageName}-diagnostics-${stamp}.txt`);
    if (path === null) return { path: null };
    this.#deps.allowWrite(path);
    await this.#deps.fs.writeTextAtomic(path as AbsPath, prepared.text);
    this.#deps.logger.info('diagnostics saved', { bytes: prepared.text.length });
    return { path };
  }

  /** Every log file: the device's (main, setups) and each instance's, by their names in the data folder. */
  async #logFiles(): Promise<Array<{ name: string; path: AbsPath }>> {
    const { fs, paths, layout } = this.#deps;
    const out: Array<{ name: string; path: AbsPath }> = [];
    const add = async (dir: AbsPath, label: string) => {
      if ((await fs.lstat(dir))?.kind !== 'dir') return;
      for (const name of (await fs.list(dir)).sort()) {
        if (!name.endsWith('.log')) continue;
        const path = paths.join(dir, name) as AbsPath;
        if ((await fs.lstat(path))?.kind === 'file') out.push({ name: `${label}${name}`, path });
      }
    };
    await add(layout.logs, 'logs/');
    if ((await fs.lstat(layout.instances))?.kind === 'dir') {
      for (const id of (await fs.list(layout.instances)).sort()) {
        await add(layout.instance(id).logs, `instances/${id}/logs/`);
      }
    }
    return out;
  }
}
