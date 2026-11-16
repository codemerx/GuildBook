// What main and the workers agree on for the asset protocol (IMPLEMENTATION.md §2.8).

const mimeTypes: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

export function mimeTypeFor(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return mimeTypes[extension] ?? 'application/octet-stream';
}

/** Responses carry their own strict CSP: an SVG opened by itself can't run scripts. */
export const ASSET_RESPONSE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
