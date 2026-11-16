// The company's instructions in one instance (IMPLEMENTATION.md Step 7, PLAN.md §3.12): the library's
// `instructions/AGENTS.md` reaches each enabled tool's global instructions while the company is linked on this device.
// - The check is a background command, run with the link check: at start, on focus, every 3 minutes and after git
//   changes. It refreshes the copies the app wrote and nobody changed, and asks about everything else.
// - Copies pause while a git operation in the library is unfinished, so conflict markers never reach them (PLAN.md
//   §3.3), and while the library needs a newer app.
// - Linking is the device's choice (device.json, written by main): the worker follows it, and logs each change.
import { INSTRUCTION_KIND, type InstructionRow, type InstructionStatus } from '@app/schemas';
import type { Catalog } from '@app/tools';
import type { ActivityLog, InstanceTrash } from '../../activity/index.ts';
import { type ResolvedTool, resolveTools, type ToolSettings } from '../../catalog/index.ts';
import { defineCommand, defineQuery, type InstanceEngine, type ReconcileRunner } from '../../engine/index.ts';
import { INSTRUCTIONS_FILE, type LibrarySnapshot } from '../../library/index.ts';
import type { Clock } from '../../ports/clock.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { GitRepo } from '../../ports/git.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Store } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import type { DomainEvent } from '../../shared/events.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import {
  desiredInstructions,
  type InstructionFacts,
  type InstructionInputs,
  manualTools,
  NO_FACTS,
} from '../domain/artifacts.ts';
import { findBlock, hasOwnText } from '../domain/blocks.ts';
import { type RoomLeft, roomLeft } from '../domain/limits.ts';
import type { InstructionAction, InstructionDecision } from '../domain/plan.ts';
import { followLinks, instructionReconciler, readInstructionRow } from './instruction-reconciler.ts';

type NoInput = Record<string, never>;

/** The instruction check. Background work: a user command cancels it, and it runs again after. */
export const CheckInstructions = defineCommand<NoInput, InstructionCheckReport>('CheckInstructions', {
  background: true,
});
export const ResolveInstruction = defineCommand<
  { key: string; decision: InstructionDecision; planHash: string },
  InstructionCheckReport
>('ResolveInstruction');
export const InstructionsQuery = defineQuery<NoInput, InstructionsState>('Instructions');
export const PreviewInstruction = defineQuery<{ key: string; decision: InstructionDecision }, InstructionPreview>(
  'PreviewInstruction',
);

/** The instructions changed: the renderer refreshes the Instructions page and the Doctor. */
export interface InstructionsChanged extends DomainEvent {
  readonly type: 'InstructionsChanged';
}

export interface InstructionCheckReport {
  readonly state: 'done' | 'frozen' | 'paused' | 'not-ready';
  readonly applied: number;
  /** Artifacts that wait for the user: edited or damaged. */
  readonly waiting: number;
}

export interface InstructionArtifactView {
  readonly key: string;
  readonly written: string;
  readonly artifact: InstructionRow['artifact'];
  readonly role: InstructionRow['role'];
  readonly status: InstructionStatus | 'pending';
  readonly since: number | null;
}

export interface InstructionToolView {
  readonly id: string;
  readonly name: string;
  /** `none`: the app can't reach its instructions: skills only (PLAN.md §3.4). */
  readonly method: NonNullable<ResolvedTool['instructions']>['method'] | 'none';
  readonly artifacts: readonly InstructionArtifactView[];
  /** The worst state of its artifacts: what the page shows for the tool. */
  readonly status: InstructionStatus | 'pending' | 'manual' | 'none' | 'off';
  readonly room: RoomLeft | null;
}

export interface InstructionsState {
  readonly state: InstructionCheckReport['state'];
  readonly linked: boolean;
  /** The library's instructions/AGENTS.md: its size, and its text when a tool needs it copied by hand (Cursor). */
  readonly library: { readonly path: string; readonly bytes: number; readonly characters: number } | null;
  readonly manualText: string | null;
  readonly tools: readonly InstructionToolView[];
  readonly waiting: readonly InstructionArtifactView[];
}

