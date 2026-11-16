// The git screens' views and inputs (IMPLEMENTATION.md Step 11, PLAN.md §3.10): the sync bar, the changes screen and
// the commit checks, the incoming preview, conflicts, branches, stashes and history.
import { ErrorViewSchema } from '@app/schemas';
import { z } from 'zod';
import { LinkPlanViewSchema } from './link-views.ts';
import { PlacementEditSchema } from './placement-views.ts';
import { PullPrefixViewSchema } from './prefix-views.ts';

const LibraryPath = z.string().min(1).max(4096);
/** A commit's author (PLAN.md §3.10 "Author"). */
export const CommitIdentitySchema = z.object({ name: z.string().max(200), email: z.string().max(320) });
const Identity = CommitIdentitySchema;

export const GitOperationSchema = z.enum(['none', 'merging', 'rebasing', 'cherryPicking', 'reverting']);

export const SyncStatusViewSchema = z.object({
  branch: z.string().nullable(),
  head: z.string().nullable(),
  upstream: z.string().nullable(),
  incoming: z.number().int().nonnegative(),
  toPush: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  operation: GitOperationSchema,
  conflicts: z.array(z.object({ path: z.string(), skill: z.string().nullable() })),
  stashes: z.number().int().nonnegative(),
  offline: z.boolean(),
  fetching: z.boolean(),
  lastFetchAt: z.number().nullable(),
  fetchError: ErrorViewSchema.nullable(),
  compatibility: z.enum(['ok', 'formatTooNew', 'appTooOld']),
  identity: Identity.nullable(),
  fetchTimer: z.boolean(),
  pullMode: z.enum(['merge', 'rebase']),
  remote: z.boolean(),
});
export type SyncStatusView = z.infer<typeof SyncStatusViewSchema>;

export const ChangedFileViewSchema = z.object({
  path: z.string(),
  from: z.string().nullable(),
  change: z.enum(['added', 'modified', 'deleted', 'renamed', 'typeChanged', 'untracked', 'conflicted']),
});

export const ChangeGroupViewSchema = z.object({
  key: z.string(),
  kind: z.enum(['skill', 'instructions', 'library']),
  skill: z.string().nullable(),
  files: z.array(ChangedFileViewSchema),
  paths: z.array(z.string()),
  deleted: z.boolean(),
});
export type ChangeGroupView = z.infer<typeof ChangeGroupViewSchema>;

export const GitCommitSummarySchema = z.object({
  id: z.string(),
  subject: z.string(),
  author: z.string(),
  authorDate: z.number(),
});

export const ChangesViewSchema = z.object({
  groups: z.array(ChangeGroupViewSchema),
  notPushed: z.array(GitCommitSummarySchema),
  canUndo: z.boolean(),
});
export type ChangesView = z.infer<typeof ChangesViewSchema>;

export const FileDiffViewSchema = z.object({
  path: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  binary: z.boolean(),
});
export type FileDiffView = z.infer<typeof FileDiffViewSchema>;

export const SecretFindingViewSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  rule: z.string(),
  commit: z.string().nullable(),
});
export type SecretFindingView = z.infer<typeof SecretFindingViewSchema>;

const SizedPath = z.object({ path: z.string(), size: z.number().int().nonnegative() });

export const CommitChecksViewSchema = z.object({
  paths: z.array(z.string()),
  skills: z.array(z.string()),
  deletions: z.array(z.string()),
  secrets: z.array(SecretFindingViewSchema),
  largeFiles: z.array(SizedPath),
  tooLarge: z.array(SizedPath),
  caseClashes: z.array(z.tuple([z.string(), z.string()])),
  executable: z.array(z.string()),
  problems: z.array(z.object({ skill: z.string().nullable(), code: z.string(), path: z.string() })),
  identityNeeded: z.boolean(),
  signingKeyNeeded: z.boolean(),
});
export type CommitChecksView = z.infer<typeof CommitChecksViewSchema>;

