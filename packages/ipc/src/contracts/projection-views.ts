// View models of Step 8 (PLAN.md §3.3): the local-prefix page of the setup wizard, the library's local prefix and its
// change dialog, and the both-changed dialog of a projected copy. Core's types never cross the port.
import { SetupFolderChoiceSchema } from '@app/schemas';
import { z } from 'zod';

const Name = z.string().min(1).max(200);
const Prefix = z.string().max(100);
const Path = z.string().min(1).max(4096);

export const LocalPrefixProblemSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('rules'), problem: z.string().max(100) }),
  z.object({ code: z.literal('git-prefix') }),
  z.object({ code: z.literal('instance'), name: Name }),
  z.object({ code: z.literal('folders') }),
]);
export type LocalPrefixProblemView = z.infer<typeof LocalPrefixProblemSchema>;

export const LocalPrefixClashSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('instance'), name: Name }),
  z.object({ kind: z.literal('folders') }),
]);

export const LocalPrefixCheckSchema = z.object({
  prefix: Prefix,
  problem: LocalPrefixProblemSchema.nullable(),
  tooLong: z.array(Name),
  shorter: Prefix.nullable(),
});
export type LocalPrefixCheckView = z.infer<typeof LocalPrefixCheckSchema>;

/** The setup wizard's local-prefix page (PLAN.md §3.3 step 1). */
export const LocalPrefixPageSchema = z.object({
  gitPrefix: Prefix,
  clash: LocalPrefixClashSchema,
  suggestion: Prefix.nullable(),
  skills: z.number().int().nonnegative(),
  check: LocalPrefixCheckSchema.nullable(),
  chosen: Prefix.nullable(),
  /** The user's own folders that start with the git prefix (PLAN.md §3.17 step 5): each can be moved or kept. */
  folders: z.array(z.string().max(4096)).max(1000),
  folderChoices: z.array(SetupFolderChoiceSchema).nullable(),
});
export type LocalPrefixPageView = z.infer<typeof LocalPrefixPageSchema>;

/** A library's local prefix on this device (PLAN.md §3.3 "Lifecycle"). */
export const LocalPrefixViewSchema = z.object({
  gitPrefix: Prefix.nullable(),
  localPrefix: Prefix.nullable(),
  clash: LocalPrefixClashSchema.nullable(),
  skipped: z.array(
    z.object({ skill: Name, reason: z.enum(['too-long', 'wrong-prefix']), name: z.string().max(300).nullable() }),
  ),
  conflicts: z.number().int().nonnegative(),
  copies: z.number().int().nonnegative(),
});
export type LocalPrefixView = z.infer<typeof LocalPrefixViewSchema>;

export const LocalPrefixPreviewSchema = z.object({
  prefix: Prefix.nullable(),
  problem: LocalPrefixProblemSchema.nullable(),
  tooLong: z.array(Name),
  shorter: Prefix.nullable(),
  suggestion: Prefix.nullable(),
  hash: z.string().max(200),
});
export type LocalPrefixPreviewView = z.infer<typeof LocalPrefixPreviewSchema>;

export const CopyDecisionSchema = z.enum(['library', 'copy']);

/** The both-changed dialog (PLAN.md §3.3): which files differ, with their text on each side. */
export const CopyConflictViewSchema = z.object({
  key: Path,
  skill: Name,
  name: Name,
  files: z.array(
    z.object({
      path: z.string().min(1).max(4096),
      change: z.enum(['added', 'removed', 'changed']),
      library: z.string().max(300_000).nullable(),
      copy: z.string().max(300_000).nullable(),
    }),
  ),
  hash: z.string().max(200),
});
export type CopyConflictView = z.infer<typeof CopyConflictViewSchema>;
