// Random identifiers from the Random port, so tests can make them deterministic (IMPLEMENTATION.md §2.12).
import type { Random } from '../ports/random.ts';
import type { DeviceId, InstanceId, OperationId } from './brand.ts';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 16 random bytes as 32 lowercase hex digits: 128 bits, like a library id (A2 LibraryId). */
export function randomHex(random: Random, bytes = 16): string {
  return [...random.bytes(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A short base-36 token for correlation ids and lock tokens. */
export function randomToken(random: Random, length = 12): string {
  return [...random.bytes(length)].map((b) => alphabet[b % alphabet.length]).join('');
}

export function newInstanceId(random: Random): InstanceId {
  return `lib_${randomHex(random)}` as InstanceId;
}

export function newDeviceId(random: Random): DeviceId {
  return `dev_${randomHex(random)}` as DeviceId;
}

export function newOperationId(random: Random): OperationId {
  return `op_${randomHex(random)}` as OperationId;
}

export function newCorrelationId(random: Random): string {
  return `c_${randomToken(random)}`;
}