export const CommitInputSchema = z.object({
  paths: z.array(LibraryPath).min(1).max(10_000),
  message: z.string().min(1).max(10_000),
  confirm: z.object({
    deletions: z.boolean().optional(),
    secrets: z.boolean().optional(),
    largeFiles: z.boolean().optional(),
    problems: z.boolean().optional(),
  }),
  push: z.boolean(),
});

export const PushResultViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pushed'), commits: z.number().int(), branch: z.string() }),
  z.object({ kind: z.literal('upToDate') }),
  z.object({ kind: z.literal('secrets'), findings: z.array(SecretFindingViewSchema) }),
  z.object({
    kind: z.literal('rejected'),
    reason: z.enum(['nonFastForward', 'protected', 'unsigned', 'other']),
    branch: z.string(),
    remoteMessage: z.string(),
  }),
]);
export type PushResultView = z.infer<typeof PushResultViewSchema>;

export const CommitResultViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('committed'), commit: z.string(), push: PushResultViewSchema.nullable() }),
  z.object({ kind: z.literal('checks'), checks: CommitChecksViewSchema }),
]);
export type CommitResultView = z.infer<typeof CommitResultViewSchema>;

const Where = z.object({ global: z.boolean(), repos: z.array(z.string()) });
const RepoRef = z.object({ id: z.string(), name: z.string() });

export const IncomingCommitViewSchema = GitCommitSummarySchema.extend({
  scripts: z.boolean(),
  allowedTools: z.boolean(),
  skills: z.array(z.string()),
});
export type IncomingCommitView = z.infer<typeof IncomingCommitViewSchema>;

export const IncomingPreviewViewSchema = z.object({
  state: z.enum(['none', 'ready']),
  upstream: z.string().nullable(),
  target: z.string().nullable(),
  commits: z.array(IncomingCommitViewSchema),
  compatibility: z.enum(['ok', 'formatTooNew', 'appTooOld']),
  conflicts: z.array(z.object({ path: z.string(), type: z.string(), skill: z.string().nullable() })),
  localChanges: z.array(z.string()),
  skills: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    modified: z.array(z.string()),
    renamed: z.array(z.object({ from: z.string(), to: z.string() })),
  }),
  moves: z.array(z.object({ skill: z.string(), from: Where, to: Where })),
  plan: LinkPlanViewSchema.nullable(),
  links: z.array(z.object({ dest: z.string(), target: z.string(), skill: z.string() })),
  questions: z.object({
    tagsGone: z.array(z.object({ tag: z.string(), repos: z.array(RepoRef), suggestions: z.array(z.string()) })),
    becomesGlobal: z.array(z.object({ skill: z.string(), repos: z.array(RepoRef) })),
  }),
  mode: z.enum(['merge', 'rebase']),
  /** The pull brings another git prefix (Step 14): how this device takes it, and its local-prefix question. */
  prefix: PullPrefixViewSchema.nullable(),
  hash: z.string(),
});
export type IncomingPreviewView = z.infer<typeof IncomingPreviewViewSchema>;

export const PullInputSchema = z.object({
  planHash: z.string().min(1).max(200),
  /** The answers to the preview's questions: placement edits written with the pull (none is fine). */
  edits: z.array(PlacementEditSchema).max(5000),
  stash: z.boolean(),
  /** The answer to the local-prefix question, when the pull brings a git prefix that clashes here (Step 14). */
  localPrefix: z.string().max(100).nullable().optional(),
});

const FilesResult = <K extends string>(kind: K) => z.object({ kind: z.literal(kind), files: z.array(z.string()) });

export const PullResultViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pulled'), commits: z.number().int(), merged: z.boolean() }),
  z.object({ kind: z.literal('upToDate') }),
  FilesResult('localChanges'),
  FilesResult('conflicts'),
  FilesResult('stashConflicts'),
]);
export type PullResultView = z.infer<typeof PullResultViewSchema>;

