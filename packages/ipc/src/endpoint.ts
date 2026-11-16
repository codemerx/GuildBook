// The RPC runtime: request ids, typed errors, progress, cancellation and event subscriptions over one port
// (IMPLEMENTATION.md §2.8, ADR 0012). One endpoint per port can serve APIs and call APIs on the other side at once,
// e.g. a worker serves the worker API to main and calls main's device services over the same port.
import type { ErrorCode } from '@app/schemas';
import type { z } from 'zod';
import type {
  ApiDef,
  CallOptions,
  Client,
  CommandCallOptions,
  CommandDef,
  EventPayload,
  Handlers,
  QueryDef,
} from './contract.ts';
import { describeIssues, type Envelope, EnvelopeSchema, type WireError } from './envelope.ts';
import { RpcError, toWireError } from './errors.ts';
import type { RpcPort } from './port.ts';

export interface EndpointOptions {
  /** Reports rejected messages and handler failures, for logging. Must not throw. */
  onError?: (report: { code: ErrorCode; message: string; cause?: unknown }) => void;
}

export interface Server<A extends ApiDef> {
  /** Sends an event to the other side, if it subscribed to it. */
  emit<K extends keyof A['events'] & string>(name: K, payload: EventPayload<A, K>): void;
}

type Method =
  | { kind: 'query'; def: QueryDef; handler: (input: unknown, ctx: unknown) => unknown }
  | {
      kind: 'command';
      def: CommandDef;
      handler: (input: unknown, ctx: unknown) => unknown;
    };

interface Pending {
  output: z.ZodType;
  progress: z.ZodType | undefined;
  onProgress: ((value: unknown) => void) | undefined;
  resolve(value: unknown): void;
  reject(error: RpcError): void;
  cleanup(): void;
}

export class RpcEndpoint {
  readonly #port: RpcPort;
  readonly #options: EndpointOptions;
  readonly #methods = new Map<string, Method>();
  readonly #events = new Map<string, z.ZodType>();
  readonly #subscribedByPeer = new Set<string>();
  readonly #inflight = new Map<number, AbortController>();
  readonly #pending = new Map<number, Pending>();
  readonly #clientEvents = new Map<string, { schema: z.ZodType; handlers: Set<(payload: unknown) => void> }>();
  readonly #unsubscribe: Array<() => void> = [];
  #nextId = 1;
  #disposed: ErrorCode | undefined;

  constructor(port: RpcPort, options: EndpointOptions = {}) {
    this.#port = port;
    this.#options = options;
    this.#unsubscribe.push(port.onMessage((message) => this.#receive(message)));
    this.#unsubscribe.push(port.onClose(() => this.dispose('rpc.disconnected')));
  }

  get disposed(): boolean {
    return this.#disposed !== undefined;
  }