export interface InstructionPreview {
  readonly hash: string;
  readonly key: string;
  readonly decision: InstructionDecision;
  /** The changed text found in the file (inside the block, or the owned file). */
  readonly edited: string;
  /** The library's text now. */
  readonly library: string;
  readonly changes: ReadonlyArray<{ readonly op: InstructionAction['op']; readonly key: string }>;
}

/** The setup summary's instructions (PLAN.md §3.17 step 9): what [Finish] writes for each chosen tool. */
export interface InstructionSetupPreview {
  readonly hash: string;
  /** Whether this library's instructions are linked on this device; another company's may be instead. */
  readonly linked: boolean;
  readonly tools: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly method: NonNullable<ResolvedTool['instructions']>['method'] | 'none';
    readonly artifacts: ReadonlyArray<{ readonly key: string; readonly artifact: InstructionRow['artifact'] }>;
  }>;
}

/** What the worker shows as a system notification, translated there. */
export interface InstructionNotice {
  readonly type: 'edited' | 'damaged';
  readonly file: string;
  readonly tools: readonly string[];
}

export interface InstructionServiceDeps {
  readonly engine: InstanceEngine;
  readonly runner: ReconcileRunner;
  readonly store: Store;
  readonly fs: FileSystem;
  readonly trash: InstanceTrash;
  readonly activity: ActivityLog;
  readonly paths: PathFlavour;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly home: string;
  readonly instanceId: string;
  readonly libraryRoot: () => string;
  readonly catalog: () => Catalog;
  readonly toolSettings: () => ToolSettings;
  /** The tools this instance enabled (the link engine's settings). */
  readonly enabled: () => readonly string[];
  readonly snapshot: () => LibrarySnapshot | null;
  readonly repo: Pick<GitRepo, 'state'>;
  /** Whether the company's instructions are linked on this device: device.json, through main. */
  readonly linked: () => boolean;
  /** Runs `fn` holding a device-wide lock (IMPLEMENTATION.md §2.13 rule 8). */
  readonly lock: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  readonly notify: (notice: InstructionNotice) => void;
  /** False while the instance is setting up: nothing outside the library changes before [Finish]. */
  readonly active?: () => boolean;
  /** The effective prefix: the local one when the instance has one (Step 8); else the library's git prefix. */
  readonly prefix?: () => string | null;
}

/** The registry key for the linking the worker last followed, so each change is logged once. */
const LINK_STATE_KIND = 'instruction-linking';
const LINK_STATE_KEY = 'state';

const SEVERITY: Record<InstructionToolView['status'], number> = {
  damaged: 5,
  edited: 4,
  pending: 3,
  linked: 2,
  manual: 1,
  none: 0,
  off: 0,
};

export class InstructionService {
  readonly #deps: InstructionServiceDeps;
  /** Every path the reconciler may work at: wanted and recorded artifacts, the files links lead to. */
  readonly #allowed = new Set<string>();
  #state: InstructionCheckReport['state'] = 'not-ready';

