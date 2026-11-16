// The operation runner (IMPLEMENTATION.md §2.6, ADR 0009): multi-step operations that must survive a crash write a
// journal of their steps. Each step is idempotent and checks the state before it acts; at start, unfinished journals
// are resumed from their first unfinished step.
import { type Journal, JournalSchema, type JsonValue } from '@app/schemas';
import type { Clock } from '../../ports/clock.ts';
import type { FaultPoints } from '../../ports/faults.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Random } from '../../ports/random.ts';
import type { AbsPath, OperationId } from '../../shared/brand.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import { newOperationId } from '../../shared/ids.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import {
  failed,
  finished,
  isResumable,
  retried,
  type JsonRecord,
  newJournal,
  operationFaultPoints,
  stepDone,
} from '../domain/journal.ts';

export interface StepContext<P extends JsonRecord, S extends JsonRecord> {
  readonly operationId: OperationId;
  readonly params: P;
  readonly state: S;
}

export interface OperationStep<P extends JsonRecord, S extends JsonRecord> {
  readonly name: string;
  /** Idempotent: checks the state before acting, because a crash makes it run again. Returns values for later steps. */
  run(context: StepContext<P, S>): Promise<Partial<S> | void>;
}

export interface OperationDef<P extends JsonRecord, S extends JsonRecord> {
  readonly kind: string;
  readonly steps: readonly OperationStep<P, S>[];
  initialState(params: P): S;
  /**
   * A failed journal of this kind is tried again at the next start too, from the step that failed: its steps can't be
   * left half done (relocation, Step 9). Other kinds wait for a decision.
   */
  readonly retryFailed?: boolean;
}

export type OperationOutcome =
  | { readonly id: OperationId; readonly kind: string; readonly status: 'done'; readonly state: JsonRecord }
  | {
      readonly id: OperationId;
      readonly kind: string;
      readonly status: 'failed';
      readonly error: { readonly code: string; readonly message: string };
    };

type AnyDef = OperationDef<JsonRecord, JsonRecord>;

export class OperationRunner {
  readonly #fs: FileSystem;
  readonly #paths: PathFlavour;
  readonly #dir: AbsPath;
  readonly #clock: Clock;
  readonly #random: Random;
  readonly #faults: FaultPoints;
  readonly #logger: Logger;
  readonly #defs = new Map<string, AnyDef>();

  constructor(deps: {
    fs: FileSystem;
    paths: PathFlavour;
    journalDir: AbsPath;
    clock: Clock;
    random: Random;
    faults: FaultPoints;
    logger: Logger;
  }) {
    this.#fs = deps.fs;
    this.#paths = deps.paths;
    this.#dir = deps.journalDir;
    this.#clock = deps.clock;
    this.#random = deps.random;
    this.#faults = deps.faults;
    this.#logger = deps.logger;
  }

