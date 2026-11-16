// Identifier formats shared by every process. Instance ids are library ids (`lib_…`, PLAN.md §3.1); the values are
// random, so tests get them from the Random port.
import { z } from 'zod';

export const InstanceIdSchema = z.string().regex(/^lib_[0-9a-z]{4,32}$/, 'not an instance id');
export const DeviceIdSchema = z.string().regex(/^dev_[0-9a-z]{4,32}$/, 'not a device id');
export const OperationIdSchema = z.string().regex(/^op_[0-9a-z]{4,32}$/, 'not an operation id');

/** An ISO 8601 timestamp in UTC, e.g. 2026-01-15T09:00:00.000Z. */
export const TimestampSchema = z.iso.datetime();
