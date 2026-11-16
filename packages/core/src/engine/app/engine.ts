// The instance engine (IMPLEMENTATION.md §2.4, ADR 0007): every state change of an instance is a command in its
// queue, run one at a time, so no locks are needed inside a worker. Queries run concurrently on committed state.
// Events report what happened.
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Random } from '../../ports/random.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import { type DomainEvent, EventBus } from '../../shared/events.ts';
import { newCorrelationId } from '../../shared/ids.ts';
import { coalesceTarget, nextIndex, shouldPreempt } from '../domain/queue.ts';

/** A command type: its name and whether it's background work that yields to user commands. */
export interface CommandDef<I, O> {
  readonly type: string;
  readonly background: boolean;
  /** Carries the input and output types; never set. */
  readonly types?: { input: I; output: O };
}

export interface QueryDef<I, O> {
  readonly name: string;
  readonly types?: { input: I; output: O };
}

export function defineCommand<I, O>(type: string, options: { background?: boolean } = {}): CommandDef<I, O> {
  return { type, background: options.background ?? false };
}

export function defineQuery<I, O>(name: string): QueryDef<I, O> {
  return { name };
}

export interface Progress {
  readonly done: number;
  readonly total: number;
}

export interface CommandContext {
  /** Aborted when the caller cancels, or when a background command has to yield to a user command. */
  readonly signal: AbortSignal;
  readonly correlationId: string;
  readonly logger: Logger;
  progress(done: number, total: number): void;
  /** Publishes a domain event right away. Commands emit after their transaction committed. */
  emit(event: DomainEvent): void;
}

export type CommandHandler<I, O> = (input: I, context: CommandContext) => Promise<O>;
export type QueryHandler<I, O> = (input: I) => Promise<O> | O;

export type EngineEvent =
  | { readonly type: 'CommandStarted'; readonly at: number; readonly command: string; readonly correlationId: string }
  | {
      readonly type: 'CommandProgressed';
      readonly at: number;
      readonly command: string;
      readonly correlationId: string;
      readonly progress: Progress;
    }
  | {
      readonly type: 'CommandFinished';
      readonly at: number;
      readonly command: string;
      readonly correlationId: string;
      readonly ok: boolean;
    }
  | DomainEvent;

export interface ExecuteOptions {
  readonly signal?: AbortSignal;
  readonly correlationId?: string;
  readonly onProgress?: (progress: Progress) => void;
}

export interface EngineStatus {
  readonly running: {
    readonly command: string;
    readonly correlationId: string;
    readonly progress: Progress | null;
  } | null;
  readonly queued: number;
}

interface Item {
  readonly type: string;
  readonly background: boolean;
  readonly handler: CommandHandler<unknown, unknown>;
  readonly input: unknown;
  readonly correlationId: string;
  readonly onProgress: ((progress: Progress) => void) | undefined;
  readonly settle: { resolve(value: unknown): void; reject(error: unknown): void };
  readonly detachCaller: () => void;
  controller: AbortController;
  preempted: boolean;
  progress: Progress | null;
  readonly promise: Promise<unknown>;
}

export class InstanceEngine {
  readonly events: EventBus<EngineEvent>;
  readonly #clock: Clock;
  readonly #random: Random;
  readonly #logger: Logger;
  readonly #commands = new Map<string, CommandHandler<unknown, unknown>>();
  readonly #queries = new Map<string, QueryHandler<unknown, unknown>>();
  readonly #queue: Item[] = [];
  #running: Item | undefined;
  #idleWaiters: Array<() => void> = [];
  #stopped = false;

