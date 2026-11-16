// An instance's settings, kept in its instance.db (PLAN.md §3.1). Later steps add fields with a migration.
import { z } from 'zod';
import { GitIdentitySchema } from './host.ts';

export const PullModeSchema = z.enum(['merge', 'rebase']);

export const InstanceSettingsSchema = z.object({
  /** How Pull integrates incoming commits: merge by default, rebase as a setting (PLAN.md §2 "Merge"). */
  pullMode: PullModeSchema,
  /**
   * The tools this instance links skills into (PLAN.md §3.4): each instance enables tools on its own. Added in Step 5;
   * settings written before have none enabled.
   */
  enabledTools: z.array(z.string().min(1).max(100)).max(200).default([]),
  /**
   * The local prefix this device uses for the library's skills (PLAN.md §3.3): kept here and in device.json, which
   * main writes. Added in Step 8; settings written before have none.
   */
  localPrefix: z.string().min(1).max(100).nullable().default(null),
  /**
   * The author of the app's commits when the host gave none, asked once (PLAN.md §3.10 "Commit"). Added in Step 11;
   * the host account's identity applies without it.
   */
  commitIdentity: GitIdentitySchema.nullable().default(null),
  /**
   * The fetch every 3 minutes (PLAN.md §3.10 "Fetch"). Off for SSH keys that ask for a touch on every use: then the
   * fetch runs only at start, on focus and on [Fetch] (§3.17). Added in Step 11.
   */
  fetchTimer: z.boolean().default(true),
  /**
   * The host refused a direct push to the company branch, where its rules can't be read (GitHub's classic branch
   * protection): from then on the user counts as a Member there (PLAN.md §3.11). Added in Step 12.
   */
  directPushRefused: z.boolean().default(false),
  /** The host requires signed commits: known from its rules, or from a rejected push (PLAN.md §3.10). Step 12. */
  signingRequired: z.boolean().default(false),
  /**
   * The SSH key the app signs with (Step 12): one of the user's own (`file`, the public key's path; the private key
   * next to it or the agent signs), or one the app created and keeps in the secrets service (`app`).
   */
  signingKey: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('file'),
        path: z.string().min(1).max(4096),
        publicKey: z.string().min(1).max(20_000),
      }),
      z.object({ kind: z.literal('app'), publicKey: z.string().min(1).max(20_000) }),
    ])
    .nullable()
    .default(null),
  /** Change requests already announced (PLAN.md §3.19 "Notifications"), so each raises one notification. Step 12. */
  requestsAnnounced: z.array(z.string().min(1).max(300)).max(1000).default([]),
  /**
   * Where the originals of skills imported from a local folder are, on this device only (PLAN.md §3.18 B): once the
   * skill is in the company version, the app offers to replace the original with it. Step 13.
   */
  importedOriginals: z
    .array(z.object({ skill: z.string().min(1).max(200), path: z.string().min(1).max(4096) }))
    .max(1000)
    .default([]),
  /**
   * The local prefix chosen in a pull's preview for a new git prefix that clashes here (PLAN.md §3.2 step 3): kept
   * until the change is adjusted to, so a merge that stops on conflicts, or a restart, doesn't ask again. Step 14.
   */
  prefixAnswer: z
    .object({ to: z.string().min(1).max(100), localPrefix: z.string().min(1).max(100) })
    .nullable()
    .default(null),
});

export type InstanceSettings = z.infer<typeof InstanceSettingsSchema>;

export const defaultInstanceSettings: InstanceSettings = {
  pullMode: 'merge',
  enabledTools: [],
  localPrefix: null,
  commitIdentity: null,
  fetchTimer: true,
  directPushRefused: false,
  signingRequired: false,
  signingKey: null,
  requestsAnnounced: [],
  importedOriginals: [],
  prefixAnswer: null,
};
