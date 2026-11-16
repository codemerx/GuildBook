// The renderer's ports (IMPLEMENTATION.md §2.8): one to main for the device API, and one per instance worker. They
// arrive through the preload; a new port for an instance (its worker restarted) replaces the old one, and everything
// cached for that instance is invalidated.
import {
  type Client,
  deviceApi,
  type DeviceApi,
  domPort,
  instanceApi,
  type InstanceApi,
  RpcEndpoint,
  type RpcPort,
} from '@app/ipc';
import { PAGE_HELLO, PORT_CHANNEL, type PortDescription } from '../../shared/ports-protocol.ts';

type Listener = () => void;

interface InstanceConnection {
  readonly generation: number;
  readonly endpoint: RpcEndpoint;
  readonly client: Client<InstanceApi>;
  readonly port: RpcPort;
}

export class Connection {
  #device: { endpoint: RpcEndpoint; client: Client<DeviceApi> } | undefined;
  readonly #instances = new Map<string, InstanceConnection>();
  readonly #deviceWaiters: Array<(client: Client<DeviceApi>) => void> = [];
  readonly #instanceWaiters = new Map<string, Array<(client: Client<InstanceApi>) => void>>();
  readonly #onDevice = new Set<(client: Client<DeviceApi>) => void>();
  readonly #onInstance = new Set<(instanceId: string, client: Client<InstanceApi>) => void>();
  readonly #listeners = new Set<Listener>();

  /** Starts listening for ports and asks main for them. */
  start(target: Window = window): void {
    target.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.source !== target) return;
      const data = event.data as { type?: unknown; port?: PortDescription } | null;
      const port = event.ports[0];
      if (data?.type !== PORT_CHANNEL || !data.port || !port) return;
      this.accept(data.port, port);
    });
    target.postMessage({ type: PAGE_HELLO }, '*');
  }

  accept(description: PortDescription, raw: MessagePort): void {
    const port = domPort(raw);
    const endpoint = new RpcEndpoint(port, {
      onError: (report) => {
        // Rejected messages are bugs: report them to main's log if we can.
        void this.#device?.client.command
          .reportRendererError({ message: `${report.code}: ${report.message}` })
          .catch(() => undefined);
      },
    });
    if (description.kind === 'device') {
      this.#device?.endpoint.dispose('rpc.disconnected');
      const client = endpoint.connect(deviceApi);
      this.#device = { endpoint, client };
      for (const resolve of this.#deviceWaiters.splice(0)) resolve(client);
      for (const listener of this.#onDevice) listener(client);
    } else {
      const current = this.#instances.get(description.instanceId);
      if (current && current.generation >= description.generation) {
        endpoint.dispose('rpc.disconnected');
        return;
      }
      current?.endpoint.dispose('rpc.disconnected');
      const client = endpoint.connect(instanceApi);
      this.#instances.set(description.instanceId, { generation: description.generation, endpoint, client, port });
      for (const resolve of this.#instanceWaiters.get(description.instanceId)?.splice(0) ?? []) resolve(client);
      for (const listener of this.#onInstance) listener(description.instanceId, client);
    }
    for (const listener of this.#listeners) listener();
  }

  device(): Promise<Client<DeviceApi>> {
    if (this.#device) return Promise.resolve(this.#device.client);
    return new Promise((resolve) => this.#deviceWaiters.push(resolve));
  }

  instance(instanceId: string): Promise<Client<InstanceApi>> {
    const current = this.#instances.get(instanceId);
    if (current) return Promise.resolve(current.client);
    return new Promise((resolve) => {
      const waiters = this.#instanceWaiters.get(instanceId) ?? [];
      waiters.push(resolve);
      this.#instanceWaiters.set(instanceId, waiters);
    });
  }

  /** Runs for every device connection, the current one included. */
  onDevice(listener: (client: Client<DeviceApi>) => void): () => void {
    this.#onDevice.add(listener);
    if (this.#device) listener(this.#device.client);
    return () => this.#onDevice.delete(listener);
  }

  /** Runs for every new instance connection: a first one, or one after its worker restarted. */
  onInstance(listener: (instanceId: string, client: Client<InstanceApi>) => void): () => void {
    this.#onInstance.add(listener);
    for (const [id, connection] of this.#instances) listener(id, connection.client);
    return () => this.#onInstance.delete(listener);
  }

  /** Test builds only: the raw port to an instance, for the RPC security journeys (A1.5). */
  rawPort(instanceId: string): RpcPort | undefined {
    return this.#instances.get(instanceId)?.port;
  }
}

export const connection = new Connection();
