// Reading host JSON without trusting it: every field is checked where it's used, and a missing required field fails
// as a request whose answer can't be read (ADR 0016: text from hosts is untrusted).
import { AppError, type HostTokens } from '@app/core';

export type JsonRecord = Readonly<Record<string, unknown>>;

export function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function field(body: JsonRecord, key: string): unknown {
  return Object.hasOwn(body, key) ? body[key] : undefined;
}

export function stringField(body: JsonRecord, key: string): string {
  const value = field(body, key);
  if (typeof value !== 'string' || value === '') {
    throw new AppError('host.requestFailed', { message: `the answer has no ${key}` });
  }
  return value;
}

export function numberField(body: JsonRecord, key: string): number | undefined {
  const value = field(body, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The OAuth `error` of an answer, if it has one. */
export function oauthError(body: JsonRecord): string | undefined {
  const error = field(body, 'error');
  return typeof error === 'string' ? error : undefined;
}

/** An OAuth token answer: the access token, the refresh token and when the access token expires. */
export function tokensFrom(body: JsonRecord, now: number): HostTokens {
  const refresh = field(body, 'refresh_token');
  const expiresIn = numberField(body, 'expires_in');
  return {
    accessToken: stringField(body, 'access_token'),
    refreshToken: typeof refresh === 'string' && refresh !== '' ? refresh : null,
    expiresAt: expiresIn === undefined ? null : now + expiresIn * 1000,
  };
}

/** A date in the host's ISO format as epoch milliseconds; 0 when it's missing or unreadable. */
export function dateField(body: JsonRecord, key: string): number {
  const value = field(body, key);
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** A text field that may be missing or null (a request without a description). */
export function textField(body: JsonRecord, key: string): string {
  const value = field(body, key);
  return typeof value === 'string' ? value : '';
}

/** A nested object's string field, e.g. `user.login`; null when it isn't there. */
export function nestedString(body: JsonRecord, key: string, inner: string): string | null {
  const value = field(record(field(body, key) ?? {}), inner);
  return typeof value === 'string' && value !== '' ? value : null;
}

/** JSON when it is JSON; an error page isn't. */
export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
