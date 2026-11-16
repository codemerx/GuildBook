// Typed errors that cross process boundaries (IMPLEMENTATION.md §2.8, §2.12).
import { type ErrorCode, type ErrorParams, isErrorCode } from '@app/schemas';

export class RpcError extends Error {
  readonly code: ErrorCode;
  readonly params: ErrorParams;

  constructor(code: ErrorCode, params: ErrorParams = {}, message?: string) {
    super(message ?? code);
    this.name = 'RpcError';
    this.code = code;
    this.params = params;
  }
}

/** Anything with a known error code and plain parameters, such as core's AppError, crosses as itself. */
export function toWireError(error: unknown): { code: ErrorCode; params: ErrorParams; message: string } {
  if (typeof error === 'object' && error !== null && 'code' in error && isErrorCode(error.code)) {
    const params = 'params' in error && isPlainParams(error.params) ? error.params : {};
    const message = error instanceof Error ? error.message : String(error.code);
    return { code: error.code, params, message };
  }
  if (error instanceof Error && error.name === 'AbortError')
    return { code: 'rpc.cancelled', params: {}, message: error.message };
  return { code: 'internal', params: {}, message: error instanceof Error ? error.message : String(error) };
}

function isPlainParams(value: unknown): value is ErrorParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
}
