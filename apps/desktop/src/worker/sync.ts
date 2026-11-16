// The git screens' part of the worker (IMPLEMENTATION.md Step 11): the sync service wired to the link engine's dry
// run and checks, its notifications in the user's language, the counts for main's switcher and tray, and the instance
// API's sync calls.
import {
  AbortOperation,
  ApplyStash,
  type AppliedStateBaseline,
  BranchesQuery,
  ChangeDiffQuery,
  ChangesQuery,
  CommitChanges,
  CommitChecksQuery,
  CommitDiffQuery,
  CommitQuery,
  ConflictFileQuery,
  ConflictsQuery,
  ContinueOperation,
  CreateBranch,
  DeleteBranch,
  DiscardChanges,
  DropStash,
  type FileSystem,
  FetchLibrary,
  GitHistoryQuery,
  type GitRepo,
  IncomingQuery,
  type InstanceEngine,
  type LibrarySnapshot,
  type LibrarySource,
  type Logger,
  MarkResolved,
  MergeBranch,
  type PathFlavour,
  PullLibrary,
  PushLibrary,
  RevertCommit,
  SetCommitIdentity,
  SetSyncSettings,
  StashChanges,
  StashesQuery,
  type Store,
  SwitchBranch,
  type SyncNotice,
  SyncService,
  SyncStatusQuery,
  TakeConflict,
  UndoLastCommit,
  type Clock,
  type DomainEvent,
} from '@app/core';
import type {
  ChangesView,
  CommitChecksView,
  CommitResultView,
  Handlers,
  IncomingPreviewView,
  InstanceApi,
  LinkPlanView,
  SyncStatusView,
} from '@app/ipc';
import type { ErrorCode } from '@app/schemas';
import type { ChangesView as CoreChanges, CommitChecks, CommitResult, IncomingPreview, SyncStatus } from '@app/core';
import { translate } from '../shared/i18n.ts';
import type { WorkerLinks } from './links.ts';

/** Core's results are deeply readonly; the contracts' views are the same shapes without the modifier. */
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends ReadonlyMap<infer K, infer V>
    ? Map<K, V>
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;
const view = <T>(value: T): Mutable<T> => value as Mutable<T>;

function statusView(status: SyncStatus): SyncStatusView {
  return {
    ...view(status),
    fetchError: status.fetchError
      ? { code: status.fetchError.code as ErrorCode, params: { ...status.fetchError.params } }
      : null,
  };
}

function changesView(changes: CoreChanges): ChangesView {
  return {
    groups: view(changes.groups),
    notPushed: changes.notPushed.map((c) => ({
      id: c.id,
      subject: c.subject,
      author: c.author.name,
      authorDate: c.authorDate,
    })),
    canUndo: changes.canUndo,
  };
}

function checksView(checks: CommitChecks): CommitChecksView {
  return { ...view(checks), caseClashes: checks.caseClashes.map(([a, b]) => [a, b] as [string, string]) };
}

export function commitView(result: CommitResult): CommitResultView {
  return result.kind === 'checks' ? { kind: 'checks', checks: checksView(result.checks) } : view(result);
}

function incomingView(preview: IncomingPreview): IncomingPreviewView {
  // The plan is the link engine's own plan view (LinkService.previewLibrary).
  // The prefix part is the prefix module's own check (PrefixService.pullPreview).
  return {
    ...view(preview),
    plan: preview.plan as LinkPlanView | null,
    prefix: preview.prefix as IncomingPreviewView['prefix'],
  };
}

export interface WorkerSyncDeps {
  readonly engine: InstanceEngine;
  readonly store: Store;
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly repo: GitRepo;
  readonly baseline: AppliedStateBaseline;
  readonly libraryRoot: () => string;
  readonly snapshot: () => LibrarySnapshot | null;
  readonly scan: (source: LibrarySource) => Promise<LibrarySnapshot>;
  /** Reads the library again inside the running command, before its link check. */
  readonly reload: (emit: (event: DomainEvent) => void) => Promise<void>;
  readonly links: WorkerLinks;
  readonly appVersion: string;
  readonly deviceName: () => string;
  /** The library's name, for the notifications. */
  readonly libraryName: () => string;
  readonly notify: (notification: { kind: 'incoming' | 'linksChanged'; title: string; body: string }) => void;
  readonly onChange: (counts: { incoming: number; toPush: number }) => void;
}

/** A sync notice in the user's language (PLAN.md §3.19 "Notifications"). */
export function syncNoticeText(
  notice: SyncNotice,
  library: string,
): { kind: 'incoming' | 'linksChanged'; title: string; body: string } {
  const authors = notice.authors.join(', ');
  if (notice.type === 'incoming') {
    const skills = notice.skills.join(', ');
    return {
      kind: 'incoming',
      title: translate('notifications.incoming.title', { count: notice.count, library }),
      body: translate(skills === '' ? 'notifications.incoming.bodyNoSkills' : 'notifications.incoming.body', {
        count: notice.count,
        authors: authors === '' ? translate('notifications.incoming.someone') : authors,
        skills,
      }),
    };
  }
  const lines = [
    ...(notice.count > 0
      ? [translate('notifications.external.commits', { count: notice.count, authors: authors || '—' })]
      : []),
    // Renamed and removed skills have their own notices (S6).
    ...notice.added.map((skill) => translate('notifications.external.added', { skill })),
  ];
  return {
    kind: 'linksChanged',
    title: translate('notifications.external.title', { library }),
    body: lines.join('\n'),
  };
}

