// Roles, change requests and signing in the worker (IMPLEMENTATION.md Step 12, ADR 0032): the review service wired to
// the git screens, the host's API with the signed-in token (for the signing key), the page that makes a change request
// on the host's website, the user's SSH keys, and the instance API's review calls.
import { brand } from '@app/brand';
import {
  type ActivityLog,
  ChooseSigningKey,
  type Clock,
  CommitToNewBranch,
  CreateSigningKey,
  type DeviceServices,
  endpointFor,
  type GitRepo,
  type HostCredentials,
  type HostProbe,
  type InstanceEngine,
  type Logger,
  MoveCommits,
  OpenRequest,
  parseGitUrl,
  RegisterSigningKey,
  type ReviewApi,
  ReviewService,
  ReviewStatusQuery,
  type SigningKeySource,
  SignAndPush,
  SigningQuery,
  type Store,
  SuggestBranchQuery,
  type SyncService,
} from '@app/core';
import type { Handlers, InstanceApi } from '@app/ipc';
import { commitView } from './sync.ts';

/** Core's results are deeply readonly; the contracts' views are the same shapes without the modifier. */
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
const view = <T>(value: T): Mutable<T> => value as Mutable<T>;

export interface WorkerReviewDeps {
  readonly engine: InstanceEngine;
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly activity: ActivityLog;
  readonly repo: GitRepo;
  readonly sync: SyncService;
  readonly services: DeviceServices;
  readonly keys: SigningKeySource;
  readonly credentials: HostCredentials;
  readonly probe: HostProbe;
  /** The library's URL now (it changes with Change URL); null for a test library. */
  readonly gitUrl: () => string | null;
  readonly deviceName: () => string;
  readonly recheckAccess: () => void;
  readonly onChange: () => void;
}

/** GitHub's or GitLab's API with the signed-in token; null on plain git, with a key, or for a test library. */
export async function reviewApi(
  deps: Pick<WorkerReviewDeps, 'store' | 'credentials' | 'probe' | 'gitUrl'>,
): Promise<ReviewApi | null> {
  const { store, credentials, probe, gitUrl } = deps;
  const account = store.read((tx) => tx.hostAccount.get());
  const url = gitUrl();
  if (!account || account.host === 'plain' || url === null) return null;
  const parsed = parseGitUrl(url);
  if (!parsed.ok || parsed.value.transport !== 'https') return null;
  const token = await credentials.apiToken();
  if (token === null) return null;
  const endpoint = endpointFor(account.host, account.origin ?? `https://${parsed.value.host}`, account.selfHosted);
  return { host: probe.host(endpoint), token, repoPath: parsed.value.path };
}

/**
 * The page that makes a change request on the host's website, from the host kind (ADR 0032): GitHub's or GitLab's;
 * null on a plain git server, with a key instead of an account, or for a test library.
 */
export function newRequestUrl(
  deps: Pick<WorkerReviewDeps, 'store' | 'probe' | 'gitUrl'>,
  branch: string,
  base: string,
): string | null {
  const account = deps.store.read((tx) => tx.hostAccount.get());
  const url = deps.gitUrl();
  if (!account || account.host === 'plain' || url === null) return null;
  const parsed = parseGitUrl(url);
  if (!parsed.ok) return null;
  const endpoint = endpointFor(account.host, account.origin ?? `https://${parsed.value.host}`, account.selfHosted);
  return deps.probe.host(endpoint).newRequestUrl(parsed.value.path, branch, base);
}

type ReviewQueries = 'reviewStatus' | 'suggestBranch' | 'signing';
type ReviewCommands =
  | 'commitToNewBranch'
  | 'openRequest'
  | 'moveCommits'
  | 'chooseSigningKey'
  | 'createSigningKey'
  | 'registerSigningKey'
  | 'signAndPush';

export class WorkerReview {
  readonly service: ReviewService;
  readonly #deps: WorkerReviewDeps;

  constructor(deps: WorkerReviewDeps) {
    this.#deps = deps;
    this.service = new ReviewService({
      engine: deps.engine,
      store: deps.store,
      clock: deps.clock,
      logger: deps.logger,
      activity: deps.activity,
      repo: deps.repo,
      sync: deps.sync,
      services: deps.services,
      keys: deps.keys,
      api: () => reviewApi(deps),
      appName: brand.displayName,
      deviceName: deps.deviceName,
      recheckAccess: deps.recheckAccess,
      newRequestUrl: async (branch, base) => newRequestUrl(deps, branch, base),
      onChange: deps.onChange,
    });
  }

  handlers(): {
    queries: Pick<Handlers<InstanceApi>['queries'], ReviewQueries>;
    commands: Pick<Handlers<InstanceApi>['commands'], ReviewCommands>;
  } {
    const { engine } = this.#deps;
    return {
      queries: {
        reviewStatus: async () => view(await engine.query(ReviewStatusQuery, {})),
        suggestBranch: async ({ skills }) => ({ branch: await engine.query(SuggestBranchQuery, { skills }) }),
        signing: async () => view(await engine.query(SigningQuery, {})),
      },
      commands: {
        commitToNewBranch: async (input) => commitView(await engine.execute(CommitToNewBranch, input)),
        openRequest: async (input) => view(await engine.execute(OpenRequest, input)),
        moveCommits: async ({ branch }) => {
          await engine.execute(MoveCommits, { branch });
          return {};
        },
        chooseSigningKey: async (input) => {
          await engine.execute(ChooseSigningKey, input);
          return {};
        },
        createSigningKey: async () => {
          await engine.execute(CreateSigningKey, {});
          return {};
        },
        registerSigningKey: async () => {
          await engine.execute(RegisterSigningKey, {});
          return {};
        },
        signAndPush: async (input) => view(await engine.execute(SignAndPush, input)),
      },
    };
  }
}