  constructor(deps: InstructionServiceDeps) {
    this.#deps = deps;
    for (const [key, row] of this.#rows()) {
      this.#allowed.add(key);
      this.#allowed.add(row.written);
    }
    const { engine } = deps;
    engine.handle(CheckInstructions, (_input, context) => this.#check(context.signal, (e) => context.emit(e)));
    engine.handle(ResolveInstruction, ({ key, decision, planHash }, context) =>
      this.#resolve(key, decision, planHash, (e) => context.emit(e)),
    );
    engine.handleQuery(InstructionsQuery, () => this.view());
    engine.handleQuery(PreviewInstruction, ({ key, decision }) => this.#preview(key, decision));
  }

  /** What the guarded file system lets the reconciler reach: its exact paths, and the folders they're in. */
  roots(): { entries: string[]; exact: string[] } {
    if (this.#entries === null || this.#entries.length !== this.#allowed.size) {
      this.#entries = [...this.#allowed];
      const { paths } = this.#deps;
      this.#folders = [...new Set(this.#entries.map((path) => paths.dirname(path)))];
    }
    return { entries: this.#entries, exact: this.#folders };
  }

  #entries: string[] | null = null;
  #folders: string[] = [];

  /**
   * Removing the instance (PLAN.md §3.8 S12, A7.13): a reconcile to an empty desired state removes its owned files,
   * blocks and OpenCode entry. The user's own text and other instances' blocks stay. Call it inside a command.
   */
  async removeAll(): Promise<number> {
    const inputs = { ...(await this.#inputs()), linked: false };
    const report = await this.#deps.runner.apply(this.#reconciler(), inputs);
    this.#deps.store.write((tx) => tx.registry.delete(LINK_STATE_KIND, LINK_STATE_KEY));
    return report.applied;
  }

  // ---- The check -----------------------------------------------------------------------------------------------

  /** `inOperation`: a relocation's own step, which runs while the checks wait for it (Step 9). */
  async #ready(inOperation = false): Promise<InstructionCheckReport['state']> {
    const { deps } = { deps: this.#deps };
    if (!inOperation && deps.active?.() === false) return 'not-ready';
    const snapshot = deps.snapshot();
    if (!snapshot || !(await deps.fs.lstat(deps.libraryRoot() as AbsPath))) return 'not-ready';
    if (snapshot.compatibility !== 'ok') return 'frozen';
    const repo = await deps.repo.state().catch(() => ({ operation: 'none' as const, busy: false }));
    if (repo.operation !== 'none' || repo.busy) return 'paused';
    return 'done';
  }

  /**
   * Relocation's step 5 (PLAN.md §3.9): the check, with the library at its new place, rewrites the owned files that
   * import the library's file by its path (Claude Code's `@` line). Returns those files, with the tools that read them.
   * Copies and blocks hold the text, not the path: they need nothing.
   */
  async rewriteImports(emit: (event: DomainEvent) => void): Promise<Array<{ path: string; tools: string[] }>> {
    await this.#check(undefined, emit, true);
    return this.#rows()
      .filter(([, row]) => row.artifact === 'owned-file' && row.role === 'import' && row.status === 'linked')
      .map(([key, row]) => ({ path: key, tools: this.#toolNames(row.tools) }));
  }

  /** An instruction check from inside a command, e.g. a durable operation's step (Step 8). */
  checkNow(emit: (event: DomainEvent) => void): Promise<InstructionCheckReport> {
    return this.#check(undefined, emit);
  }

  async #check(
    signal: AbortSignal | undefined,
    emit: (event: DomainEvent) => void,
    inOperation = false,
  ): Promise<InstructionCheckReport> {
    const state = await this.#ready(inOperation);
    if (state !== 'done') return this.#report(state, 0, emit);
    this.#logLinking();
    const before = this.#waitingKeys();
    const inputs = await this.#inputs();
    const reconciler = this.#reconciler();
    const plan = await this.#deps.runner.plan(reconciler, inputs);
    let applied = 0;
    if (plan.actions.length > 0) {
      const report = await this.#deps.runner.apply(this.#reconciler(), inputs, {
        expectedHash: plan.hash,
        ...(signal ? { signal } : {}),
      });
      applied = report.applied;
    }
    this.#notifyNew(before);
    return this.#report('done', applied, emit);
  }

  /** instructions-linked / instructions-unlinked, once per change of the device's choice (PLAN.md §3.12). */
  #logLinking(): void {
    const { store, clock, activity } = this.#deps;
    const linked = this.#deps.linked();
    const seen = store.read((tx) => tx.registry.get(LINK_STATE_KIND, LINK_STATE_KEY))?.data as
      { linked?: unknown } | undefined;
    // An instance that was never linked keeps no state: "not linked" is where every instance starts.
    if (seen?.linked === linked || (seen === undefined && !linked)) return;
    store.write((tx) => {
      tx.registry.put(LINK_STATE_KIND, LINK_STATE_KEY, { linked }, clock.now());
      activity.appendIn(tx, [
        {
          kind: linked ? 'instructions-linked' : 'instructions-unlinked',
          path: INSTRUCTIONS_FILE,
          details: { tools: this.#toolNames(this.#writableTools()) },
        },
      ]);
    });
  }

  async #resolve(
    key: string,
    decision: InstructionDecision,
    planHash: string,
    emit: (event: DomainEvent) => void,
  ): Promise<InstructionCheckReport> {
    const row = this.#checkDecision(key, decision);
    const state = await this.#ready();
    if (state !== 'done') throw new AppError('instructions.paused', { state });
    const inputs = await this.#inputs();
    const reconciler = this.#reconciler({ decisions: { [key]: decision }, only: [key] });
    const plan = await this.#deps.runner.plan(reconciler, inputs);
    if (plan.hash !== planHash) throw new AppError('plan.changed', { kind: INSTRUCTION_KIND });
    const report = await this.#deps.runner.apply(reconciler, inputs, { expectedHash: planHash });
    this.#deps.activity.append([
      {
        kind: decision === 'bring-in' ? 'brought-in' : 'discarded',
        path: INSTRUCTIONS_FILE,
        details: { file: key, tools: this.#toolNames(row.tools) },
      },
    ]);
    // A change brought in is the library's text now: the other tools' copies follow it at once.
    const after = decision === 'bring-in' ? await this.#check(undefined, emit) : null;
    return after ?? this.#report('done', report.applied, emit);
  }

  #checkDecision(key: string, decision: InstructionDecision): InstructionRow {
    const row = this.#row(key);
    if (!row || row.status !== 'edited' || (decision === 'bring-in' && row.role !== 'copy')) {
      throw new AppError('instructions.noChange', { path: key });
    }
    return row;
  }

  async #preview(key: string, decision: InstructionDecision): Promise<InstructionPreview> {
    const row = this.#checkDecision(key, decision);
    const inputs = await this.#inputs();
    const plan = await this.#deps.runner.plan(
      this.#reconciler({ decisions: { [key]: decision }, only: [key] }),
      inputs,
    );
    const { fs } = this.#deps;
    const text =
      (await fs.lstat(row.written as AbsPath))?.kind === 'file' ? await fs.readText(row.written as AbsPath) : '';
    const span = row.artifact === 'block' ? findBlock(text, this.#deps.instanceId) : null;
    const edited = span === null ? text : span.kind === 'found' ? span.inside : '';
    return {
      hash: plan.hash,
      key,
      decision,
      edited,
      library: inputs.libraryText ?? '',
      changes: plan.actions.map((action) => ({ op: action.op, key: action.key })),
    };
  }

  #report(
    state: InstructionCheckReport['state'],
    applied: number,
    emit: (event: DomainEvent) => void,
  ): InstructionCheckReport {
    const changed = state !== this.#state || applied > 0;
    this.#state = state;
    if (changed || state === 'done')
      emit({ type: 'InstructionsChanged', at: this.#deps.clock.now() } satisfies InstructionsChanged);
    return { state, applied, waiting: this.#waitingKeys().size };
  }

  #waitingKeys(): Map<string, InstructionStatus> {
    return new Map(
      this.#rows()
        .filter(([, row]) => row.status !== 'linked')
        .map(([key, row]) => [key, row.status]),
    );
  }

  /** One notification for each artifact that starts to wait for the user. */
  #notifyNew(before: ReadonlyMap<string, InstructionStatus>): void {
    for (const [key, row] of this.#rows()) {
      if (row.status === 'linked' || before.get(key) === row.status) continue;
      this.#deps.notify({ type: row.status, file: key, tools: this.#toolNames(row.tools) });
    }
  }

  // ---- Inputs --------------------------------------------------------------------------------------------------

  #reconciler(scope: { decisions?: Record<string, InstructionDecision>; only?: string[] } = {}) {
    const { fs, paths, trash, lock } = this.#deps;
    return instructionReconciler(
      {
        fs,
        paths,
        trash,
        locked: (file, fn) => lock(`instructions:${paths.name === 'win32' ? file.toLowerCase() : file}`, fn),
        allow: (path) => this.#allowed.add(path),
      },
      scope,
    );
  }

