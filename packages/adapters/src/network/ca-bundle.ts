// The certificate bundle git and the HTTP client trust (ADR 0015): the public roots, the OS trust store and the "extra
// certificates" setting. Tests use only the setting, never the machine's trust store (TESTING.md §3).
import tls from 'node:tls';

export function caBundle(options: {
  includeSystem: boolean;
  /** Live tests (ADR 0033): the public roots, so github.com is trusted, without the machine's own trust store. */
  includePublicRoots?: boolean;
  extra: readonly string[];
}): string {
  // On macOS, Node's 'system' list holds only the certificates added to the keychains, not the roots macOS comes with,
  // so github.com's root isn't in it. Node's own copy of Mozilla's public roots ('bundled') covers those.
  const system = options.includeSystem ? [...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')] : [];
  const publicRoots = options.includePublicRoots && !options.includeSystem ? tls.getCACertificates('bundled') : [];
  const all = [...system, ...publicRoots, ...options.extra].map((pem) => pem.trim()).filter((pem) => pem.length > 0);
  const unique = [...new Set(all)];
  return unique.length === 0 ? '' : `${unique.join('\n')}\n`;
}

/** Whether a text holds at least one PEM certificate. */
export function looksLikePem(text: string): boolean {
  return /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.test(text);
}
