// View models of Step 14 (PLAN.md §3.2 "Locking"): the library's prefix card with its lock, the warning of a prefix
// change, a new git prefix as this device sees it (the pull preview's local-prefix question, and a change that waits
// in "Needs attention"), and the result of a change. Core's types never cross the port.
import { z } from 'zod';
import { LocalPrefixCheckSchema, LocalPrefixClashSchema } from './projection-views.ts';

const Name = z.string().min(1).max(200);
const Prefix = z.string().max(100);

export const PrefixActionSchema = z.enum(['correct', 'change']);
export const PrefixRefusalSchema = z.enum(['push-needed', 'admin-needed']);

/** A change that waits for a local prefix: the new git prefix clashes on this device. */
export const PrefixWaitingSchema = z.object({ from: Prefix, to: Prefix, since: z.number() });

/** The library's prefix card. */
export const PrefixStateViewSchema = z.object({
  prefix: Prefix.nullable(),
  locked: z.boolean(),
  action: PrefixActionSchema,
  refusal: PrefixRefusalSchema.nullable(),
  skills: z.number().int().nonnegative(),
  waiting: PrefixWaitingSchema.nullable(),
});
export type PrefixStateView = z.infer<typeof PrefixStateViewSchema>;

/** A new git prefix on this device (PLAN.md §3.2 step 3): a clash, the local prefix kept, and the answer typed. */
export const PrefixCheckViewSchema = z.object({
  gitPrefix: Prefix,
  clash: LocalPrefixClashSchema.nullable(),
  localPrefix: Prefix.nullable(),
  suggestion: Prefix.nullable(),
  answer: LocalPrefixCheckSchema.nullable(),
});
export type PrefixCheckView = z.infer<typeof PrefixCheckViewSchema>;

export const PrefixAdoptViewSchema = PrefixCheckViewSchema.extend({ hash: z.string().max(200) });
export type PrefixAdoptView = z.infer<typeof PrefixAdoptViewSchema>;

/** The pull preview's part when the pull brings another git prefix. */
export const PullPrefixViewSchema = PrefixCheckViewSchema.extend({ from: Prefix, dropOffered: z.boolean() });
export type PullPrefixView = z.infer<typeof PullPrefixViewSchema>;

export const PrefixBlockerSchema = z.enum(['changes', 'branch', 'incoming', 'toPush', 'operation']);

/** The warning before a prefix change (PLAN.md §3.2 step 1). */
export const PrefixChangePreviewViewSchema = z.object({
  from: Prefix,
  prefix: Prefix,
  action: PrefixActionSchema,
  refusal: PrefixRefusalSchema.nullable(),
  problem: z
    .discriminatedUnion('code', [
      z.object({ code: z.literal('rules'), problem: z.string().max(100) }),
      z.object({ code: z.literal('same') }),
    ])
    .nullable(),
  warnings: z.array(z.string().max(100)),
  renames: z.array(z.object({ from: Name, to: z.string().max(300) })),
  untouched: z.array(Name),
  renameProblems: z.array(
    z.object({ skill: Name, name: z.string().max(300), code: z.enum(['tooLong', 'invalid', 'taken']) }),
  ),
  mentions: z.array(
    z.object({
      skill: Name.nullable(),
      path: z.string().min(1).max(4096),
      line: z.number().int().positive(),
      name: Name,
      text: z.string().max(400),
    }),
  ),
  requests: z.array(
    z.object({
      title: z.string().max(1000),
      author: z.string().max(300),
      branch: z.string().max(300),
    }),
  ),
  blockers: z.array(PrefixBlockerSchema),
  device: PrefixCheckViewSchema.nullable(),
  hash: z.string().max(200),
});
export type PrefixChangePreviewView = z.infer<typeof PrefixChangePreviewViewSchema>;
