// Git hosts (ADR 0016, IMPLEMENTATION.md §2.9): GitHub (as a GitHub App, also on GitHub Enterprise Server), GitLab
// (OAuth, also self-managed) and plain git, each declaring what it can do. The adapters talk to the host's API and
// collect facts; what the facts mean (the role) is decided in core (review/roles). Text from hosts is untrusted.

export type HostKind = 'github' | 'gitlab' | 'plain';

export interface HostCapabilities {
  /** Sign-in in the browser with a short code (the OAuth device flow). */
  readonly deviceFlow: boolean;
  readonly readableBranchRules: boolean;
  readonly signingKeyRegistration: boolean;
}

/** Where a host is, as the probe found it. */
export interface HostEndpoint {
  readonly kind: HostKind;
  /** The web address, e.g. `https://github.com` or `https://git.acme.example:8443`. */
  readonly origin: string;
  /** The API's base address, e.g. `https://api.github.com` or `https://git.acme.example/api/v4`; null for plain git. */
  readonly apiBase: string | null;
  /** A GitHub Enterprise Server or a self-managed GitLab: its sign-in needs the client id of an app registered there. */
  readonly selfHosted: boolean;
}

export interface DeviceCode {
  readonly deviceCode: string;
  /** What the user types in the browser, e.g. `WDJB-MJHT`. */
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalMs: number;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export interface HostTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Epoch milliseconds; null for a token that doesn't expire. */
  readonly expiresAt: number | null;
}

export type DevicePoll =
  | { readonly kind: 'pending' }
  | { readonly kind: 'slowDown'; readonly intervalMs: number }
  | { readonly kind: 'denied' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'token'; readonly tokens: HostTokens };

export interface HostAccount {
  readonly login: string;
  readonly name: string | null;
  readonly email: string | null;
}

/** What GitHub says (PLAN.md §3.11 "How the app learns the role"). */
export interface GithubFacts {
  readonly kind: 'github';
  /** The repository API's permission flags for the signed-in user. */
  readonly permissions: {
    readonly admin: boolean;
    readonly maintain: boolean;
    readonly push: boolean;
    readonly pull: boolean;
  };
  /** The company branch's rules, from the rules API that anyone with read access can call. */
  readonly branch: {
    /** A readable rule (a ruleset) requires a pull request. */
    readonly reviewRequired: boolean;
    /** The user may bypass that rule, e.g. as a ruleset's bypass actor. */
    readonly canBypass: boolean;
    /**
     * The branch API's `protected` flag. Protected without a readable rule means classic branch protection, whose
     * details only admins can read: a direct push may be refused (PLAN.md §3.11).
     */
    readonly protected: boolean;
    /** A readable rule requires signed commits (PLAN.md §3.10 "Signing"). */
    readonly signaturesRequired: boolean;
  };
}

/** What GitLab says. Access levels as GitLab numbers them: 10 Guest, 20 Reporter, 30 Developer, 40 Maintainer, 50 Owner. */
export interface GitlabFacts {
  readonly kind: 'gitlab';
  readonly accessLevel: number;
  /** A Guest's custom role includes "View repository code" (Ultimate). */
  readonly readCode: boolean;
  /** The branch API's `can_push` for the company branch: false when it's protected against this user. */
  readonly canPushDefault: boolean;
  /** The project's push rule rejects unsigned commits, when the user may read it. */
  readonly signaturesRequired: boolean;
}

/** A plain git server, or a key instead of an account: only a dry-run push says anything (PLAN.md §3.11). */
export interface KeyFacts {
  readonly kind: 'plain';
  readonly canWrite: boolean;
}

export type HostFacts = GithubFacts | GitlabFacts | KeyFacts;

export type RepoAccess =
  | {
      readonly kind: 'ok';
      readonly facts: GithubFacts | GitlabFacts;
      readonly defaultBranch: string | null;
      /** The repository's size, when the host says. */
      readonly sizeBytes: number | null;
    }
  /** The repo doesn't exist, or the user can't see it: the host gives the same answer for both. */
  | { readonly kind: 'notFound' }
  /** GitHub: the app isn't installed on the repo, so the token can't reach it (PLAN.md §3.17 step 2). */
  | { readonly kind: 'appNotInstalled' }
  /** The token was refused: revoked, expired, or for another server. */
  | { readonly kind: 'unauthorized' };

export interface HostSigningKey {
  readonly title: string;
  /** The public key, e.g. `ssh-ed25519 AAAA… comment`. */
  readonly key: string;
}

export interface HostCallOptions {
  readonly signal?: AbortSignal;
}

/** One host's API. Plain servers have none: their adapter declares no capabilities and refuses every call. */
export interface Host {
  readonly endpoint: HostEndpoint;
  capabilities(): HostCapabilities;
  startDeviceFlow(clientId: string, options?: HostCallOptions): Promise<DeviceCode>;
  pollDeviceFlow(clientId: string, deviceCode: string, options?: HostCallOptions): Promise<DevicePoll>;
  /** Renews a token with its refresh token. Fails with `host.refreshFailed` when the host refuses. */
  refresh(clientId: string, refreshToken: string, options?: HostCallOptions): Promise<HostTokens>;
  account(token: string, options?: HostCallOptions): Promise<HostAccount>;
  repoAccess(token: string, repoPath: string, options?: HostCallOptions): Promise<RepoAccess>;
  /** The HTTP header git sends with this host's token (ADR 0014). */
  gitHeader(token: string): string;
  /**
   * The page on the host's website that makes a change request from this branch into `base` (ADR 0032), for when the
   * server sent no link with the push. Null on a plain git server.
   */
  newRequestUrl(repoPath: string, branch: string, base: string): string | null;
  /** The account's SSH signing keys (PLAN.md §3.10 "Signing"). */
  signingKeys(token: string, options?: HostCallOptions): Promise<HostSigningKey[]>;
  addSigningKey(token: string, key: HostSigningKey, options?: HostCallOptions): Promise<void>;
}

export interface HostProbe {
  /** Which kind of host serves this HTTPS origin (e.g. `https://git.acme.example`). Unknown servers are plain git. */
  probe(origin: string, options?: HostCallOptions): Promise<HostEndpoint>;
  host(endpoint: HostEndpoint): Host;
}
