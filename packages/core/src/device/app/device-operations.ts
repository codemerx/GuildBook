// Device operations (IMPLEMENTATION.md §2.6, ADR 0009): operations that need main and workers, such as removing an
// instance. Main records the operation in device.json before its first step, so it resumes at the next start
// whichever process crashed. Steps run in main or in the instance's worker, and every step is idempotent.
import type { DeviceOperationRecord, JsonValue } from '@app/schemas';
import type { Clock } from '../../ports/clock.ts';
import type { FaultPoints } from '../../ports/faults.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Random } from '../../ports/random.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import { newOperationId } from '../../shared/ids.ts';
import type { DeviceRegistry } from './device-registry.ts';

export interface DeviceStepContext {
  readonly operation: DeviceOperationRecord;
  readonly registry: DeviceRegistry;
}

export type DeviceOperationStep =
  | { readonly name: string; readonly where: 'main'; run(context: DeviceStepContext): Promise<void> }
  | { readonly name: string; readonly where: 'worker' };

export interface DeviceOperationDef {
  readonly kind: string;
  readonly needsInstance: boolean;
  readonly steps: readonly DeviceOperationStep[];
  /** What the operation reports when it finishes, e.g. for the no-window mode's output. */
  result(context: DeviceStepContext): Promise<JsonValue>;
}

/** How main reaches an instance's worker for its part of an operation. */
export interface DeviceOperationHost {
  runWorkerStep(operation: DeviceOperationRecord, step: string): Promise<void>;
}

export type DeviceOperationOutcome =
  | { readonly id: string; readonly kind: string; readonly status: 'done'; readonly result: JsonValue }
  | {
      readonly id: string;
      readonly kind: string;
      readonly status: 'failed';
      readonly error: { code: string; message: string };
    };

export function deviceOperationFaultPoints(kind: string, step: string) {
  return { before: `device-op:${kind}:${step}:before`, after: `device-op:${kind}:${step}:after` };
}

export class DeviceOperationRunner {
  readonly #registry: DeviceRegistry;
  readonly #host: DeviceOperationHost;
  readonly #faults: FaultPoints;
  readonly #clock: Clock;
  readonly #random: Random;
  readonly #logger: Logger;
  readonly #defs = new Map<string, DeviceOperationDef>();

  constructor(deps: {
    registry: DeviceRegistry;
    host: DeviceOperationHost;
    faults: FaultPoints;
    clock: Clock;
    random: Random;
    logger: Logger;
  }) {
    this.#registry = deps.registry;
    this.#host = deps.host;
    this.#faults = deps.faults;
    this.#clock = deps.clock;
    this.#random = deps.random;
    this.#logger = deps.logger;
  }

  register(def: DeviceOperationDef): void {
    if (this.#defs.has(def.kind)) throw new Error(`device operation ${def.kind} is registered twice`);
    this.#defs.set(def.kind, def);
  }

  get kinds(): string[] {
    return [...this.#defs.keys()];
  }

  async start(
    kind: string,
    options: { instanceId?: string; params?: Readonly<Record<string, JsonValue>> } = {},
  ): Promise<DeviceOperationOutcome> {
    const def = this.#defs.get(kind);
    if (!def) throw new AppError('operation.unknown', { kind });
    if (def.needsInstance && !options.instanceId) throw new AppError('instance.notFound', { kind });
    const record: DeviceOperationRecord = {
      id: newOperationId(this.#random),
      kind,
      instanceId: options.instanceId ?? null,
      nextStep: 0,
      params: { ...options.params },
      startedAt: new Date(this.#clock.now()).toISOString(),
    };
    await this.#registry.update((file) => {
      file.operations.push(record);
    });
    return this.#runFrom(def, record);
  }

  /** Finishes every device operation that was in progress when the app stopped. */
  async resumeAll(): Promise<DeviceOperationOutcome[]> {
    const outcomes: DeviceOperationOutcome[] = [];
    for (const record of [...this.#registry.file.operations]) {
      const def = this.#defs.get(record.kind);
      if (!def) {
        this.#logger.error('device operation of an unknown kind left in device.json', {
          id: record.id,
          kind: record.kind,
        });
        continue;
      }
      this.#logger.info('resuming device operation', { id: record.id, kind: record.kind, step: record.nextStep });
      outcomes.push(await this.#runFrom(def, record));
    }
    return outcomes;
  }

  async #runFrom(def: DeviceOperationDef, start: DeviceOperationRecord): Promise<DeviceOperationOutcome> {
    let record = start;
    try {
      for (const step of def.steps.slice(record.nextStep)) {
        const points = deviceOperationFaultPoints(def.kind, step.name);
        await this.#faults.hit(points.before);
        if (step.where === 'main') await step.run({ operation: record, registry: this.#registry });
        else await this.#host.runWorkerStep(record, step.name);
        await this.#faults.hit(points.after);
        record = { ...record, nextStep: record.nextStep + 1 };
        const saved = record;
        await this.#registry.update((file) => {
          file.operations = file.operations.map((op) => (op.id === saved.id ? saved : op));
        });
      }
      const result = await def.result({ operation: record, registry: this.#registry });
      await this.#registry.update((file) => {
        file.operations = file.operations.filter((op) => op.id !== record.id);
      });
      this.#logger.info('device operation finished', { id: record.id, kind: def.kind });
      return { id: record.id, kind: def.kind, status: 'done', result };
    } catch (error) {
      const code = isAppError(error) ? error.code : 'operation.failed';
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.error('device operation failed; it stays recorded and resumes at the next start', {
        id: record.id,
        kind: def.kind,
        code,
      });
      return { id: record.id, kind: def.kind, status: 'failed', error: { code, message } };
    }
  }
}
