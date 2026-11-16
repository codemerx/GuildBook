// Contracts: each API lists its queries, commands and events with zod schemas (IMPLEMENTATION.md §2.8). The
// receiver of every message validates it against these.
import type { z } from 'zod';

export interface QueryDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly kind: 'query';
  readonly input: I;
  readonly output: O;
}

export interface CommandDef<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
  P extends z.ZodType | undefined = z.ZodType | undefined,
> {
  readonly kind: 'command';
  readonly input: I;
  readonly output: O;
  readonly progress: P;
}

export interface ApiDef<
  Q extends Record<string, QueryDef> = Record<string, QueryDef>,
  C extends Record<string, CommandDef> = Record<string, CommandDef>,
  E extends Record<string, z.ZodType> = Record<string, z.ZodType>,
> {
  readonly queries: Q;
  readonly commands: C;
  readonly events: E;
}

export function api<
  Q extends Record<string, QueryDef>,
  C extends Record<string, CommandDef>,
  E extends Record<string, z.ZodType>,
>(def: { queries: Q; commands: C; events: E }): ApiDef<Q, C, E> {
  return def;
}

export function query<I extends z.ZodType, O extends z.ZodType>(input: I, output: O): QueryDef<I, O> {
  return { kind: 'query', input, output };
}

export function command<I extends z.ZodType, O extends z.ZodType>(input: I, output: O): CommandDef<I, O, undefined>;
export function command<I extends z.ZodType, O extends z.ZodType, P extends z.ZodType>(
  input: I,
  output: O,
  options: { progress: P },
): CommandDef<I, O, P>;
export function command<I extends z.ZodType, O extends z.ZodType, P extends z.ZodType>(
  input: I,
  output: O,
  options?: { progress: P },
): CommandDef<I, O, P | undefined> {
  return { kind: 'command', input, output, progress: options?.progress };
}

export interface HandlerContext {
  /** Aborted when the caller cancels, or the connection closes. */
  readonly signal: AbortSignal;
  /** The caller's correlation id, carried into logs (IMPLEMENTATION.md §2.12). */
  readonly correlationId: string | undefined;
}

export interface CommandContext<P> extends HandlerContext {
  progress(value: P): void;
}

type ProgressOf<D extends CommandDef> = D['progress'] extends z.ZodType ? z.input<D['progress']> : never;
type ProgressOutputOf<D extends CommandDef> = D['progress'] extends z.ZodType ? z.output<D['progress']> : never;

export type QueryHandler<D extends QueryDef> = (
  input: z.output<D['input']>,
  context: HandlerContext,
) => Promise<z.input<D['output']>> | z.input<D['output']>;

export type CommandHandler<D extends CommandDef> = (
  input: z.output<D['input']>,
  context: CommandContext<ProgressOf<D>>,
) => Promise<z.input<D['output']>> | z.input<D['output']>;

export interface Handlers<A extends ApiDef> {
  queries: { [K in keyof A['queries']]: QueryHandler<A['queries'][K]> };
  commands: { [K in keyof A['commands']]: CommandHandler<A['commands'][K]> };
}

export interface CallOptions {
  signal?: AbortSignal;
  correlationId?: string;
}

export interface CommandCallOptions<P> extends CallOptions {
  onProgress?: (value: P) => void;
}

export interface Client<A extends ApiDef> {
  query: {
    [K in keyof A['queries']]: (
      input: z.input<A['queries'][K]['input']>,
      options?: CallOptions,
    ) => Promise<z.output<A['queries'][K]['output']>>;
  };
  command: {
    [K in keyof A['commands']]: (
      input: z.input<A['commands'][K]['input']>,
      options?: CommandCallOptions<ProgressOutputOf<A['commands'][K]>>,
    ) => Promise<z.output<A['commands'][K]['output']>>;
  };
  /** Subscribes to an event; returns a function that unsubscribes. */
  on<K extends keyof A['events'] & string>(name: K, handler: (payload: z.output<A['events'][K]>) => void): () => void;
}

export type EventPayload<A extends ApiDef, K extends keyof A['events']> = z.input<A['events'][K]>;
