// Roles, change requests and signing (IMPLEMENTATION.md Step 12, PLAN.md §3.11, §3.10 "Signing", ADR 0032): what the
// role allows on each screen, the branch of a change request and the page that makes it on the host's website, and the
// signing key.
import { z } from 'zod';
import { CommitInputSchema, PushResultViewSchema } from './sync-views.ts';

export const RoleActionsViewSchema = z.object({
  companyBranch: z.enum(['push', 'request', 'none']),
  requests: z.boolean(),
  admin: z.boolean(),
});
export type RoleActionsView = z.infer<typeof RoleActionsViewSchema>;

export const ReviewStatusViewSchema = z.object({
  role: z.enum(['viewer', 'member', 'maintainer', 'admin']).nullable(),
  host: z.enum(['github', 'gitlab', 'plain']).nullable(),
  login: z.string().nullable(),
  actions: RoleActionsViewSchema.nullable(),
  branch: z.string().nullable(),
  companyBranch: z.string(),
  onCompanyBranch: z.boolean(),
  /** One of the user's own branches for a change request: its push opens the request's page. */
  requestBranch: z.boolean(),
  directPushRefused: z.boolean(),
  signingRequired: z.boolean(),
  signingKeyNeeded: z.boolean(),
});
export type ReviewStatusView = z.infer<typeof ReviewStatusViewSchema>;

/**
 * [Push and open change request]: the branch is on the server, and `link` is the page that makes the request on the
 * host's website (null: ask a reviewer to merge it); or the push came back with secrets or a rejection.
 */
export const OpenResultViewSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('opened'),
    branch: z.string().max(300),
    base: z.string().max(300),
    link: z.string().max(4000).nullable(),
  }),
  z.object({ kind: z.literal('push'), push: PushResultViewSchema }),
]);
export type OpenResultView = z.infer<typeof OpenResultViewSchema>;

const KeyLine = z.string().max(20_000);

export const SigningViewSchema = z.object({
  required: z.boolean(),
  key: z
    .object({ kind: z.enum(['file', 'app']), path: z.string().nullable(), publicKey: KeyLine, label: z.string() })
    .nullable(),
  canRegister: z.boolean(),
  registered: z.boolean().nullable(),
});
export type SigningView = z.infer<typeof SigningViewSchema>;

/** [Commit to a new branch]: the commit's input without `push`, and the branch. */
export const CommitToBranchInputSchema = CommitInputSchema.omit({ push: true }).extend({
  branch: z.string().min(1).max(200),
});

export const OpenRequestInputSchema = z.object({ confirmSecrets: z.boolean() });
