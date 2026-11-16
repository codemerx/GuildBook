// The instance API: what the renderer asks of one instance's worker, over its own port (IMPLEMENTATION.md §2.8).
// Later steps add queries, commands and events here.
import { LibraryRelativePathSchema, SetupNameChoiceSchema, SetupPageSchema } from '@app/schemas';
import { z } from 'zod';
import { api, command, query } from '../contract.ts';
import {
  ActivityEntryViewSchema,
  AttentionItemSchema,
  FileDifferenceSchema,
  LinkCheckReportSchema,
  LinkDecisionSchema,
  LinkPlanViewSchema,
  SkillLinksViewSchema,
  ToolsViewSchema,
} from './link-views.ts';
import {
  NestedRepoWarningSchema,
  OverviewViewSchema,
  PlacementEditsSchema,
  PlacementPlanViewSchema,
  RepoViewSchema,
} from './placement-views.ts';
import {
  DoctorViewSchema,
  InstructionCheckReportSchema,
  InstructionDecisionSchema,
  InstructionPreviewViewSchema,
  InstructionsViewSchema,
} from './instruction-views.ts';
import {
  CopyConflictViewSchema,
  CopyDecisionSchema,
  LocalPrefixPreviewSchema,
  LocalPrefixViewSchema,
} from './projection-views.ts';
import {
  LocateCheckSchema,
  RecoveryReportSchema,
  RecoveryStateSchema,
  RelocationPreviewSchema,
  RelocationProgressSchema,
  RelocationStatusSchema,
  RelocationSummarySchema,
} from './relocation-views.ts';
import {
  AddFileResultViewSchema,
  AddSkillFileInputSchema,
  AgentToolViewSchema,
  LibraryFileViewSchema,
  NewSkillInputSchema,
  SaveFileInputSchema,
  SaveResultViewSchema,
  SkillFileEntryViewSchema,
  VersionEntryViewSchema,
} from './editor-views.ts';
import {
  ImportFileInputSchema,
  ImportProgressSchema,
  ImportReportViewSchema,
  ImportReviewViewSchema,
  ImportSessionViewSchema,
  ImportSourceInputSchema,
  OriginalOfferViewSchema,
  SaveImportFileInputSchema,
} from './import-views.ts';
import { PrefixAdoptViewSchema, PrefixChangePreviewViewSchema, PrefixStateViewSchema } from './prefix-views.ts';
import { DeviceCodeProgressSchema, SignInInputSchema } from './setup-api.ts';
import {
  ActivityFilterSchema,
  BranchesViewSchema,
  ChangesViewSchema,
  CommitChecksViewSchema,
  CommitIdentitySchema,
  CommitInputSchema,
  CommitResultViewSchema,
  CommitViewSchema,
  ConflictFileViewSchema,
  ConflictsViewSchema,
  ContinueResultViewSchema,
  FileDiffViewSchema,
  HistoryEntryViewSchema,
  HistoryInputSchema,
  IncomingPreviewViewSchema,
  MergeResultViewSchema,
  PullInputSchema,
  PullResultViewSchema,
  PushResultViewSchema,
  RevertResultViewSchema,
  StashResultViewSchema,
  StashViewSchema,
  SwitchResultViewSchema,
  SyncStatusViewSchema,
} from './sync-views.ts';
import { PlacementEditSchema } from './placement-views.ts';
import {
  CommitToBranchInputSchema,
  OpenRequestInputSchema,
  OpenResultViewSchema,
  ReviewStatusViewSchema,
  SigningViewSchema,
} from './review-views.ts';
import {
  AccessViewSchema,
  InstanceStatusViewSchema,
  LibraryGitViewSchema,
  LibrarySnapshotViewSchema,
  RemovalCheckViewSchema,
} from './views.ts';
import { SetupSummaryViewSchema, SetupWizardViewSchema } from './setup-views.ts';

const Id = z.string().min(1).max(200);
const Path = z.string().min(1).max(4096);
/** A path inside the library (git's form): `..`, absolute paths and the like are refused (Step 17). */
const LibPath = LibraryRelativePathSchema;
const Hash = z.string().min(1).max(200);