  constructor(deps: { clock: Clock; random: Random; logger: Logger }) {
    this.#clock = deps.clock;
    this.#random = deps.random;
    this.#logger = deps.logger;
    this.events = new EventBus((error) => this.#logger.error('event subscriber failed', { error: String(error) }));
  }

  handle<I, O>(def: CommandDef<I, O>, handler: CommandHandler<I, O>): void {
    if (this.#commands.has(def.type)) throw new Error(`command ${def.type} already has a handler`);
    this.#commands.set(def.type, handler as CommandHandler<unknown, unknown>);
  }

  handleQuery<I, O>(def: QueryDef<I, O>, handler: QueryHandler<I, O>): void {
    if (this.#queries.has(def.name)) throw new Error(`query ${def.name} already has a handler`);
    this.#queries.set(def.name, handler as QueryHandler<unknown, unknown>);
  }

  execute<I, O>(def: CommandDef<I, O>, input: I, options: ExecuteOptions = {}): Promise<O> {
    if (this.#stopped)
      return Promise.reject(new AppError('command.cancelled', { command: def.type, reason: 'stopped' }));
    const handler = this.#commands.get(def.type);
    if (!handler) return Promise.reject(new AppError('command.unknown', { command: def.type }));
    if (def.background) {
      const joined = coalesceTarget(def.type, this.#queue);
      if (joined) return joined.promise as Promise<O>;
    }
    if (options.signal?.aborted) {
      return Promise.reject(new AppError('command.cancelled', { command: def.type, reason: 'caller' }));
    }

    let settle!: Item['settle'];
    const promise = new Promise<unknown>((resolve, reject) => (settle = { resolve, reject }));
    const onCallerAbort = () => this.#cancel(item);
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const item: Item = {
      type: def.type,
      background: def.background,
      handler,
      input,
      correlationId: options.correlationId ?? newCorrelationId(this.#random),
      onProgress: options.onProgress,
      settle,
      detachCaller: () => options.signal?.removeEventListener('abort', onCallerAbort),
      controller: new AbortController(),
      preempted: false,
      progress: null,
      promise,
    };
    this.#queue.push(item);
    if (this.#running && shouldPreempt(this.#running, item)) {
      this.#running.preempted = true;
      this.#running.controller.abort(
        new AppError('command.cancelled', { command: this.#running.type, reason: 'preempted' }),
      );
    }
    this.#pump();
    return promise as Promise<O>;
  }

  async query<I, O>(def: QueryDef<I, O>, input: I): Promise<O> {
    const handler = this.#queries.get(def.name);
    if (!handler) throw new AppError('command.unknown', { query: def.name });
    return (await handler(input)) as O;
  }

  get status(): EngineStatus {
    const running = this.#running;
    return {
      running: running
        ? { command: running.type, correlationId: running.correlationId, progress: running.progress }
        : null,
      queued: this.#queue.length,
    };
  }

  /** Resolves once no command runs or waits (TESTING.md §6 waitForIdle). */
  whenIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Cancels waiting commands, asks the running one to stop, and waits for it. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const item of this.#queue.splice(0)) {
      item.detachCaller();
      item.settle.reject(new AppError('command.cancelled', { command: item.type, reason: 'stopped' }));
    }
    const running = this.#running;
    if (running) {
      running.controller.abort(new AppError('command.cancelled', { command: running.type, reason: 'stopped' }));
      await running.promise.catch(() => undefined);
    }
    this.#flushIdle();
  }

  #isIdle(): boolean {
    return this.#running === undefined && this.#queue.length === 0;
  }

  #flushIdle(): void {
    if (!this.#isIdle()) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  #cancel(item: Item): void {
    const index = this.#queue.indexOf(item);
    if (index >= 0) {
      this.#queue.splice(index, 1);
      item.settle.reject(new AppError('command.cancelled', { command: item.type, reason: 'caller' }));
      this.#flushIdle();
      return;
    }
    if (this.#running === item) {
      item.controller.abort(new AppError('command.cancelled', { command: item.type, reason: 'caller' }));
    }
  }

  #pump(): void {
    if (this.#running || this.#stopped) return;
    const index = nextIndex(this.#queue);
    if (index < 0) {
      this.#flushIdle();
      return;
    }
    const [item] = this.#queue.splice(index, 1);
    if (item) void this.#run(item);
  }

  async #run(item: Item): Promise<void> {
    this.#running = item;
    const logger = this.#logger.child({ command: item.type, correlationId: item.correlationId });
    this.events.emit({
      type: 'CommandStarted',
      at: this.#clock.now(),
      command: item.type,
      correlationId: item.correlationId,
    });
    let ok = false;
    try {
      const value = await item.handler(item.input, {
        signal: item.controller.signal,
        correlationId: item.correlationId,
        logger,
        progress: (done, total) => {
          item.progress = { done, total };
          item.onProgress?.(item.progress);
          this.events.emit({
            type: 'CommandProgressed',
            at: this.#clock.now(),
            command: item.type,
            correlationId: item.correlationId,
            progress: item.progress,
          });
        },
        emit: (event) => this.events.emit(event),
      });
      ok = true;
      item.detachCaller();
      item.settle.resolve(value);
    } catch (error) {
      if (item.preempted && item.controller.signal.aborted && !this.#stopped) {
        // A background command that yielded to a user command runs again afterwards (IMPLEMENTATION.md §2.4).
        logger.debug('background command yielded; it runs again after the user command');
        item.controller = new AbortController();
        item.preempted = false;
        item.progress = null;
        this.#queue.push(item);
      } else {
        if (!isAppError(error)) logger.error('command failed with a bug', { error: describeError(error) });
        else logger.warn('command failed', { code: error.code });
        item.detachCaller();
        item.settle.reject(error);
      }
    } finally {
      this.#running = undefined;
      this.events.emit({
        type: 'CommandFinished',
        at: this.#clock.now(),
        command: item.type,
        correlationId: item.correlationId,
        ok,
      });
      this.#pump();
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