  serve<A extends ApiDef>(api: A, handlers: Handlers<A>): Server<A> {
    for (const [name, def] of Object.entries(api.queries)) {
      this.#addMethod(`query:${name}`, {
        kind: 'query',
        def,
        handler: (handlers.queries as Record<string, Method['handler']>)[name] ?? missingHandler(name),
      });
    }
    for (const [name, def] of Object.entries(api.commands)) {
      this.#addMethod(`command:${name}`, {
        kind: 'command',
        def,
        handler: (handlers.commands as Record<string, Method['handler']>)[name] ?? missingHandler(name),
      });
    }
    for (const [name, schema] of Object.entries(api.events)) {
      if (this.#events.has(name)) throw new Error(`event ${name} is served twice on one port`);
      this.#events.set(name, schema);
    }
    return {
      emit: (name, payload) => {
        if (!api.events[name]) throw new Error(`unknown event ${name}`);
        if (this.#disposed || !this.#subscribedByPeer.has(name)) return;
        this.#post({ t: 'evt', name, payload });
      },
    };
  }

  connect<A extends ApiDef>(api: A): Client<A> {
    const queries: Record<string, (input: unknown, options?: CallOptions) => Promise<unknown>> = {};
    for (const [name, def] of Object.entries(api.queries)) {
      queries[name] = (input, options) => this.#call('query', name, def.output, undefined, input, options);
    }
    const commands: Record<string, (input: unknown, options?: CommandCallOptions<unknown>) => Promise<unknown>> = {};
    for (const [name, def] of Object.entries(api.commands)) {
      commands[name] = (input, options) => this.#call('command', name, def.output, def.progress, input, options);
    }
    const on = (name: string, handler: (payload: unknown) => void): (() => void) => {
      const schema = api.events[name];
      if (!schema) throw new Error(`unknown event ${name}`);
      let entry = this.#clientEvents.get(name);
      if (!entry) {
        entry = { schema, handlers: new Set() };
        this.#clientEvents.set(name, entry);
      }
      entry.handlers.add(handler);
      if (entry.handlers.size === 1) this.#post({ t: 'sub', name });
      return () => {
        const current = this.#clientEvents.get(name);
        if (!current?.handlers.delete(handler)) return;
        if (current.handlers.size === 0) {
          this.#clientEvents.delete(name);
          this.#post({ t: 'unsub', name });
        }
      };
    };
    return { query: queries, command: commands, on } as unknown as Client<A>;
  }

  /** Rejects every pending call, aborts every running handler and stops listening. */
  dispose(code: ErrorCode = 'rpc.disconnected'): void {
    if (this.#disposed) return;
    this.#disposed = code;
    for (const remove of this.#unsubscribe) remove();
    for (const controller of this.#inflight.values()) controller.abort(new RpcError(code));
    this.#inflight.clear();
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const call of pending) {
      call.cleanup();
      call.reject(new RpcError(code));
    }
  }

  #addMethod(key: string, method: Method): void {
    if (this.#methods.has(key)) throw new Error(`${key} is served twice on one port`);
    this.#methods.set(key, method);
  }

  #post(message: Envelope): void {
    if (this.#disposed) return;
    try {
      this.#port.postMessage(message);
    } catch (cause) {
      // A value that can't be cloned is a bug in the sender; report it instead of crashing the process.
      this.#report('internal', 'postMessage failed', cause);
    }
  }

  #report(code: ErrorCode, message: string, cause?: unknown): void {
    try {
      this.#options.onError?.({ code, message, cause });
    } catch {
      // Logging must never break the runtime.
    }
  }

  #call(
    kind: 'query' | 'command',
    name: string,
    output: z.ZodType,
    progress: z.ZodType | undefined,
    input: unknown,
    options: CommandCallOptions<unknown> = {},
  ): Promise<unknown> {
    if (this.#disposed) return Promise.reject(new RpcError(this.#disposed));
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(new RpcError('rpc.cancelled'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.#pending.delete(id)) return;
        this.#post({ t: 'cancel', id });
        reject(new RpcError('rpc.cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        output,
        progress,
        onProgress: options.onProgress,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
      this.#post({
        t: 'req',
        id,
        kind,
        name,
        input,
        ...(options.correlationId === undefined ? {} : { cid: options.correlationId }),
      });
    });
  }

  #receive(raw: unknown): void {
    if (this.#disposed) return;
    const parsed = EnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      const error: WireError = {
        code: 'rpc.invalidMessage',
        params: { reason: describeIssues(parsed.error) },
      };
      this.#report('rpc.invalidMessage', `rejected message: ${error.params.reason}`);
      const id = requestIdOf(raw);
      this.#post(id === undefined ? { t: 'err', error } : { t: 'fail', id, error });
      return;
    }
    const message = parsed.data;
    switch (message.t) {
      case 'req':
        void this.#handleRequest(message);
        return;
      case 'cancel':
        this.#inflight.get(message.id)?.abort(new RpcError('rpc.cancelled'));
        return;
      case 'sub':
      case 'unsub':
        if (!this.#events.has(message.name)) {
          this.#post({ t: 'err', error: { code: 'rpc.unknownMethod', params: { name: message.name } } });
          return;
        }
        if (message.t === 'sub') this.#subscribedByPeer.add(message.name);
        else this.#subscribedByPeer.delete(message.name);
        return;
      case 'res':
      case 'fail':
        this.#settle(message);
        return;
      case 'prog': {
        const call = this.#pending.get(message.id);
        if (!call?.progress || !call.onProgress) return;
        const value = call.progress.safeParse(message.value);
        if (value.success) call.onProgress(value.data);
        else this.#report('rpc.invalidMessage', `invalid progress: ${describeIssues(value.error)}`);
        return;
      }
      case 'evt': {
        const entry = this.#clientEvents.get(message.name);
        if (!entry) return;
        const payload = entry.schema.safeParse(message.payload);
        if (!payload.success) {
          this.#report('rpc.invalidMessage', `invalid event ${message.name}: ${describeIssues(payload.error)}`);
          return;
        }
        for (const handler of [...entry.handlers]) handler(payload.data);
        return;
      }
      case 'err':
        this.#report(
          message.error.code,
          `the other side rejected a message: ${message.error.message ?? message.error.code}`,
        );
        return;
    }
  }

  #settle(message: Extract<Envelope, { t: 'res' | 'fail' }>): void {
    const call = this.#pending.get(message.id);
    if (!call) return;
    this.#pending.delete(message.id);
    call.cleanup();
    if (message.t === 'fail') {
      call.reject(new RpcError(message.error.code, message.error.params, message.error.message));
      return;
    }
    const value = call.output.safeParse(message.value);
    if (value.success) call.resolve(value.data);
    else call.reject(new RpcError('rpc.invalidOutput', { reason: describeIssues(value.error) }));
  }

  async #handleRequest(message: Extract<Envelope, { t: 'req' }>): Promise<void> {
    const method = this.#methods.get(`${message.kind}:${message.name}`);
    if (!method) {
      this.#post({ t: 'fail', id: message.id, error: { code: 'rpc.unknownMethod', params: { name: message.name } } });
      return;
    }
    const input = method.def.input.safeParse(message.input);
    if (!input.success) {
      this.#post({
        t: 'fail',
        id: message.id,
        error: { code: 'rpc.invalidInput', params: { name: message.name, reason: describeIssues(input.error) } },
      });
      return;
    }
    const controller = new AbortController();
    this.#inflight.set(message.id, controller);
    const progressSchema = method.kind === 'command' ? method.def.progress : undefined;
    const context = {
      signal: controller.signal,
      correlationId: message.cid,
      progress: (value: unknown) => {
        if (progressSchema && !controller.signal.aborted) this.#post({ t: 'prog', id: message.id, value });
      },
    };
    try {
      const value = await method.handler(input.data, context);
      if (this.#inflight.delete(message.id)) this.#post({ t: 'res', id: message.id, value });
    } catch (cause) {
      const wasRunning = this.#inflight.delete(message.id);
      const error = controller.signal.aborted ? toWireError(new RpcError('rpc.cancelled')) : toWireError(cause);
      if (error.code === 'internal') this.#report('internal', `${message.kind} ${message.name} failed`, cause);
      if (wasRunning) this.#post({ t: 'fail', id: message.id, error });
    }
  }
}

