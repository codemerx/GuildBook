// Main ↔ a setup's pending worker (IMPLEMENTATION.md §2.1, Step 4). A pending worker has no data folder and no
// database: it signs in, checks the folder, downloads into the temporary folder main recorded, and for a new library
// writes and pushes the first commit. Main forwards the wizard's calls from the renderer here, and records the
// instance once the worker hands the library over.
import { GitIdentitySchema, SetupFolderChoiceSchema, SetupHandoffSchema } from '@app/schemas';
import { z } from 'zod';
import { api, command, query } from '../contract.ts';
import { SetupViewSchema } from './views.ts';

const Empty = z.object({});

export const SignInRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device'), clientId: z.string().trim().max(200).nullable().optional() }),
  z.object({
    kind: z.literal('token'),
    token: z.string().trim().min(1).max(10_000),
    username: z.string().trim().max(200).nullable().optional(),
  }),
  z.object({ kind: z.literal('ssh-key'), privateKey: z.string().min(1).max(65_536) }),
  z.object({ kind: z.literal('ssh-agent') }),
]);

export const SignInInputSchema = z.object({
  method: SignInRequestSchema,
  identity: GitIdentitySchema.nullable().optional(),
  /** The user saw that secrets are kept with weaker protection on this computer (A4.13). */
  acceptWeakStorage: z.boolean().optional(),
});
export type SignInInputView = z.infer<typeof SignInInputSchema>;

/** Shown while a device-flow sign-in waits for the approval in the browser. */
export const DeviceCodeProgressSchema = z.object({ userCode: z.string(), verificationUri: z.string() });

export const DownloadProgressSchema = z.object({ phase: z.string(), percent: z.number().nullable() });

export const DownloadOutcomeSchema = z.object({
  kind: z.enum(['downloaded', 'prefix', 'localPrefix', 'offer', 'refused']),
});

export const SetupResultSchema = z.object({
  libraryId: z.string(),
  prefix: z.string().nullable(),
  /** The local prefix chosen on the local-prefix page (Step 8). */
  localPrefix: z.string().nullable(),
  handoff: SetupHandoffSchema,
});

export const setupWorkerApi = api({
  queries: {
    view: query(Empty, SetupViewSchema),
    /** What main records once the download is complete. */
    result: query(Empty, SetupResultSchema),
  },
  commands: {
    start: command(Empty, SetupViewSchema),
    signIn: command(SignInInputSchema, SetupViewSchema, { progress: DeviceCodeProgressSchema }),
    setIdentity: command(z.object({ identity: GitIdentitySchema }), SetupViewSchema),
    /** Main allows the worker to look at the folder first: the default one, or one the user picked. */
    checkFolder: command(z.object({ path: z.string().min(1).max(4096) }), SetupViewSchema),
    download: command(
      z.object({ libraryPath: z.string().min(1).max(4096), downloadPath: z.string().min(1).max(4096) }),
      DownloadOutcomeSchema,
      { progress: DownloadProgressSchema },
    ),
    createLibrary: command(z.object({ prefix: z.string().max(100) }), DownloadOutcomeSchema),
    joinInstead: command(Empty, DownloadOutcomeSchema),
    /** The local-prefix page while the user types: the prefix checked against the device (PLAN.md §3.3). */
    checkLocalPrefix: command(z.object({ prefix: z.string().max(100) }), SetupViewSchema),
    chooseLocalPrefix: command(z.object({ prefix: z.string().max(100) }), DownloadOutcomeSchema),
    /** [Move my folder] or [Keep it] for each of the user's folders that start with the prefix (PLAN.md §3.17 step 5). */
    chooseFolders: command(z.object({ choices: z.array(SetupFolderChoiceSchema).max(1000) }), DownloadOutcomeSchema),
  },
  events: {
    changed: SetupViewSchema,
  },
});

export type SetupWorkerApi = typeof setupWorkerApi;