  register<P extends JsonRecord, S extends JsonRecord>(def: OperationDef<P, S>): void {
    if (this.#defs.has(def.kind)) throw new Error(`operation ${def.kind} is registered twice`);
    if (new Set(def.steps.map((step) => step.name)).size !== def.steps.length) {
      throw new Error(`operation ${def.kind} has two steps with the same name`);
    }
    this.#defs.set(def.kind, def);
  }

  async start<P extends JsonRecord>(kind: string, params: P): Promise<OperationOutcome> {
    const def = this.#defs.get(kind);
    if (!def) throw new AppError('operation.unknown', { kind });
    await this.#fs.mkdirp(this.#dir);
    const journal = newJournal({
      id: newOperationId(this.#random),
      kind,
      params,
      state: def.initialState(params),
      now: this.#now(),
    });
    // The journal exists before the first step, so a crash at any point resumes the operation.
    await this.#save(journal);
    return this.#runFrom(def, journal);
  }

  /** Resumes every operation that was running when the app stopped (IMPLEMENTATION.md §2.6). */
  async resumeAll(): Promise<OperationOutcome[]> {
    const outcomes: OperationOutcome[] = [];
    for (const journal of await this.journals()) {
      const retry = journal.status === 'failed' && this.#defs.get(journal.kind)?.retryFailed === true;
      if (!isResumable(journal) && !retry) continue;
      const def = this.#defs.get(journal.kind);
      if (!def) {
        this.#logger.error('journal of an unknown operation left as it is', { id: journal.id, kind: journal.kind });
        continue;
      }
      this.#logger.info('resuming operation', { id: journal.id, kind: journal.kind, step: journal.nextStep });
      outcomes.push(await this.#runFrom(def, retried(journal)));
    }
    return outcomes;
  }

  /** Runs one unfinished or failed journal again now, from its next step: the user's [Try again]. */
  async resume(id: string): Promise<OperationOutcome> {
    const journal = (await this.journals()).find((j) => j.id === id);
    const def = journal ? this.#defs.get(journal.kind) : undefined;
    if (!journal || !def || journal.status === 'done') throw new AppError('operation.unknown', { kind: id });
    return this.#runFrom(def, retried(journal));
  }

  /** Forgets a failed journal whose operation changed nothing, e.g. a move refused before anything moved. */
  async discard(id: string): Promise<void> {
    const journal = (await this.journals()).find((j) => j.id === id);
    if (!journal) return;
    if (journal.status !== 'failed') throw new AppError('operation.failed', { kind: journal.kind, code: 'running' });
    await this.#fs.remove(this.#file(id));
  }

  /** The journals on disk: unfinished and failed operations. Unreadable or newer ones are skipped and logged. */
  async journals(): Promise<Journal[]> {
    if (!(await this.#fs.lstat(this.#dir))) return [];
    const result: Journal[] = [];
    for (const name of await this.#fs.list(this.#dir)) {
      if (!name.endsWith('.json')) continue;
      const path = this.#paths.join(this.#dir, name) as AbsPath;
      try {
        const raw: unknown = JSON.parse(await this.#fs.readText(path));
        const parsed = JournalSchema.safeParse(raw);
        if (parsed.success) result.push(parsed.data);
        else this.#logger.error('journal left as it is: not readable by this version', { name });
      } catch (error) {
        this.#logger.error('journal left as it is: not valid JSON', { name, error: String(error) });
      }
    }
    return result.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async #runFrom(def: AnyDef, start: Journal): Promise<OperationOutcome> {
    let journal = start;
    const id = journal.id as OperationId;
    for (const step of def.steps.slice(journal.nextStep)) {
      const points = operationFaultPoints(def.kind, step.name);
      try {
        await this.#faults.hit(points.before);
        const patch = await step.run({ operationId: id, params: journal.params, state: journal.state });
        await this.#faults.hit(points.after);
        journal = stepDone(journal, journal.nextStep, (patch ?? {}) as Record<string, JsonValue>, this.#now());
        await this.#save(journal);
      } catch (error) {
        const code = isAppError(error) ? error.code : 'operation.failed';
        const message = error instanceof Error ? error.message : String(error);
        this.#logger.error('operation step failed', { id, kind: def.kind, step: step.name, code });
        journal = failed(journal, { code, message }, this.#now());
        await this.#save(journal);
        return { id, kind: def.kind, status: 'failed', error: { code, message } };
      }
    }
    journal = finished(journal, this.#now());
    await this.#fs.remove(this.#file(journal.id));
    this.#logger.info('operation finished', { id, kind: def.kind });
    return { id, kind: def.kind, status: 'done', state: journal.state };
  }

  #file(id: string): AbsPath {
    // The id names the file: a journal's id is checked by the schema, an id from elsewhere never leaves the folder.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AppError('operation.unknown', { kind: id });
    return this.#paths.join(this.#dir, `${id}.json`) as AbsPath;
  }

  async #save(journal: Journal): Promise<void> {
    await this.#fs.writeTextAtomic(this.#file(journal.id), `${JSON.stringify(journal, null, 2)}\n`);
  }

  #now(): string {
    return new Date(this.#clock.now()).toISOString();
  }
}