export const instanceApi = api({
  queries: {
    status: query(z.object({}), InstanceStatusViewSchema),
    /** The library's skills, tags, instructions and issues (Step 2's developer page). */
    librarySnapshot: query(z.object({}), LibrarySnapshotViewSchema),
    /** The library's branch, changes, history and merge state (Step 3's developer page). */
    libraryGit: query(z.object({}), LibraryGitViewSchema),
    /** The sign-in and whether the host still lets the user in (Step 4). */
    access: query(z.object({}), AccessViewSchema),
    /** The setup wizard while the instance is setting up (PLAN.md §3.17); null once it's ready. */
    setupWizard: query(z.object({}), SetupWizardViewSchema.nullable()),
    /** The summary: what [Finish] does, with its plan hash (PLAN.md §3.17 step 9). */
    setupSummary: query(z.object({}), SetupSummaryViewSchema),
    /** What the remove-instance dialog says about the library folder (PLAN.md §3.8 S12). */
    removalCheck: query(z.object({}), RemovalCheckViewSchema),
    /** The tools page (PLAN.md §3.4): detection, what's enabled, the link folders and the duplicates. */
    tools: query(z.object({}), ToolsViewSchema),
    /** The confirmation for enabling or disabling tools: the plan it would apply. */
    previewTools: query(z.object({ enabled: z.array(Id).max(200) }), LinkPlanViewSchema),
    /** The plan an answer to a warning would apply (PLAN.md §3.8). */
    previewDecision: query(z.object({ dest: Path, decision: LinkDecisionSchema }), LinkPlanViewSchema),
    /** Each skill with its links and their states. */
    skillLinks: query(z.object({}), SkillLinksViewSchema),
    /** "Needs attention": the red warnings (PLAN.md §3.8). */
    attention: query(z.object({}), z.array(AttentionItemSchema)),
    /** The activity log, newest first (PLAN.md §3.13). */
    activity: query(ActivityFilterSchema, z.array(ActivityEntryViewSchema)),
    /** S4 [Show differences]: which files of a changed copy differ from the library's. */
    folderDifferences: query(z.object({ dest: Path }), z.array(FileDifferenceSchema)),
    /** The overview (PLAN.md §3.6): every skill × Global and each added repo, with the repos and the tags. */
    overview: query(z.object({}), OverviewViewSchema),
    /** The confirmation of a placement change: the plan it would apply, and where each skill moves. */
    previewPlacement: query(z.object({ edits: PlacementEditsSchema }), PlacementPlanViewSchema),
    /** Tools that may list a skill twice in nested repos (A6.12; the Doctor shows it from Step 7). */
    placementAnalysis: query(z.object({}), z.array(NestedRepoWarningSchema)),
    /** The Instructions page's part for this instance (PLAN.md §3.12): each tool's state, and what waits. */
    instructions: query(z.object({}), InstructionsViewSchema),
    /** The bring-in dialog: the changed text, the library's, and the plan the answer would apply. */
    previewInstruction: query(
      z.object({ key: Path, decision: InstructionDecisionSchema }),
      InstructionPreviewViewSchema,
    ),
    /** The Doctor view (PLAN.md §3.4). */
    doctor: query(z.object({}), DoctorViewSchema),
    /** The library's local prefix on this device (Step 8, PLAN.md §3.3). */
    localPrefix: query(z.object({}), LocalPrefixViewSchema),
    /** What a new local prefix would mean, or dropping it (`prefix: null`), and whether it may be used. */
    previewLocalPrefix: query(z.object({ prefix: z.string().max(100).nullable() }), LocalPrefixPreviewSchema),
    /** The library's prefix, its lock, and what the role may do with it (Step 14, PLAN.md §3.2). */
    prefix: query(z.object({}), PrefixStateViewSchema),
    /** The warning before a prefix change: the renames, mentions, open requests, and this device's clash. */
    previewPrefixChange: query(
      z.object({ prefix: z.string().max(100), localPrefix: z.string().max(100).nullable() }),
      PrefixChangePreviewViewSchema,
    ),
    /** A change that waits in "Needs attention": the local prefix typed, checked against the new git prefix. */
    previewAdoptPrefix: query(z.object({ localPrefix: z.string().max(100).nullable() }), PrefixAdoptViewSchema),
    /** The both-changed dialog: the files that differ, and the plan the answer would apply. */
    copyDifferences: query(z.object({ key: Path, keep: CopyDecisionSchema }), CopyConflictViewSchema),
    /** The pre-flight check of a new location (Step 9, PLAN.md §3.9 step 0). */
    previewRelocation: query(z.object({ to: Path }), RelocationPreviewSchema),
    /** A move under way or unfinished (PLAN.md §3.9 "Crash at any point"). */
    relocation: query(z.object({}), RelocationStatusSchema),
    /** S9 [Locate folder…]: whether the picked folder holds this library with the same remote. */
    checkLocate: query(z.object({ path: Path }), LocateCheckSchema),
    /** Whether the connections wait for [Recover connections] (PLAN.md §3.5). */
    recovery: query(z.object({}), RecoveryStateSchema),
    /** The editor (Step 10): a skill's file or the instructions, as on disk. */
    libraryFile: query(z.object({ path: LibPath }), LibraryFileViewSchema),
    /** A skill's files and folders. */
    skillFiles: query(z.object({ skill: Id }), z.array(SkillFileEntryViewSchema)),
    /** Version history of a skill's folder or the instructions file (PLAN.md §3.14). */
    history: query(z.object({ path: LibPath }), z.array(VersionEntryViewSchema)),
    /** A file's text in a past version; null when it wasn't there. */
    versionText: query(z.object({ commit: Hash, path: LibPath }), z.object({ text: z.string().nullable() })),
    /** "What the agent sees" per enabled tool (PLAN.md §3.14). */
    agentView: query(z.object({ skill: Id }), z.array(AgentToolViewSchema)),
    /** The sync bar (Step 11, PLAN.md §3.10): branch, ↓ incoming, ↑ to push, offline, a merge under way. */
    syncStatus: query(z.object({}), SyncStatusViewSchema),
    /** The changes screen: local changes by skill, and the commits not pushed yet. */
    changes: query(z.object({}), ChangesViewSchema),
    /** A changed file against the last commit. */
    changeDiff: query(z.object({ path: LibPath }), FileDiffViewSchema),
    /** What committing these paths would ask or refuse (secrets, deletions, large files, letter case, …). */
    commitChecks: query(z.object({ paths: z.array(LibPath).min(1).max(10_000) }), CommitChecksViewSchema),
    /** The incoming preview, with the answers to its questions applied. */
    incoming: query(
      z.object({
        edits: z.array(PlacementEditSchema).max(5000),
        localPrefix: z.string().max(100).nullable().optional(),
      }),
      IncomingPreviewViewSchema,
    ),
    conflicts: query(z.object({}), ConflictsViewSchema),
    /** One conflicted file: its text with markers, and the base, current and incoming versions. */
    conflictFile: query(z.object({ path: LibPath }), ConflictFileViewSchema),
    branches: query(z.object({}), BranchesViewSchema),
    stashes: query(z.object({}), z.array(StashViewSchema)),
    /** The library's history, or one skill's. */
    gitHistory: query(HistoryInputSchema, z.array(HistoryEntryViewSchema)),
    gitCommit: query(z.object({ id: Hash }), CommitViewSchema),
    /** A file before and after a commit. */
    commitDiff: query(z.object({ id: Hash, path: LibPath }), FileDiffViewSchema),
    /** The role and what it allows here (Step 12, PLAN.md §3.11), and the branch. */
    reviewStatus: query(z.object({}), ReviewStatusViewSchema),
    /** [Commit to a new branch]'s name for the skills being committed. */
    suggestBranch: query(z.object({ skills: z.array(Id).max(1000) }), z.object({ branch: z.string() })),
    /** The signing key, the user's own keys to choose from, and whether the host has the key. */
    signing: query(z.object({}), SigningViewSchema),
    /** The import under way (Step 13, PLAN.md §3.18): its source, the skills found and what isn't imported. */
    importSession: query(z.object({}), ImportSessionViewSchema.nullable()),
    /** A file of a skill being reviewed, as it will be added. */
    importFile: query(ImportFileInputSchema, LibraryFileViewSchema),
    /** Originals of imported skills that may be replaced now: the skill is in the company version. */
    importOffers: query(z.object({}), z.array(OriginalOfferViewSchema)),
  },
  commands: {
    /** Asks the host again whether the user still has access, and for the role (PLAN.md §3.11 "When"). */
    checkAccess: command(z.object({}), AccessViewSchema),
    /** The access-lost state's [Sign in again]. */
    signInAgain: command(SignInInputSchema, AccessViewSchema, { progress: DeviceCodeProgressSchema }),
    /** Applies the confirmed tools plan; refused with plan.changed when the plan moved on. */
    setTools: command(z.object({ enabled: z.array(Id).max(200), planHash: Hash }), LinkCheckReportSchema),
    resolveLink: command(z.object({ dest: Path, decision: LinkDecisionSchema, planHash: Hash }), LinkCheckReportSchema),
    /** S8 [Restore]: the skill's files from git. */
    restoreSkill: command(z.object({ skill: Id }), LinkCheckReportSchema),
    restoreFromTrash: command(z.object({ id: z.string().min(1).max(100) }), LinkCheckReportSchema),
    /** The health check now (PLAN.md §3.8 "When"). */
    checkLinks: command(z.object({}), LinkCheckReportSchema),
    /** Adds a code repo the user picked (PLAN.md §3.6 "Adding repos"). */
    addRepo: command(z.object({ path: Path }), RepoViewSchema),
    /** Adds a parent folder: the repos found one level down. */
    addRepoRoot: command(z.object({ path: Path }), z.array(RepoViewSchema)),
    /** Applies a confirmed placement change; refused with plan.changed when the plan moved on. */
    applyPlacement: command(z.object({ edits: PlacementEditsSchema, planHash: Hash }), LinkCheckReportSchema),
    /** S10 [Locate]: the repo's new folder; its remote must match. */
    locateRepo: command(z.object({ repo: Id, path: Path }), LinkCheckReportSchema),
    /** The setup wizard's pages (Step 15): each answer is recorded; [Finish] carries them out. */
    setupGo: command(z.object({ page: SetupPageSchema }), z.object({})),
    setupChooseTools: command(z.object({ enabled: z.array(Id).max(200) }), z.object({})),
    setupTickTag: command(z.object({ repo: Id, tag: z.string().min(1).max(100), on: z.boolean() }), z.object({})),
    setupAnswerName: command(z.object({ dest: Path, choice: SetupNameChoiceSchema.nullable() }), z.object({})),
    /** The Admin's tags page: a skill's tags in its header, and library.yaml's tag hints (PLAN.md §3.17 step 6). */
    setupSetSkillTags: command(
      z.object({ skill: Id, tags: z.array(z.string().min(1).max(100)).max(50) }),
      z.object({}),
    ),
    setupSetLibraryTags: command(
      z.object({
        suggest: z.record(z.string().min(1).max(100), z.array(z.string().min(1).max(200)).max(50)),
        repoOnlyTags: z.array(z.string().min(1).max(100)).max(200),
      }),
      z.object({}),
    ),
    /** Turns a tag suggestion down. */
    dismissSuggestion: command(z.object({ repo: Id, tag: z.string().min(1).max(100) }), z.object({})),
    /** "Bring this change into the library" or "Discard it"; refused with plan.changed when the plan moved on. */
    resolveInstruction: command(
      z.object({ key: Path, decision: InstructionDecisionSchema, planHash: Hash }),
      InstructionCheckReportSchema,
    ),
    /** The instruction check now. */
    checkInstructions: command(z.object({}), InstructionCheckReportSchema),
    /** Enables, changes or drops (`prefix: null`) the local prefix: a durable operation (IMPLEMENTATION.md §2.6). */
    changeLocalPrefix: command(
      z.object({ prefix: z.string().max(100).nullable(), planHash: Hash }),
      LocalPrefixViewSchema,
    ),
    /**
     * The prefix change (Step 14): the correction before the lock, or the Admin's change after it. One commit, pushed
     * at once; refused with plan.changed when the warning moved on.
     */
    changePrefix: command(
      z.object({ prefix: z.string().max(100), localPrefix: z.string().max(100).nullable(), planHash: Hash }),
      z.object({ commit: z.string().max(100), push: PushResultViewSchema }),
    ),
    /** "Needs attention": the local prefix for a new git prefix that clashes here; the adjustments run with it. */
    adoptPrefix: command(z.object({ localPrefix: z.string().max(100), planHash: Hash }), PrefixStateViewSchema),
    /** Both sides of a projected copy changed: keep the library's or the copy's version. */
    resolveCopy: command(z.object({ key: Path, keep: CopyDecisionSchema, planHash: Hash }), LocalPrefixViewSchema),
    /** Moves the library (PLAN.md §3.9); `copy` moves it the different-disk way after Windows refused the rename. */
    relocate: command(z.object({ to: Path, planHash: Hash, copy: z.boolean().optional() }), RelocationSummarySchema, {
      progress: RelocationProgressSchema,
    }),
    /** [Try again] for a move that stopped with an error. */
    retryRelocation: command(z.object({}), RelocationSummarySchema),
    /** S9 [Locate folder…]: the links follow the library to the folder the user picked. */
    locateLibrary: command(z.object({ path: Path }), RelocationSummarySchema),
    /** S9 [Download again]: a fresh download into the configured place. */
    downloadAgain: command(z.object({}), z.object({})),
    /** [Recover connections]: the registry rebuilt from the links, in the tool folders and these repo folders. */
    recoverConnections: command(z.object({ repos: z.array(Path).max(200) }), RecoveryReportSchema),
    /** The editor's save (autosave): refused with editor.changedOnDisk when the file moved on from `base`. */
    saveFile: command(SaveFileInputSchema, SaveResultViewSchema),
    /** The new-skill wizard: a skill from a template; it's linked by the next check. */
    createSkill: command(NewSkillInputSchema, z.object({ folder: z.string() })),
    /** A dropped or picked file into a skill: over 50 MB refused, over 10 MB `large`. */
    addSkillFile: command(AddSkillFileInputSchema, AddFileResultViewSchema),
    deleteSkillFile: command(z.object({ path: LibPath }), z.object({})),
    /** Renames a skill's folder and its `name:` line; its placement choices move with it. */
    renameSkill: command(z.object({ from: Id, to: Id }), z.object({ folder: z.string() })),
    /** [Restore this version]: the past version in the working tree, "Modified on this device". */
    restoreVersion: command(z.object({ path: LibPath, commit: Hash }), z.object({})),
    /** [Fetch] now (Step 11): nothing in the library folder changes. */
    fetch: command(z.object({}), z.object({})),
    /** Commit (and push): a result with the checks when they need an answer first. */
    commit: command(CommitInputSchema, CommitResultViewSchema),
    discard: command(z.object({ paths: z.array(LibPath).min(1).max(10_000) }), z.object({})),
    undoLastCommit: command(z.object({}), z.object({})),
    /** Pull exactly the previewed commit; refused with plan.changed when the preview moved on. */
    pull: command(PullInputSchema, PullResultViewSchema),
    push: command(z.object({ confirmSecrets: z.boolean() }), PushResultViewSchema),
    /** [Keep mine] / [Use theirs] (binary), [Keep it] / [Delete it] (edit vs delete). */
    takeConflict: command(z.object({ path: LibPath, take: z.enum(['ours', 'theirs', 'delete']) }), z.object({})),
    /** [Mark as resolved]: refused while markers remain. */
    markResolved: command(z.object({ paths: z.array(LibPath).min(1).max(10_000) }), z.object({})),
    /** [Commit merge] or [Continue]. */
    continueOperation: command(z.object({}), ContinueResultViewSchema),
    /** [Abort merge]. */
    abortOperation: command(z.object({}), z.object({})),
    createBranch: command(
      z.object({ name: z.string().min(1).max(200), switchTo: z.boolean() }),
      SwitchResultViewSchema,
    ),
    switchBranch: command(z.object({ name: z.string().min(1).max(200), stash: z.boolean() }), SwitchResultViewSchema),
    /** Merges a branch into the current one; `remote`: the branch as the server has it (origin/<name>). */
    mergeBranch: command(
      z.object({ name: z.string().min(1).max(200), remote: z.boolean().optional() }),
      MergeResultViewSchema,
    ),
    deleteBranch: command(z.object({ name: z.string().min(1).max(200), force: z.boolean() }), z.object({})),
    stash: command(z.object({ message: z.string().max(500) }), z.object({})),
    applyStash: command(z.object({ index: z.number().int().nonnegative(), drop: z.boolean() }), StashResultViewSchema),
    dropStash: command(z.object({ index: z.number().int().nonnegative() }), z.object({})),
    revertCommit: command(z.object({ id: Hash }), RevertResultViewSchema),
    /** The author of the app's commits, asked once when the host gave none. */
    setCommitIdentity: command(CommitIdentitySchema, z.object({})),
    /** The fetch timer (off for SSH keys that ask for a touch) and merge or rebase. */
    setSyncSettings: command(
      z.object({ fetchTimer: z.boolean().optional(), pullMode: z.enum(['merge', 'rebase']).optional() }),
      z.object({}),
    ),
    /** [Commit to a new branch]: the branch takes the local changes along, then the chosen paths are committed. */
    commitToNewBranch: command(CommitToBranchInputSchema, CommitResultViewSchema),
    /** [Push and open change request]: pushes the branch and finds the page that makes the request (ADR 0032). */
    openRequest: command(OpenRequestInputSchema, OpenResultViewSchema),
    /** [Move my commits to a new branch]: the company branch goes back to the company's version. */
    moveCommits: command(z.object({ branch: z.string().min(1).max(200) }), z.object({})),
    /** The public key file the user picked (main read its line), or `createSigningKey` for a new one. */
    chooseSigningKey: command(z.object({ path: Path, publicKey: z.string().min(1).max(20_000) }), z.object({})),
    createSigningKey: command(z.object({}), z.object({})),
    /** Registers the signing key on the host through its API (GitHub, GitLab). */
    registerSigningKey: command(z.object({}), z.object({})),
    /** [Sign my unpushed commits and push again]. */
    signAndPush: command(z.object({ confirmSecrets: z.boolean() }), PushResultViewSchema),
    /** Reads a source (a repo URL, a folder, a zip) and finds its skills; an earlier import ends. */
    startImport: command(ImportSourceInputSchema, ImportSessionViewSchema, { progress: ImportProgressSchema }),
    /** Opens a found skill for review: it's staged as it will be added, and gets its ✓. */
    reviewImportSkill: command(z.object({ id: Id }), ImportReviewViewSchema),
    /** The name the skill gets in the library. */
    renameImportSkill: command(z.object({ id: Id, name: z.string().min(1).max(200) }), ImportReviewViewSchema),
    /** The reviewer's edits to a staged file. */
    saveImportFile: command(SaveImportFileInputSchema, SaveResultViewSchema),
    /** [Add]: refused until every selected skill was opened. The skills land as uncommitted changes. */
    addImportedSkills: command(z.object({ ids: z.array(Id).min(1).max(1000) }), ImportReportViewSchema),
    cancelImport: command(z.object({}), z.object({})),
    /** [Replace]: the original goes to the trash, the company skill stays linked. */
    replaceOriginal: command(z.object({ skill: Id }), z.object({})),
    /** [Keep both]. */
    keepOriginal: command(z.object({ skill: Id }), z.object({})),
  },
  events: {
    statusChanged: InstanceStatusViewSchema,
    /** The snapshot changed; the renderer asks for it again. */
    libraryChanged: z.object({}),
    /** Something in the library folder or its .git changed; the git state may have too. */
    gitChanged: z.object({}),
    accessChanged: AccessViewSchema,
    /** Links, warnings or the activity log changed. */
    linksChanged: z.object({ attention: z.number().int().nonnegative() }),
    /** The instructions' files, blocks or states changed (Step 7). */
    instructionsChanged: z.object({}),
    /** The sync state changed (Step 11): a fetch, a commit, a pull, a conflict resolved. */
    syncChanged: z.object({ incoming: z.number().int().nonnegative(), toPush: z.number().int().nonnegative() }),
    /** The role, the requests or the signing changed (Step 12). */
    reviewChanged: z.object({}),
    /** The import, its reviews or the originals to replace changed (Step 13). */
    importChanged: z.object({}),
    /** The prefix, its lock, or a change that waits for a local prefix changed (Step 14). */
    prefixChanged: z.object({}),
    /** The setup wizard's state changed (Step 15). */
    setupChanged: z.object({}),
  },
});

export type InstanceApi = typeof instanceApi;
