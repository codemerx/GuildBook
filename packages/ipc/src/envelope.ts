// The messages the runtime exchanges. Every message received is parsed against these first (IMPLEMENTATION.md §2.8).
import { ErrorCodeSchema, ErrorParamsSchema } from '@app/schemas';
import { z } from 'zod';

const Id = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Name = z.string().min(1).max(200);

export const WireErrorSchema = z.object({
  code: ErrorCodeSchema,
  params: ErrorParamsSchema,
  message: z.string().max(10_000).optional(),
});

export const EnvelopeSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('req'),
    id: Id,
    kind: z.enum(['query', 'command']),
    name: Name,
    input: z.unknown(),
    cid: z.string().max(100).optional(),
  }),
  z.object({ t: z.literal('cancel'), id: Id }),
  z.object({ t: z.literal('sub'), name: Name }),
  z.object({ t: z.literal('unsub'), name: Name }),
  z.object({ t: z.literal('res'), id: Id, value: z.unknown() }),
  z.object({ t: z.literal('fail'), id: Id, error: WireErrorSchema }),
  z.object({ t: z.literal('prog'), id: Id, value: z.unknown() }),
  z.object({ t: z.literal('evt'), name: Name, payload: z.unknown() }),
  /** Sent back when a message was rejected and has no request id to answer. */
  z.object({ t: z.literal('err'), error: WireErrorSchema }),
]);

export type Envelope = z.infer<typeof EnvelopeSchema>;
export type WireError = z.infer<typeof WireErrorSchema>;

/** A short, safe description of why a value failed its schema, for typed errors and logs. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
    .slice(0, 500);
}
