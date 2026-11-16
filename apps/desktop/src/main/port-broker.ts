// The port broker (IMPLEMENTATION.md §2.1, §2.8): main creates every channel and hands one end to each side. The
// renderer gets one port to main (the device API) and one port per running worker (that instance's API). A worker
// that restarts gets a new port, whose higher generation tells the renderer to replace the old one.
import { type Handlers, RpcEndpoint, type RpcPort, deviceApi, type DeviceApi, type Server } from '@app/ipc';
import type { Logger } from '@app/core';

/** What the renderer is told about a port it receives. */
export type PortMeta =
  { readonly kind: 'device' } | { readonly kind: 'instance'; readonly instanceId: string; readonly generation: number };

export interface Channel {
  /** Main's end, when main talks on it. */
  readonly mine: RpcPort;
  /** The raw end handed to the other side. */
  readonly theirs: unknown;
  /** Both raw ends, when main hands each to someone else. */
  readonly raw: readonly [unknown, unknown];
}

export interface BrokerDeps {
  readonly createChannel: () => Channel;
  readonly logger: Logger;
  readonly deviceHandlers: () => Handlers<DeviceApi>;
  /** Hands a port to the renderer, if there is one. */
  readonly sendToRenderer: (meta: PortMeta, port: unknown) => boolean;
  /** Hands a port to a worker; false when it isn't running. */
  readonly sendToWorker: (instanceId: string, generation: number, port: unknown) => boolean;
  /** The workers that can take a renderer port now. */
  readonly runningWorkers: () => ReadonlyArray<{ instanceId: string; generation: number }>;
}

export class PortBroker {
  readonly #deps: BrokerDeps;
  #device: { endpoint: RpcEndpoint; server: Server<DeviceApi> } | undefined;
  readonly #sent = new Map<string, number>();

  constructor(deps: BrokerDeps) {
    this.#deps = deps;
  }

  /** The renderer (re)loaded: fresh ports for the device API and every running worker. */
  connectRenderer(): void {
    this.#device?.endpoint.dispose('rpc.disconnected');
    const channel = this.#deps.createChannel();
    const endpoint = new RpcEndpoint(channel.mine, {
      onError: (report) =>
        this.#deps.logger.warn('renderer port problem', { code: report.code, message: report.message }),
    });
    const server = endpoint.serve(deviceApi, this.#deps.deviceHandlers());
    this.#device = { endpoint, server };
    this.#sent.clear();
    if (!this.#deps.sendToRenderer({ kind: 'device' }, channel.theirs)) return;
    for (const worker of this.#deps.runningWorkers()) this.connectInstance(worker.instanceId, worker.generation);
  }

  /** A worker is running: connect it to the renderer, once per generation. */
  connectInstance(instanceId: string, generation: number): void {
    if (!this.#device || this.#sent.get(instanceId) === generation) return;
    const channel = this.#deps.createChannel();
    const [forWorker, forRenderer] = channel.raw;
    if (!this.#deps.sendToWorker(instanceId, generation, forWorker)) return;
    if (!this.#deps.sendToRenderer({ kind: 'instance', instanceId, generation }, forRenderer)) return;
    this.#sent.set(instanceId, generation);
  }

  /** The device API's event emitter, for instancesChanged and settingsChanged. */
  get device(): Server<DeviceApi> | undefined {
    return this.#device?.server;
  }

  disconnectRenderer(): void {
    this.#device?.endpoint.dispose('rpc.disconnected');
    this.#device = undefined;
    this.#sent.clear();
  }
}
