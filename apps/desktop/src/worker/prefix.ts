// The prefix lock and the prefix change in an instance's worker (IMPLEMENTATION.md Step 14, PLAN.md §3.2): the prefix
// service wired to the git screens (commit author, signing, push), the review module (role, company branch, the
// branches on the server), the link engine (choices move with renames; the gate before every link check) and the
// projected copies (a local prefix for a new git prefix that clashes here), with its notifications in the user's
// language.
import {
  accountOf,
  actionsFor,
  AdoptPrefix,
  ChangePrefix,
  type DevicePrefixes,
  type DomainEvent,
  type GitRepo,
  type InstanceEngine,
  type LibrarySnapshot,
  type Logger,
  type OperationRunner,
  type PathFlavour,
  type FileSystem,
  type Clock,
  type PrefixNotice,
  PrefixQuery,
  PrefixService,
  type PrefixServiceDeps,
  PreviewAdoptPrefix,
  PreviewPrefixChange,
  type ReviewService,
  type Store,
  type SyncService,
} from '@app/core';
import type { Handlers, InstanceApi } from '@app/ipc';
import { translate } from '../shared/i18n.ts';
import type { WorkerLinks } from './links.ts';

/** Core's results are deeply readonly; the contracts' views are the same shapes without the modifier. */
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
const view = <T>(value: T): Mutable<T> => value as Mutable<T>;

export interface WorkerPrefixDeps {
  readonly engine: InstanceEngine;
  readonly store: Store;
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly operations: OperationRunner;
  readonly repo: GitRepo;
  readonly libraryRoot: () => string;
  readonly snapshot: () => LibrarySnapshot | null;
  readonly device: DevicePrefixes;
  readonly links: WorkerLinks;
  readonly sync: SyncService;
  readonly review: ReviewService;
  /** Reads the library again inside the running command, before its link check. */
  readonly reload: (emit: (event: DomainEvent) => void) => Promise<void>;
  readonly appVersion: string;
  readonly deviceName: () => string;
  readonly libraryName: () => string;
  readonly notify: (notification: { kind: 'warning' | 'linksChanged'; title: string; body: string }) => void;
  readonly onChange: () => void;
}

/** A prefix notice in the user's language (PLAN.md §3.19 "Notifications"). */
export function prefixNoticeText(
  notice: PrefixNotice,
  library: string,
): { kind: 'warning' | 'linksChanged'; title: string; body: string } {
  switch (notice.type) {
    case 'waiting':
      return {
        kind: 'warning',
        title: translate('notifications.prefix.waiting.title', { library, to: notice.to }),
        body: translate('notifications.prefix.waiting.body', { library, from: notice.from, to: notice.to }),
      };
    case 'changed':
      return {
        kind: 'linksChanged',
        title: translate('notifications.prefix.changed.title', { library, to: notice.to }),
        body: translate('notifications.prefix.changed.body', { library, from: notice.from, to: notice.to }),
      };
    case 'drop-offered':
      return {
        kind: 'linksChanged',
        title: translate('notifications.prefix.dropOffered.title', { library, to: notice.to }),
        body: translate('notifications.prefix.dropOffered.body', { library, to: notice.to, local: notice.local }),
      };
  }
}

/** The prefix service's parts in the worker: the git screens, the review module, the link engine and the copies. */
export function prefixServiceDeps(deps: WorkerPrefixDeps): PrefixServiceDeps {
  const { links, sync, review } = deps;
  return {
    engine: deps.engine,
    operations: deps.operations,
    fs: deps.fs,
    paths: deps.paths,
    clock: deps.clock,
    logger: deps.logger,
    activity: links.activity,
    repo: deps.repo,
    libraryRoot: deps.libraryRoot,
    snapshot: deps.snapshot,
    device: deps.device,
    store: deps.store,
    projection: links.projection,
    actions: () => {
      const account = accountOf(deps.store);
      return account ? actionsFor(account.role, account.host) : null;
    },
    companyBranch: () => review.requests.companyBranch(),
    // The branches on the server that the company branch doesn't hold: the open change requests (PLAN.md §3.2 step 4).
    openRequests: () => review.requests.serverBranches(),
    sync: {
      identity: () => sync.commits.identity(),
      signingKeyNeeded: () => review.signing.keyNeeded(),
      own: (fn) => sync.own(fn),
      recordBaseline: () => sync.commits.recordBaseline(),
      // Only the names changed: the files' secrets were scanned when they were pushed under the old names.
      push: (emit) => sync.commits.push({ confirmSecrets: true }, emit),
      trailers: () => ({ 'Device-Name': deps.deviceName(), 'App-Version': deps.appVersion }),
      changed: () => sync.changed(),
    },
    renamed: (from, to) => links.service.skillRenamed(from, to),
    reconcile: {
      // The library is read again first: the operation's steps follow a commit or a merge.
      links: async (emit) => {
        await deps.reload(emit);
        await links.service.checkNow(emit);
      },
      instructions: async (emit) => {
        await links.instructions.checkNow(emit);
      },
    },
    notify: (notice) => deps.notify(prefixNoticeText(notice, deps.libraryName())),
    onChange: deps.onChange,
  };
}

export class WorkerPrefix {
  readonly service: PrefixService;
  readonly #deps: WorkerPrefixDeps;

  constructor(deps: WorkerPrefixDeps) {
    this.#deps = deps;
    this.service = new PrefixService(prefixServiceDeps(deps));
    deps.sync.usePrefix(this.service.hooks());
  }

  handlers(): {
    queries: Pick<Handlers<InstanceApi>['queries'], 'prefix' | 'previewPrefixChange' | 'previewAdoptPrefix'>;
    commands: Pick<Handlers<InstanceApi>['commands'], 'changePrefix' | 'adoptPrefix'>;
  } {
    const { engine } = this.#deps;
    return {
      queries: {
        prefix: async () => view(await engine.query(PrefixQuery, {})),
        previewPrefixChange: async ({ prefix, localPrefix }) =>
          view(await engine.query(PreviewPrefixChange, { prefix, localPrefix })),
        previewAdoptPrefix: async ({ localPrefix }) => view(await engine.query(PreviewAdoptPrefix, { localPrefix })),
      },
      commands: {
        changePrefix: async ({ prefix, localPrefix, planHash }) =>
          view(await engine.execute(ChangePrefix, { prefix, localPrefix, planHash })),
        adoptPrefix: async ({ localPrefix, planHash }) =>
          view(await engine.execute(AdoptPrefix, { localPrefix, planHash })),
      },
    };
  }
}
