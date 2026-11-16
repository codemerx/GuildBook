// Sign-in (PLAN.md §3.17 step 2, ADR 0014, ADR 0016). Two records:
// - HostCredential: the secret part. It lives only in main's secrets service (IMPLEMENTATION.md §2.13 rule 9).
// - HostAccount: what the instance may remember about the sign-in: the host, the method, the account and the role.
//   It's kept in instance.db and never holds a token or a key (A4.10).
import { z } from 'zod';

export const HostKindSchema = z.enum(['github', 'gitlab', 'plain']);
export type HostKindName = z.infer<typeof HostKindSchema>;

export const RoleSchema = z.enum(['viewer', 'member', 'maintainer', 'admin']);
export type RoleName = z.infer<typeof RoleSchema>;

export const SignInMethodSchema = z.enum(['device', 'token', 'ssh-key', 'ssh-agent']);
export type SignInMethod = z.infer<typeof SignInMethodSchema>;

/** An HTTPS origin, e.g. `https://github.com` or `https://git.acme.example:8443`. */
const OriginSchema = z.url().regex(/^https:\/\/[^/]+$/, 'not an https origin');

export const HostCredentialSchema = z.discriminatedUnion('method', [
  /** The device flow's tokens (GitHub App user tokens, GitLab OAuth tokens), renewed with the refresh token. */
  z.object({
    method: z.literal('device'),
    host: z.enum(['github', 'gitlab']),
    origin: OriginSchema,
    clientId: z.string().min(1).max(200),
    accessToken: z.string().min(1).max(10_000),
    refreshToken: z.string().min(1).max(10_000).nullable(),
    /** Epoch milliseconds; null when the token doesn't expire. */
    expiresAt: z.number().int().nullable(),
  }),
  /** An access token typed in: a personal access token, or a deploy token with its own user name (PLAN.md §3.17). */
  z.object({
    method: z.literal('token'),
    host: HostKindSchema,
    origin: OriginSchema,
    username: z.string().min(1).max(200),
    token: z.string().min(1).max(10_000),
  }),
  /** A key the app keeps, e.g. a deploy key: written to a private file for one command (ADR 0014). */
  z.object({ method: z.literal('ssh-key'), privateKey: z.string().min(1).max(65_536) }),
  /** The user's own SSH agent and SSH config. Nothing secret is kept. */
  z.object({ method: z.literal('ssh-agent') }),
]);
export type HostCredential = z.infer<typeof HostCredentialSchema>;

/** The secrets service's key for an instance's credential (main keeps one namespace per instance). */
export const HOST_CREDENTIAL_KEY = 'host';

export const GitIdentitySchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+$/, 'not an email address'),
});
export type GitIdentityValue = z.infer<typeof GitIdentitySchema>;

export const HostAccountSchema = z.object({
  host: HostKindSchema,
  /** The HTTPS origin of the host's web pages and API, or null for a server reached only over SSH. */
  origin: z.string().nullable(),
  selfHosted: z.boolean(),
  method: SignInMethodSchema,
  /** The app registered on a self-hosted server, for the device flow; null on github.com and gitlab.com. */
  clientId: z.string().nullable(),
  /** The account's login on the host; null with a key or a token that isn't an account's. */
  login: z.string().nullable(),
  /** The commit author (PLAN.md §3.17 step 2): from the host, or asked once on plain servers and with keys. */
  identity: GitIdentitySchema,
  role: RoleSchema.nullable(),
  /** Epoch milliseconds of the last role check. */
  roleCheckedAt: z.number().int().nullable(),
});
export type HostAccount = z.infer<typeof HostAccountSchema>;

/** Where an instance's access stands (IMPLEMENTATION.md Step 4 "the access lost state"). */
export const AccessStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }),
  z.object({ state: z.literal('ok') }),
  z.object({
    state: z.literal('lost'),
    /** revoked: the host refused the sign-in; notFound: the repo is gone or out of reach; signInAgain: renewal failed. */
    reason: z.enum(['revoked', 'notFound', 'signInAgain']),
  }),
]);
export type AccessState = z.infer<typeof AccessStateSchema>;
