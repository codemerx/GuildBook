// The tool catalog's refresh (PLAN.md §3.4 "Keeping the catalog current", ADR 0026): the daily update check downloads
// the published catalog and its detached signature, and saves them in the data folder only when a trusted key signed
// those exact bytes. The workers read the saved file when they start (CatalogLoader), and fall back to the bundled
// catalog when anything is wrong with it. A tampered or unsigned file is never saved.
import { type AbsPath, type FileSystem, isAppError, type Logger } from '@app/core';
import { type CatalogRejection, verifySignedCatalog } from '@app/adapters';
import type { CatalogKey } from '@app/tools';

/** A published catalog is far smaller; anything larger is refused before it's read. */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

export interface FetchedFile {
  readonly status: number;
  readonly bytes: Uint8Array;
}

export interface CatalogRefreshDeps {
  /** Where the catalog is published (release-feed.ts); null when the build has no release feed. */
  readonly url: string | null;
  /** Downloads a file, following redirects (GitHub's release downloads redirect to their storage). */
  readonly fetch: (url: string) => Promise<FetchedFile>;
  readonly fs: FileSystem;
  /** The data folder's catalog folder, which holds the two files. */
  readonly folder: AbsPath;
  readonly file: AbsPath;
  readonly signatureFile: AbsPath;
  readonly keys: readonly CatalogKey[];
  readonly logger: Logger;
}

export type CatalogRefreshResult =
  | { readonly outcome: 'off' }
  | { readonly outcome: 'saved' | 'same' }
  | { readonly outcome: 'rejected'; readonly reason: CatalogRejection }
  | { readonly outcome: 'failed'; readonly message: string };

/**
 * The catalog and the update feed come only over HTTPS, apart from a loopback address: a test's release host (A18.3).
 * The signature, not the connection, is what makes a catalog trusted.
 */
export function allowedReleaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

export class CatalogRefresh {
  readonly #deps: CatalogRefreshDeps;

  constructor(deps: CatalogRefreshDeps) {
    this.#deps = deps;
  }

  async refresh(): Promise<CatalogRefreshResult> {
    const { url, logger } = this.#deps;
    if (url === null) return { outcome: 'off' };
    if (!allowedReleaseUrl(url)) {
      logger.warn('the catalog address is not allowed', { url });
      return { outcome: 'failed', message: 'address not allowed' };
    }
    let catalog: Uint8Array;
    let signature: Uint8Array;
    try {
      catalog = await this.#download(url);
      signature = await this.#download(`${url}.sig`);
    } catch (error) {
      const message = isAppError(error) ? error.code : String(error).slice(0, 300);
      logger.warn('the catalog could not be downloaded', { message });
      return { outcome: 'failed', message };
    }
    const signatureText = new TextDecoder().decode(signature);
    const verified = verifySignedCatalog(catalog, signatureText, this.#deps.keys);
    if (!verified.ok) {
      logger.warn('the downloaded catalog was not saved', { reason: verified.error });
      return { outcome: 'rejected', reason: verified.error };
    }
    if (await this.#unchanged(catalog, signatureText)) return { outcome: 'same' };
    // The catalog first, then its signature: a stop in between leaves a pair that doesn't check out, so the workers
    // use the bundled catalog until the next refresh.
    await this.#deps.fs.mkdirp(this.#deps.folder);
    await this.#deps.fs.writeBytesAtomic(this.#deps.file, catalog);
    await this.#deps.fs.writeTextAtomic(this.#deps.signatureFile, signatureText);
    logger.info('a refreshed tool catalog was saved', { tools: verified.value.tools.length });
    return { outcome: 'saved' };
  }

  async #download(url: string): Promise<Uint8Array> {
    const response = await this.#deps.fetch(url);
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    if (response.bytes.byteLength > MAX_CATALOG_BYTES) throw new Error('too large');
    return response.bytes;
  }

  async #unchanged(catalog: Uint8Array, signature: string): Promise<boolean> {
    try {
      const saved = await this.#deps.fs.readBytes(this.#deps.file);
      const savedSignature = await this.#deps.fs.readText(this.#deps.signatureFile);
      return savedSignature === signature && sameBytes(saved, catalog);
    } catch {
      return false;
    }
  }
}
