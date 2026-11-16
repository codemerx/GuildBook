// Loading the tool catalog (PLAN.md §3.4, ADR 0026): the catalog bundled with the app, unless a refreshed catalog file
// is present whose signature a trusted key made. The signature covers the file's exact bytes and is checked before the
// file is read. A catalog with a newer schema is ignored until the app is updated (IMPLEMENTATION.md §2.7). Anything
// wrong with the refreshed file falls back to the bundled catalog, and says why.
import { type AbsPath, err, type FileSystem, isAppError, type Logger, ok, type Result } from '@app/core';
import {
  type Catalog,
  CATALOG_SCHEMA_VERSION,
  type CatalogKey,
  CatalogSchema,
  CatalogSignatureSchema,
} from '@app/tools';
import { createPublicKey, verify } from 'node:crypto';

export type CatalogRejection = 'unreadable' | 'unknownKey' | 'badSignature' | 'invalid' | 'newerSchema';

/** Checks a signed catalog file: the signature first, then the content. */
export function verifySignedCatalog(
  bytes: Uint8Array,
  signatureText: string,
  keys: readonly CatalogKey[],
): Result<Catalog, CatalogRejection> {
  let signatureJson: unknown;
  try {
    signatureJson = JSON.parse(signatureText);
  } catch {
    return err('unreadable');
  }
  const signature = CatalogSignatureSchema.safeParse(signatureJson);
  if (!signature.success) return err('unreadable');
  const key = keys.find((candidate) => candidate.id === signature.data.keyId);
  if (!key) return err('unknownKey');
  let valid: boolean;
  try {
    valid = verify(null, bytes, createPublicKey(key.publicKey), Buffer.from(signature.data.signature, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) return err('badSignature');
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return err('invalid');
  }
  const version = (data as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === 'number' && version > CATALOG_SCHEMA_VERSION) return err('newerSchema');
  const parsed = CatalogSchema.safeParse(data);
  return parsed.success ? ok(parsed.data) : err('invalid');
}

export interface CatalogLoaderOptions {
  readonly fs: FileSystem;
  readonly bundled: Catalog;
  /** The refreshed catalog and its signature (`<file>.sig`), e.g. in the app-data folder. */
  readonly file: AbsPath;
  readonly signatureFile: AbsPath;
  readonly keys: readonly CatalogKey[];
  readonly logger?: Logger;
}

export interface LoadedCatalog {
  readonly catalog: Catalog;
  readonly source: 'bundled' | 'refreshed';
  /** Why a refreshed file present wasn't used. */
  readonly rejected: CatalogRejection | null;
}

export class CatalogLoader {
  readonly #options: CatalogLoaderOptions;

  constructor(options: CatalogLoaderOptions) {
    this.#options = options;
  }

  async load(): Promise<Catalog> {
    return (await this.loadWithSource()).catalog;
  }

  async loadWithSource(): Promise<LoadedCatalog> {
    const { fs, bundled, file, signatureFile, keys, logger } = this.#options;
    let bytes: Uint8Array;
    let signature: string;
    try {
      bytes = await fs.readBytes(file);
      signature = await fs.readText(signatureFile);
    } catch (error) {
      if (isAppError(error) && error.code === 'fs.notFound') {
        const present = (await fs.lstat(file)) !== undefined;
        if (present) logger?.warn('refreshed catalog has no signature; using the bundled one');
        return { catalog: bundled, source: 'bundled', rejected: present ? 'unreadable' : null };
      }
      throw error;
    }
    const verified = verifySignedCatalog(bytes, signature, keys);
    if (verified.ok) return { catalog: verified.value, source: 'refreshed', rejected: null };
    logger?.warn('refreshed catalog not used; using the bundled one', { reason: verified.error });
    return { catalog: bundled, source: 'bundled', rejected: verified.error };
  }
}
