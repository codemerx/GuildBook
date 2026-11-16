// Operational failures: typed codes with parameters, mapped to translated messages in the renderer (ADR 0020).
import type { ErrorCode, ErrorParams } from '@app/schemas';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly params: ErrorParams;

  constructor(code: ErrorCode, params: ErrorParams = {}, message?: string) {
    super(message ?? describe(code, params));
    this.name = 'AppError';
    this.code = code;
    this.params = params;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

function describe(code: ErrorCode, params: ErrorParams): string {
  const details = Object.entries(params)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  return details ? `${code} (${details})` : code;
}
