// How a worker talks to its parent before it has ports (IMPLEMENTATION.md §2.1). In the app the parent is main and
// this is Electron's process.parentPort; integration tests run the same worker in a Node thread.
import type { RpcPort } from '@app/ipc';

export interface WorkerMessage {
  readonly data: unknown;
  /** Ports that came with the message, already wrapped for the RPC runtime. */
  readonly ports: readonly RpcPort[];
}

export interface WorkerHost {
  onMessage(listener: (message: WorkerMessage) => void): void;
  /** Ends the process after the logs are flushed. */
  exit(code: number): void;
}
