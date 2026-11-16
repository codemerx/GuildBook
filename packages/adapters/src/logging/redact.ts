// Secrets never reach a log (IMPLEMENTATION.md §2.12): values under secret-sounding keys are dropped, and anything
// that looks like a token, a key or credentials in a URL is masked wherever it appears.

const secretKey =
  /(token|secret|password|passphrase|authorization|cookie|private[-_]?key|api[-_]?key|credential|extraheader)/i;

const patterns: RegExp[] = [
  // Authorization headers, also inside git's http.<url>.extraHeader values
  /(authorization\s*[:=]\s*)(basic|bearer|token)?\s*[A-Za-z0-9._~+/=-]+/gi,
  // GitHub tokens (classic, fine-grained, OAuth, app, refresh), GitLab tokens
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|gloas-[A-Za-z0-9_-]{20,})\b/g,
  // Credentials in URLs: https://user:password@host
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
  // PEM private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = '[redacted]';

export function redactText(text: string): string {
  let out = text;
  out = out.replace(patterns[0] as RegExp, (_m, prefix: string) => `${prefix}${REDACTED}`);
  out = out.replace(patterns[1] as RegExp, REDACTED);
  out = out.replace(patterns[2] as RegExp, (_m, scheme: string) => `${scheme}${REDACTED}@`);
  out = out.replace(patterns[3] as RegExp, REDACTED);
  return out;
}

/** A copy of `value` with secrets removed; cycles and depth are cut, so logging never throws. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value) || depth > 6) return '[…]';
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = secretKey.test(key) ? REDACTED : redact(inner, depth + 1, seen);
  }
  return out;
}
