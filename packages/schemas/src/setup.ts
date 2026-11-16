// The onboarding wizard's state after the download (IMPLEMENTATION.md §2.1, Step 4): the instance is *setting up*
// until [Finish], and its database keeps where the wizard is and the choices made so far, so a restart reopens it
// there (PLAN.md §3.17 "If the app closes during setup"). The choices are only recorded: [Finish] carries them out.
import { z } from 'zod';
import { HostAccountSchema } from './host.ts';

export const SetupIntentSchema = z.enum(['join', 'create']);
export type SetupIntent = z.infer<typeof SetupIntentSchema>;

/**
 * The wizard's pages after the download (PLAN.md §3.17). An Admin's new library first gets its content (import,
 * instructions, tags) and its first version pushed, then the invite link; both wizards then continue with the tools.
 */
export const SETUP_PAGES = {
  create: ['import', 'instructions', 'tags', 'publish', 'tools', 'repos', 'names', 'summary'],
  join: ['tools', 'repos', 'names', 'summary'],
} as const;

export const SetupPageSchema = z.enum([
  'import',
  'instructions',
  'tags',
  'publish',
  'tools',
  'repos',
  'names',
  'summary',
  'needsUpdate',
]);
export type SetupPage = z.infer<typeof SetupPageSchema>;

const FolderPath = z.string().min(1).max(4096);
const Name = z.string().min(1).max(64);

/** An answer on the name check (PLAN.md §3.17 step 8): S2's choices. */
export const SetupNameChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('move-aside'), name: Name }),
  z.object({ kind: z.literal('overwrite') }),
  z.object({ kind: z.literal('suppress') }),
]);
export type SetupNameChoice = z.infer<typeof SetupNameChoiceSchema>;

/**
 * The user's own folder that starts with the library's prefix (PLAN.md §3.17 step 5), kept or moved to a new name
 * in the same folder. A kept folder with a company skill's exact name comes up again on the name check.
 */
export const SetupFolderChoiceSchema = z.object({
  path: FolderPath,
  choice: z.enum(['keep', 'move']),
  /** The new name, for a move. */
  name: Name.nullable(),
});
export type SetupFolderChoice = z.infer<typeof SetupFolderChoiceSchema>;

export const SetupStateSchema = z.object({
  intent: SetupIntentSchema,
  /** Where the wizard is. Step 4's `finish` page is the first page after the download now. */
  page: z.preprocess((page) => (page === 'finish' ? 'tools' : page), SetupPageSchema),
  /** Why an update is needed, while the page is needsUpdate. */
  needsUpdate: z.enum(['formatTooNew', 'appTooOld']).nullable(),
  /** The tools chosen on the tools page; null until the user chose (the tools found are ticked). */
  tools: z.array(z.string().min(1).max(100)).max(200).nullable().default(null),
  /** The tags ticked on the repos page, by repo id: rules recorded, applied at [Finish]. */
  tags: z
    .array(z.object({ repo: z.string().min(1).max(200), tag: z.string().min(1).max(100) }))
    .max(5000)
    .default([]),
  /** The name check's answers, by link path. */
  names: z.record(FolderPath, SetupNameChoiceSchema).default({}),
  /** The prefix check's answers for the user's own folders (step 5). */
  folders: z.array(SetupFolderChoiceSchema).max(1000).default([]),
});
export type SetupState = z.infer<typeof SetupStateSchema>;

/** What the pending worker hands to the instance's own worker when the download is complete (no secrets). */
export const SetupHandoffSchema = z.object({
  intent: SetupIntentSchema,
  account: HostAccountSchema,
  needsUpdate: z.enum(['formatTooNew', 'appTooOld']).nullable(),
  /** The prefix check's answers for the user's own folders, made before the download was complete (Step 15). */
  folders: z.array(SetupFolderChoiceSchema).max(1000).default([]),
});
export type SetupHandoff = z.infer<typeof SetupHandoffSchema>;
