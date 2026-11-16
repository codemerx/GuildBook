// The one transport between processes: MessagePorts (IMPLEMENTATION.md §2.8, ADR 0012). Three kinds of port carry
// the same messages, and each gets a thin adapter so the runtime sees one shape:
// - the renderer's DOM MessagePort
// - Electron's MessagePortMain, in main and in the workers
// - Node's worker_threads MessagePort, in tests

export interface RpcPort {
  postMessage(message: unknown): void;
  /** Adds a listener; returns a function that removes it. */
  onMessage(listener: (message: unknown) => void): () => void;
  /** Called once when the other side is known to be gone. Not every port can tell; the supervisor covers workers. */
  onClose(listener: () => void): () => void;
  close(): void;
}

type Listener<T> = (value: T) => void;

/** A port as the DOM defines it (the renderer). */
export interface DomLikePort {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'close', listener: () => void): void;
  start(): void;
  close(): void;
}

/** Electron's MessagePortMain (main and utility processes): events carry `{ data }`. */
export interface ElectronLikePort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  off(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  off(event: 'close', listener: () => void): unknown;
  start(): void;
  close(): void;
}

/** Node's worker_threads MessagePort (tests): events carry the value itself. */
export interface NodeLikePort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  off(event: 'message', listener: (value: unknown) => void): unknown;
  off(event: 'close', listener: () => void): unknown;
  start?(): void;
  close(): void;
}

function closeOnce(register: (fire: () => void) => void): (listener: () => void) => () => void {
  const listeners = new Set<() => void>();
  let closed = false;
  register(() => {
    if (closed) return;
    closed = true;
    for (const listener of [...listeners]) listener();
  });
  return (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
}

export function domPort(port: DomLikePort): RpcPort {
  const onClose = closeOnce((fire) => port.addEventListener('close', fire));
  port.start();
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener: Listener<unknown>) {
      const handler = (event: { data: unknown }) => listener(event.data);
      port.addEventListener('message', handler);
      return () => port.removeEventListener('message', handler);
    },
    onClose,
    close: () => port.close(),
  };
}

export function electronPort(port: ElectronLikePort): RpcPort {
  const onClose = closeOnce((fire) => port.on('close', fire));
  port.start();
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener: Listener<unknown>) {
      const handler = (event: { data: unknown }) => listener(event.data);
      port.on('message', handler);
      return () => port.off('message', handler);
    },
    onClose,
    close: () => port.close(),
  };
}

export function nodePort(port: NodeLikePort): RpcPort {
  const onClose = closeOnce((fire) => port.on('close', fire));
  port.start?.();
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener: Listener<unknown>) {
      port.on('message', listener);
      return () => port.off('message', listener);
    },
    onClose,
    close: () => port.close(),
  };
}
