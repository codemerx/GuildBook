// The recording proxy (TESTING.md §3 "No real network"): everything the app sends goes through it. Requests to
// allowed hosts (the fake hosts) pass; anything else is refused and recorded, which fails the test (A1.8).
import http from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';

export interface ProxyRequest {
  readonly method: string;
  readonly host: string;
  readonly port: number;
  readonly allowed: boolean;
}

export interface RecordingProxy {
  readonly url: string;
  readonly requests: readonly ProxyRequest[];
  /** Requests to hosts that aren't allowed. */
  violations(): ProxyRequest[];
  allow(hostPort: string): void;
  /**
   * Serves a name as another address, e.g. `github.acme.example:443` as `127.0.0.1:53211`: the fake hosts get stable
   * names, as self-hosted servers have, and the app's traffic still reaches only them (TESTING.md §5).
   */
  alias(hostPort: string, target: string): void;
  close(): Promise<void>;
}

export async function startRecordingProxy(options: { allow?: readonly string[] } = {}): Promise<RecordingProxy> {
  const allowed = new Set(options.allow ?? []);
  const aliases = new Map<string, { host: string; port: number }>();
  const requests: ProxyRequest[] = [];
  const sockets = new Set<Socket>();
  const isAllowed = (host: string, port: number) => allowed.has(`${host}:${port}`) || aliases.has(`${host}:${port}`);
  /** Where a connection to host:port really goes. */
  const target = (host: string, port: number) => aliases.get(`${host}:${port}`) ?? { host, port };

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const ok = isAllowed(url.hostname, port);
    requests.push({ method: req.method ?? 'GET', host: url.hostname, port, allowed: ok });
    if (!ok) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('refused by the test proxy\n');
      return;
    }
    const real = target(url.hostname, port);
    const upstream = http.request(
      { host: real.host, port: real.port, method: req.method, path: url.pathname + url.search, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  server.on('connect', (req: http.IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    const [host = '', portText = '443'] = (req.url ?? '').split(':');
    const port = Number(portText);
    const ok = isAllowed(host, port);
    requests.push({ method: 'CONNECT', host, port, allowed: ok });
    if (!ok) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const real = target(host, port);
    const upstream = net.connect(real.port, real.host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    violations: () => requests.filter((r) => !r.allowed),
    allow: (hostPort) => void allowed.add(hostPort),
    alias: (hostPort, to) => {
      const [host = '', port = '443'] = to.split(':');
      aliases.set(hostPort, { host, port: Number(port) });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
