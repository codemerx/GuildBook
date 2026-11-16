// The workers' HTTP client for host APIs (IMPLEMENTATION.md §2.9, ADR 0015): HTTPS only, through the proxy main
// resolves for each URL (a CONNECT tunnel), trusting the same certificate bundle as git. In test mode it refuses to
// send anything without the recording proxy, so the proxy's allow-list applies to every request (TESTING.md §3).
// Failures become AppErrors: offline, certificate, or a request that failed for another reason.
import { AppError } from '@app/core';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface HttpNetwork {
  readonly proxy: string | null;
  /** A PEM file: the OS trust store plus the extra certificates; null uses Node's own store. */
  readonly caBundle: string | null;
}

export interface NodeHttpClientOptions {
  readonly network: (url: string) => Promise<HttpNetwork>;
  /** Test mode: every request must go through the proxy. */
  readonly requireProxy?: boolean;
  readonly timeoutMs?: number;
}

const MAX_BODY = 5 * 1024 * 1024;

const offlineCodes = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);
const certificateCodes = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** What a network error means for the user. */
export function classifyNetworkError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && certificateCodes.has(code)) return new AppError('host.certificate', { code });
  if (typeof code === 'string' && offlineCodes.has(code)) return new AppError('host.offline', { code });
  if ((error as { name?: unknown } | null)?.name === 'AbortError') return new AppError('command.cancelled');
  return new AppError('host.requestFailed', { message: String(error).slice(0, 300) });
}

export class NodeHttpClient implements HttpClient {
  readonly #options: NodeHttpClientOptions;

  constructor(options: NodeHttpClientOptions) {
    this.#options = options;
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') throw new AppError('url.notAllowed', { url: url.origin });
    const network = await this.#options.network(url.origin);
    if (this.#options.requireProxy && !network.proxy) {
      throw new AppError('host.requestFailed', { message: 'test mode sends nothing without the test proxy' });
    }
    const ca = network.caBundle ? await readFile(network.caBundle, 'utf8') : undefined;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port || 443);
    try {
      const socket = network.proxy ? await tunnel(network.proxy, host, port, request.signal) : undefined;
      return await send(url, request, { host, port, ca, socket, timeoutMs: this.#options.timeoutMs ?? 30_000 });
    } catch (error) {
      throw classifyNetworkError(error);
    }
  }
}

/** Opens a CONNECT tunnel through an HTTP proxy. */
function tunnel(proxy: string, host: string, port: number, signal: AbortSignal | undefined): Promise<net.Socket> {
  const proxyUrl = new URL(proxy);
  return new Promise((resolve, reject) => {
    const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    const connect = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port || 80),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
      ...(signal ? { signal } : {}),
    });
    connect.once('connect', (response, socket) => {
      if (response.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(
          new AppError('host.requestFailed', { status: response.statusCode ?? 0, message: 'refused by the proxy' }),
        );
      }
    });
    connect.once('error', reject);
    connect.end();
  });
}

function send(
  url: URL,
  request: HttpRequest,
  target: { host: string; port: number; ca: string | undefined; socket: net.Socket | undefined; timeoutMs: number },
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    // SNI takes host names only, never IP addresses.
    const servername = net.isIP(target.host) ? undefined : target.host;
    const options: https.RequestOptions = {
      host: target.host,
      port: target.port,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: {
        'user-agent': 'desktop-app',
        accept: 'application/json',
        ...request.headers,
        ...(request.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(request.body)) }),
      },
      ...(target.ca === undefined ? {} : { ca: target.ca }),
      ...(servername === undefined ? {} : { servername }),
      ...(request.signal ? { signal: request.signal } : {}),
      timeout: target.timeoutMs,
      // So the Host header leaves out :443, as browsers and git send it (without an agent, Node can't tell).
      defaultPort: 443,
    };
    if (target.socket) {
      // Without an agent, so Node uses this connection: through the proxy's tunnel. (An agent, even a fresh one from
      // `agent: false`, would ignore it and connect directly.)
      const socket = target.socket;
      options.createConnection = () =>
        tls.connect({
          socket,
          ...(servername === undefined ? {} : { servername }),
          ...(target.ca === undefined ? {} : { ca: target.ca }),
        });
    } else {
      options.agent = false;
    }
    const req = https.request(options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          req.destroy(new AppError('host.requestFailed', { message: 'response too large' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
        }
        resolve({ status: response.statusCode ?? 0, headers, text: Buffer.concat(chunks).toString('utf8') });
      });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}

/** Parses a JSON body, or fails as a request whose answer can't be read. */
export function jsonBody(response: HttpResponse): unknown {
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new AppError('host.requestFailed', { status: response.status, message: 'the answer is not JSON' });
  }
}

/** A form body, as OAuth endpoints take it. */
export function formBody(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString();
}