type SyncQueries =
  | 'syncStatus'
  | 'changes'
  | 'changeDiff'
  | 'commitChecks'
  | 'incoming'
  | 'conflicts'
  | 'conflictFile'
  | 'branches'
  | 'stashes'
  | 'gitHistory'
  | 'gitCommit'
  | 'commitDiff';
type SyncCommands =
  | 'fetch'
  | 'commit'
  | 'discard'
  | 'undoLastCommit'
  | 'pull'
  | 'push'
  | 'takeConflict'
  | 'markResolved'
  | 'continueOperation'
  | 'abortOperation'
  | 'createBranch'
  | 'switchBranch'
  | 'mergeBranch'
  | 'deleteBranch'
  | 'stash'
  | 'applyStash'
  | 'dropStash'
  | 'revertCommit'
  | 'setCommitIdentity'
  | 'setSyncSettings';

export class WorkerSync {
  readonly service: SyncService;
  readonly #deps: WorkerSyncDeps;

  constructor(deps: WorkerSyncDeps) {
    this.#deps = deps;
    const { links } = deps;
    this.service = new SyncService({
      engine: deps.engine,
      store: deps.store,
      fs: deps.fs,
      paths: deps.paths,
      clock: deps.clock,
      logger: deps.logger,
      activity: links.activity,
      repo: deps.repo,
      baseline: deps.baseline,
      libraryRoot: deps.libraryRoot,
      snapshot: deps.snapshot,
      scan: deps.scan,
      links: {
        previewLibrary: (library, change) => links.service.previewLibrary(library, change),
        // A pull, a switch or a stash can change the skills and the instructions: both follow at once.
        checkNow: async (emit) => {
          await deps.reload(emit);
          await links.service.checkNow(emit);
          await links.instructions.checkNow(emit);
        },
        persistPlacement: (change) => links.placement.persist(change),
        checkPlacement: (change) => links.placement.checkEdits(change),
        repoName: (id) => links.placement.repoName(id),
        renames: () => links.service.renames(),
      },
      appVersion: deps.appVersion,
      deviceName: deps.deviceName,
      notify: (notice) => deps.notify(syncNoticeText(notice, deps.libraryName())),
      onChange: deps.onChange,
    });
  }

  handlers(): {
    queries: Pick<Handlers<InstanceApi>['queries'], SyncQueries>;
    commands: Pick<Handlers<InstanceApi>['commands'], SyncCommands>;
  } {
    const { engine } = this.#deps;
    return {
      queries: {
        syncStatus: async () => statusView(await engine.query(SyncStatusQuery, {})),
        changes: async () => changesView(await engine.query(ChangesQuery, {})),
        changeDiff: ({ path }) => engine.query(ChangeDiffQuery, { path }),
        commitChecks: async ({ paths }) => checksView(await engine.query(CommitChecksQuery, { paths })),
        incoming: async ({ edits, localPrefix }) =>
          incomingView(await engine.query(IncomingQuery, { edits, localPrefix: localPrefix ?? null })),
        conflicts: async () => view(await engine.query(ConflictsQuery, {})),
        conflictFile: ({ path }) => engine.query(ConflictFileQuery, { path }),
        branches: async () => view(await engine.query(BranchesQuery, {})),
        stashes: async () => view(await engine.query(StashesQuery, {})),
        gitHistory: async (input) => view(await engine.query(GitHistoryQuery, input)),
        gitCommit: async ({ id }) => view(await engine.query(CommitQuery, { id })),
        commitDiff: ({ id, path }) => engine.query(CommitDiffQuery, { id, path }),
      },
      commands: {
        fetch: async () => {
          await engine.execute(FetchLibrary, {});
          return {};
        },
        commit: async (input) => commitView(await engine.execute(CommitChanges, input)),
        discard: async ({ paths }) => {
          await engine.execute(DiscardChanges, { paths });
          return {};
        },
        undoLastCommit: async () => {
          await engine.execute(UndoLastCommit, {});
          return {};
        },
        pull: async (input) => view(await engine.execute(PullLibrary, input)),
        push: async (input) => view(await engine.execute(PushLibrary, input)),
        takeConflict: async (input) => {
          await engine.execute(TakeConflict, input);
          return {};
        },
        markResolved: async ({ paths }) => {
          await engine.execute(MarkResolved, { paths });
          return {};
        },
        continueOperation: async () => view(await engine.execute(ContinueOperation, {})),
        abortOperation: async () => {
          await engine.execute(AbortOperation, {});
          return {};
        },
        createBranch: async (input) => view(await engine.execute(CreateBranch, input)),
        switchBranch: async (input) => view(await engine.execute(SwitchBranch, input)),
        mergeBranch: async ({ name, remote }) =>
          view(await engine.execute(MergeBranch, remote === undefined ? { name } : { name, remote })),
        deleteBranch: async (input) => {
          await engine.execute(DeleteBranch, input);
          return {};
        },
        stash: async ({ message }) => {
          await engine.execute(StashChanges, { message });
          return {};
        },
        applyStash: async (input) => view(await engine.execute(ApplyStash, input)),
        dropStash: async ({ index }) => {
          await engine.execute(DropStash, { index });
          return {};
        },
        revertCommit: async ({ id }) => view(await engine.execute(RevertCommit, { id })),
        setCommitIdentity: async (identity) => {
          await engine.execute(SetCommitIdentity, identity);
          return {};
        },
        setSyncSettings: async (input) => {
          await engine.execute(SetSyncSettings, {
            ...(input.fetchTimer === undefined ? {} : { fetchTimer: input.fetchTimer }),
            ...(input.pullMode === undefined ? {} : { pullMode: input.pullMode }),
          });
          return {};
        },
      },
    };
  }
}
