// Custom protocols (ADR 0021, IMPLEMENTATION.md §2.8): the renderer loads from app:// instead of file://, and library
// files reach it through the read-only asset:// protocol.
import { net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ASSET_RESPONSE_CSP } from '../../shared/assets.ts';

export const APP_ORIGIN = 'app://renderer';

/** Before the app is ready. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'asset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

const types: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/** Serves the renderer's files from inside the app, with the CSP as a header. */
export function serveRenderer(rendererDir: string, csp: string): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'renderer') return new Response(null, { status: 404 });
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(rendererDir, `.${relative}`);
    if (!file.startsWith(rendererDir + path.sep)) return new Response(null, { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    if (!response.ok) return new Response(null, { status: 404 });
    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}

export function serveAssets(
  read: (url: string) => Promise<{ status: number; bytes?: Uint8Array; mimeType?: string }>,
): void {
  protocol.handle('asset', async (request) => {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const result = await read(request.url);
    if (result.status !== 200 || !result.bytes) return new Response(null, { status: result.status });
    return new Response(result.bytes, {
      status: 200,
      headers: {
        'Content-Type': result.mimeType ?? 'application/octet-stream',
        'Content-Security-Policy': ASSET_RESPONSE_CSP,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