  #resolved(): ResolvedTool[] {
    return resolveTools(this.#deps.catalog(), this.#deps.home, this.#deps.toolSettings(), this.#deps.paths);
  }

  /** `enabled`: the tools a setup chose, before they're the instance's settings (Step 15). */
  #enabled(enabled: readonly string[] = this.#deps.enabled()): string[] {
    const known = new Set(this.#resolved().map((tool) => tool.id));
    return enabled.filter((id) => known.has(id));
  }

  /** The enabled tools whose instructions the app writes. */
  #writableTools(): string[] {
    return this.#resolved()
      .filter((tool) => this.#enabled().includes(tool.id) && tool.instructions && tool.instructions.method !== 'manual')
      .map((tool) => tool.id);
  }

  #toolNames(ids: readonly string[]): string[] {
    const names = new Map(this.#resolved().map((tool) => [tool.id, tool.name]));
    return ids.map((id) => names.get(id) ?? id).sort();
  }

  #libraryFile(): string | null {
    const snapshot = this.#deps.snapshot();
    if (!snapshot?.instructions) return null;
    return this.#deps.paths.join(this.#deps.libraryRoot(), ...INSTRUCTIONS_FILE.split('/'));
  }

  async #libraryText(): Promise<string | null> {
    const file = this.#libraryFile();
    if (file === null) return null;
    const entry = await this.#deps.fs.lstat(file as AbsPath);
    return entry?.kind === 'file' ? this.#deps.fs.readText(file as AbsPath) : null;
  }

  /**
   * What decides where a strategy writes (PLAN.md §3.12): whether Codex's override file has text of its own, whether
   * OpenCode's AGENTS.md exists, and where this instance's OpenCode entry is already used. Only those paths are read.
   */
  async #facts(tools: readonly ResolvedTool[], enabled: readonly string[]): Promise<InstructionFacts> {
    const { fs, paths } = this.#deps;
    const on = new Set(enabled);
    const overridesWithText: string[] = [];
    const existing: string[] = [];
    const allow = (path: string) => this.#allowed.add(path);
    for (const tool of tools) {
      const how = tool.instructions;
      if (!on.has(tool.id) || !how) continue;
      if (how.override) {
        allow(how.override);
        const at = await followLinks(fs, paths, how.override, allow);
        if (at.kind === 'file' && hasOwnText(await fs.readText(at.written as AbsPath)))
          overridesWithText.push(how.override);
      }
      if (how.configEntry) {
        allow(how.path);
        allow(how.configEntry);
        const at = await followLinks(fs, paths, how.path, allow);
        if (at.kind === 'file') existing.push(how.path);
      }
    }
    const entriesInUse = this.#rows()
      .filter(([, row]) => row.artifact === 'config-entry')
      .map(([key]) => key);
    return { overridesWithText, existing, entriesInUse };
  }

  async #inputs(chosen?: readonly string[]): Promise<InstructionInputs> {
    const tools = this.#resolved();
    const enabled = this.#enabled(chosen);
    const libraryText = await this.#libraryText();
    const inputs: InstructionInputs = {
      linked: this.#deps.linked(),
      instance: this.#deps.instanceId,
      // The effective prefix names the owned files and the blocks' markers (PLAN.md §3.3): the local one when set.
      prefix: this.#deps.prefix?.() ?? this.#deps.snapshot()?.config.prefix ?? '',
      libraryFile: libraryText === null ? null : this.#libraryFile(),
      libraryText,
      tools,
      enabled,
      facts: NO_FACTS,
    };
    const withFacts = { ...inputs, facts: await this.#facts(tools, enabled) };
    // The prefix names the owned files: without one, nothing is written (the library isn't set up, PLAN.md §3.2).
    const ready = withFacts.prefix === '' ? { ...withFacts, linked: false } : withFacts;
    for (const desired of desiredInstructions(ready, this.#deps.paths)) this.#allowed.add(desired.key);
    return ready;
  }

  #rows(): Array<[string, InstructionRow]> {
    return this.#deps.store
      .read((tx) => tx.registry.list(INSTRUCTION_KIND))
      .flatMap((record) => {
        const row = readInstructionRow(record);
        return row ? [[record.key, row] as [string, InstructionRow]] : [];
      });
  }

  #row(key: string): InstructionRow | null {
    return readInstructionRow(this.#deps.store.read((tx) => tx.registry.get(INSTRUCTION_KIND, key)));
  }

  // ---- The setup summary (Step 15) -----------------------------------------------------------------------------

  /**
   * What [Finish] writes for the tools a setup chose (PLAN.md §3.17 step 9): each tool's instruction files, and the
   * plan's hash. Nothing changes; [Finish] checks the same plan again, once the tools are the instance's settings.
   */
  async previewSetup(enabled: readonly string[]): Promise<InstructionSetupPreview> {
    const inputs = await this.#inputs(enabled);
    const plan = await this.#deps.runner.plan(this.#reconciler(), inputs);
    const desired = desiredInstructions(inputs, this.#deps.paths);
    const tools = this.#resolved().filter((tool) => inputs.enabled.includes(tool.id));
    return {
      hash: plan.hash,
      linked: inputs.linked,
      tools: tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        method: tool.instructions?.method ?? 'none',
        artifacts: desired
          .filter((d) => d.tools.includes(tool.id))
          .map((d) => ({ key: d.key, artifact: d.artifact }))
          .sort((a, b) => (a.key < b.key ? -1 : 1)),
      })),
    };
  }

  // ---- The view ------------------------------------------------------------------------------------------------

  /** The Instructions page's part for this instance, and the Doctor's room left (PLAN.md §3.12). */
  async view(): Promise<InstructionsState> {
    const { paths } = this.#deps;
    const tools = this.#resolved();
    const enabled = this.#enabled();
    const snapshot = this.#deps.snapshot();
    const inputs = await this.#inputs();
    const desired = desiredInstructions(inputs, paths);
    const rows = new Map(this.#rows());
    const artifactView = (key: string): InstructionArtifactView => {
      const row = rows.get(key);
      return {
        key,
        written: row?.written ?? key,
        artifact: row?.artifact ?? desired.find((d) => d.key === key)?.artifact ?? 'owned-file',
        role: row?.role ?? desired.find((d) => d.key === key)?.role ?? 'copy',
        status: row?.status ?? 'pending',
        since: row?.since ?? null,
      };
    };
    const { manual } = manualTools(tools, enabled);
    const views: InstructionToolView[] = [];
    for (const tool of tools.filter((t) => enabled.includes(t.id))) {
      const how = tool.instructions;
      const keys = [
        ...new Set([
          ...desired.filter((d) => d.tools.includes(tool.id)).map((d) => d.key),
          ...[...rows].filter(([, row]) => row.tools.includes(tool.id)).map(([key]) => key),
        ]),
      ].sort();
      const artifacts = keys.map(artifactView);
      const status: InstructionToolView['status'] = !how
        ? 'none'
        : how.method === 'manual'
          ? 'manual'
          : artifacts.length === 0
            ? 'off'
            : artifacts.reduce<InstructionToolView['status']>(
                (worst, a) => (SEVERITY[a.status] > SEVERITY[worst] ? a.status : worst),
                'linked',
              );
      views.push({
        id: tool.id,
        name: tool.name,
        method: how?.method ?? 'none',
        artifacts,
        status,
        room: how?.limit ? await this.#room(tool, keys) : null,
      });
    }
    const waiting = [...rows].filter(([, row]) => row.status !== 'linked').map(([key]) => artifactView(key));
    return {
      state: this.#state,
      linked: this.#deps.linked(),
      library: snapshot?.instructions ?? null,
      manualText: manual.length > 0 ? inputs.libraryText : null,
      tools: views,
      waiting,
    };
  }

  /** The room left in the file the tool reads: its whole text, every instance's block included. */
  async #room(tool: ResolvedTool, keys: readonly string[]): Promise<RoomLeft | null> {
    const how = tool.instructions;
    if (!how?.limit) return null;
    const { fs, paths } = this.#deps;
    // The file it reads: the one holding the block, or the override file while it has text of its own.
    const file =
      keys.find((key) => paths.same(key, how.path) || (how.override !== null && paths.same(key, how.override))) ??
      how.path;
    this.#allowed.add(file);
    const at = await followLinks(fs, paths, file, (path) => this.#allowed.add(path));
    const text = at.kind === 'file' ? await fs.readText(at.written as AbsPath) : '';
    return roomLeft(tool.id, file, text, how.limit, how.override !== null);
  }

  /** For the worker's log: failures of background checks other than a yield. */
  static quiet(error: unknown): boolean {
    return isAppError(error) && error.code === 'command.cancelled';
  }
}