export const ConflictKindSchema = z.enum([
  'bothModified',
  'bothAdded',
  'bothDeleted',
  'addedByUs',
  'addedByThem',
  'deletedByUs',
  'deletedByThem',
]);

export const ConflictSideViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('you') }),
  z.object({ kind: z.literal('person'), name: z.string() }),
  z.object({ kind: z.literal('stash') }),
  z.object({ kind: z.literal('revert'), subject: z.string() }),
]);
export type ConflictSideView = z.infer<typeof ConflictSideViewSchema>;

export const ConflictsViewSchema = z.object({
  operation: z.union([GitOperationSchema, z.literal('stash')]),
  files: z.array(
    z.object({
      path: z.string(),
      kind: ConflictKindSchema,
      skill: z.string().nullable(),
      binary: z.boolean(),
      markers: z.boolean(),
    }),
  ),
  current: ConflictSideViewSchema,
  incoming: ConflictSideViewSchema,
  ready: z.boolean(),
});
export type ConflictsView = z.infer<typeof ConflictsViewSchema>;

export const ConflictFileViewSchema = z.object({
  path: z.string(),
  kind: ConflictKindSchema.nullable(),
  binary: z.boolean(),
  text: z.string().nullable(),
  base: z.string().nullable(),
  current: z.string().nullable(),
  incoming: z.string().nullable(),
});
export type ConflictFileView = z.infer<typeof ConflictFileViewSchema>;

export const ContinueResultViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done') }),
  FilesResult('conflicts'),
  FilesResult('unresolved'),
]);

export const BranchesViewSchema = z.object({
  current: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  local: z.array(
    z.object({ name: z.string(), head: z.string(), current: z.boolean(), upstream: z.string().nullable() }),
  ),
  remote: z.array(z.object({ name: z.string(), head: z.string() })),
});
export type BranchesView = z.infer<typeof BranchesViewSchema>;

export const SwitchResultViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('switched') }),
  FilesResult('localChanges'),
  FilesResult('stashConflicts'),
]);
export type SwitchResultView = z.infer<typeof SwitchResultViewSchema>;

export const MergeResultViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('merged') }),
  z.object({ kind: z.literal('upToDate') }),
  FilesResult('localChanges'),
  FilesResult('conflicts'),
]);

export const StashViewSchema = z.object({ index: z.number().int(), id: z.string(), message: z.string() });

export const StashResultViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('applied') }),
  FilesResult('localChanges'),
  FilesResult('conflicts'),
]);

export const HistoryEntryViewSchema = IncomingCommitViewSchema.extend({
  merge: z.boolean(),
  local: z.boolean(),
});
export type HistoryEntryView = z.infer<typeof HistoryEntryViewSchema>;

export const CommitViewSchema = HistoryEntryViewSchema.extend({
  message: z.string(),
  parents: z.array(z.string()),
  changes: z.array(
    z.object({
      status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'typeChanged']),
      path: z.string(),
      from: z.string().nullable(),
      similarity: z.number().nullable(),
    }),
  ),
});
export type CommitView = z.infer<typeof CommitViewSchema>;

export const RevertResultViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reverted') }),
  FilesResult('conflicts'),
]);

export const HistoryInputSchema = z.object({
  skill: z.string().min(1).max(200).nullable(),
  skip: z.number().int().nonnegative().max(1_000_000),
  max: z.number().int().positive().max(500),
});

export const ActivityFilterSchema = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  kinds: z.array(z.string().min(1).max(100)).max(100).optional(),
  /** Entries about this skill (its folder): per-skill history. */
  skill: z.string().min(1).max(200).optional(),
  since: z.number().optional(),
  until: z.number().optional(),
  /** "What changed since yesterday": from the start of yesterday by the instance's clock (UTC). */
  sinceYesterday: z.boolean().optional(),
});
export type ActivityFilter = z.infer<typeof ActivityFilterSchema>;
