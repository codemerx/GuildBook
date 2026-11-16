// The journal of a durable operation, in <data folder>/journal/<id>.json (IMPLEMENTATION.md §2.6, §2.7).
import { z } from 'zod';
import { ErrorCodeSchema } from './errors.ts';
import { OperationIdSchema, TimestampSchema } from './ids.ts';

export const JOURNAL_VERSION = 1;

export const JournalSchema = z.object({
  schemaVersion: z.literal(1),
  id: OperationIdSchema,
  kind: z.string(),
  status: z.enum(['running', 'done', 'failed']),
  /** The first step not known to be finished. A crash re-runs it, so every step is idempotent. */
  nextStep: z.number().int().nonnegative(),
  params: z.record(z.string(), z.json()),
  /** Values one step leaves for the next ones. */
  state: z.record(z.string(), z.json()),
  startedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  error: z.object({ code: ErrorCodeSchema, message: z.string() }).nullable(),
});

export type Journal = z.infer<typeof JournalSchema>;
export type JsonValue = z.infer<ReturnType<typeof z.json>>;
