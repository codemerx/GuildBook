// The asset protocol (IMPLEMENTATION.md §2.8): files from a library reach the renderer as asset://<instance>/<path>.
// Main checks each request like any message and asks that instance's worker, which refuses paths outside its library.
import { InstanceIdSchema } from '@app/schemas';

export type AssetRequest =
  | { readonly ok: true; readonly instanceId: string; readonly segments: readonly string[] }
  | { readonly ok: false; readonly status: 400 | 404; readonly reason: string };

/** Parses asset://lib_…/skills/acme/image.png into an instance and the path segments inside its library. */
export function parseAssetUrl(raw: string): AssetRequest {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, status: 400, reason: 'not a URL' };
  }
  if (url.protocol !== 'asset:') return { ok: false, status: 400, reason: 'not the asset protocol' };
  if (url.username || url.password || url.port || url.search || url.hash) {
    return { ok: false, status: 400, reason: 'unexpected URL parts' };
  }
  const instanceId = url.hostname.toLowerCase();
  if (!InstanceIdSchema.safeParse(instanceId).success) return { ok: false, status: 404, reason: 'unknown instance' };
  const segments: string[] = [];
  for (const encoded of url.pathname.split('/').slice(1)) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return { ok: false, status: 400, reason: 'bad encoding' };
    }
    // After decoding, a segment is one plain name: no separators, no parent references, no drive letters.
    if (segment === '' || segment === '.' || segment === '..' || /[\\/\0:]/.test(segment)) {
      return { ok: false, status: 404, reason: 'not a path inside the library' };
    }
    segments.push(segment);
  }
  if (segments.length === 0) return { ok: false, status: 404, reason: 'no file' };
  return { ok: true, instanceId, segments };
}

export { ASSET_RESPONSE_CSP, mimeTypeFor } from '../shared/assets.ts';