function missingHandler(name: string): Method['handler'] {
  return () => {
    throw new Error(`no handler for ${name}`);
  };
}

function requestIdOf(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null || !('id' in raw)) return undefined;
  const id = raw.id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

/**
 * Calls a handler in the same process with the same validation as a remote call: used where the caller isn't on a
 * port, such as the test API that Playwright reaches through main.
 */
export async function invokeLocal<A extends ApiDef>(
  api: A,
  handlers: Handlers<A>,
  kind: 'query' | 'command',
  name: string,
  rawInput: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<unknown> {
  const def = kind === 'query' ? api.queries[name] : api.commands[name];
  const table = (kind === 'query' ? handlers.queries : handlers.commands) as Record<
    string,
    Method['handler'] | undefined
  >;
  const handler = table[name];
  if (!def || !handler) throw new RpcError('rpc.unknownMethod', { name });
  const input = def.input.safeParse(rawInput);
  if (!input.success) throw new RpcError('rpc.invalidInput', { name, reason: describeIssues(input.error) });
  const value = await handler(input.data, { signal, correlationId: undefined, progress: () => {} });
  const output = def.output.safeParse(value);
  if (!output.success) throw new RpcError('rpc.invalidOutput', { name, reason: describeIssues(output.error) });
  return output.data;
}
