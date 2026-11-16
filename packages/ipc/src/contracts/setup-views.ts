// View models of the setup wizard after the download (Step 15, PLAN.md §3.17): its pages, the choices recorded so
// far, and the summary that [Finish] applies. Core's types never cross the port.
import { SetupFolderChoiceSchema, SetupNameChoiceSchema, SetupPageSchema } from '@app/schemas';
import { z } from 'zod';

const Name = z.string().max(300);
const Path = z.string().max(4096);

export const SetupToolViewSchema = z.object({
  id: Name,
  name: Name,
  found: z.boolean(),
  custom: z.boolean(),
  chosen: z.boolean(),
  folder: Path.nullable(),
});

export const SetupRepoViewSchema = z.object({
  id: Name,
  name: Name,
  path: Path,
  remote: Name.nullable(),
  root: Path.nullable(),
  ticked: z.array(Name),
  suggestions: z.array(Name),
});
export type SetupRepoView = z.infer<typeof SetupRepoViewSchema>;

export const SetupTakenNameSchema = z.object({
  dest: Path,
  skill: Name,
  folder: Path,
  reason: Name.nullable(),
  repo: Name.nullable(),
  tools: z.array(Name),
  choice: SetupNameChoiceSchema.nullable(),
  suggestion: Name,
});
export type SetupTakenNameView = z.infer<typeof SetupTakenNameSchema>;

export const SetupWizardViewSchema = z.object({
  intent: z.enum(['join', 'create']),
  page: SetupPageSchema,
  pages: z.array(SetupPageSchema),
  needsUpdate: z.enum(['formatTooNew', 'appTooOld']).nullable(),
  libraryName: Name,
  prefix: Name.nullable(),
  library: z.object({
    skills: z.array(z.object({ skill: Name, tags: z.array(Name) })),
    instructions: z.object({ bytes: z.number().int().nonnegative() }).nullable(),
    suggest: z.record(Name, z.array(Name)),
    repoOnlyTags: z.array(Name),
    unpublished: z.number().int().nonnegative(),
    published: z.boolean(),
  }),
  invite: z.string().max(4096).nullable(),
  tools: z.array(SetupToolViewSchema),
  repos: z.array(SetupRepoViewSchema),
  roots: z.array(Path),
  taken: z.array(SetupTakenNameSchema),
  folders: z.array(SetupFolderChoiceSchema),
});
export type SetupWizardView = z.infer<typeof SetupWizardViewSchema>;

export const SetupSummaryViewSchema = z.object({
  hash: z.string(),
  skills: z.object({
    total: z.number().int().nonnegative(),
    everywhere: z.number().int().nonnegative(),
    inRepos: z.array(z.object({ repos: z.array(Name), tags: z.array(Name), skills: z.array(Name) })),
    nowhere: z.array(Name),
  }),
  instructions: z.object({
    exists: z.boolean(),
    linked: z.boolean(),
    linkedBy: Name.nullable(),
    tools: z.array(
      z.object({
        id: Name,
        name: Name,
        method: z.enum(['import-file', 'owned-file', 'marked-block', 'manual', 'none']),
        artifacts: z.array(z.object({ key: Path, artifact: Name })),
      }),
    ),
  }),
  notInstalled: z.array(z.object({ skill: Name, tools: z.array(Name), why: z.enum(['kept', 'committed', 'taken']) })),
  moved: z.array(z.object({ from: Path, to: Path })),
  overwritten: z.array(Path),
  tools: z.array(Name),
});
export type SetupSummaryView = z.infer<typeof SetupSummaryViewSchema>;

/** An invite link the OS handed to the app (PLAN.md §3.17 step 1): the URL to join, or why it was refused. */
export const InviteViewSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), url: z.string().max(4096), clientId: Name.nullable(), seq: z.number().int() }),
  z.object({ ok: z.literal(false), problem: Name, seq: z.number().int() }),
]);
export type InviteView = z.infer<typeof InviteViewSchema>;
