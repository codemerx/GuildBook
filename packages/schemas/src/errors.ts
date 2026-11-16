// Every error code the app can report, as stable strings (IMPLEMENTATION.md §2.12, §3.2). Each code has a translated
// message in the renderer, which a test checks (TESTING.md §8 "Every error code has a translated message").
import { z } from 'zod';

export const errorCodes = [
  // Anything unexpected: a bug, logged and shown plainly.
  'internal',
  // The RPC runtime (IMPLEMENTATION.md §2.8).
  'rpc.invalidMessage',
  'rpc.unknownMethod',
  'rpc.invalidInput',
  'rpc.invalidOutput',
  'rpc.cancelled',
  'rpc.disconnected',
  'rpc.timeout',
  // Persisted data written by a newer app version is left untouched (IMPLEMENTATION.md §2.7).
  'device.newerData',
  'device.unreadable',
  'instance.newerData',
  'instance.notFound',
  'instance.workerFailed',
  'instance.migrationFailed',
  // The guarded file system (IMPLEMENTATION.md §2.10).
  'fs.outsideAllowedRoots',
  'fs.throughLink',
  'fs.notFound',
  // Test libraries (Step 1's thin slice, test and development builds only).
  'testLibrary.nameInvalid',
  'testLibrary.pathInvalid',
  'testLibrary.alreadyAdded',
  // The asset protocol (IMPLEMENTATION.md §2.8).
  'asset.outsideLibrary',
  'asset.notFound',
  // Reconcilers, operations and locks (IMPLEMENTATION.md §2.5, §2.6, §2.13 rule 8).
  'plan.changed',
  'command.cancelled',
  'command.unknown',
  'operation.unknown',
  'operation.failed',
  'lock.cancelled',
  // Git (IMPLEMENTATION.md §2.9): failures; expected outcomes such as conflicts or a rejected push are data.
  'git.authFailed',
  'git.notFound',
  'git.certificate',
  'git.offline',
  'git.busy',
  'git.notARepository',
  'git.notAllowed',
  'git.wouldBeOverwritten',
  'git.nothingToCommit',
  'git.noOperation',
  'git.forbidden',
  'git.failed',
  // Sign-in and hosts (PLAN.md §3.11, §3.17 step 2, ADR 0016).
  'host.noAccess',
  'host.appNotInstalled',
  'host.unauthorized',
  'host.signInDenied',
  'host.signInExpired',
  'host.signInAgain',
  'host.clientIdRequired',
  'host.notSupported',
  'host.offline',
  'host.certificate',
  'host.requestFailed',
  // Setting up and joining (PLAN.md §3.17), and changing an instance's URL (§3.1).
  'setup.notFound',
  'setup.urlInvalid',
  'setup.alreadyConnected',
  'setup.wrongStep',
  'setup.locationInvalid',
  'setup.notSetUp',
  'setup.idInvalid',
  'setup.notEmpty',
  'setup.alreadySetUp',
  'setup.cannotWrite',
  'setup.prefixInvalid',
  'setup.prefixInUse',
  'setup.identityRequired',
  'setup.weakStorageNotConfirmed',
  'setup.needsUpdate',
  'setup.notPublished',
  'setup.tagInvalid',
  'setup.patternInvalid',
  'setup.libraryYamlUnreadable',
  'setup.folderInvalid',
  'invite.invalid',
  'instance.otherLibrary',
  // Tools, links and the trash (PLAN.md §3.4, §3.8).
  'tools.unknown',
  'tools.folderInvalid',
  'tools.customInvalid',
  'links.frozen',
  'links.busy',
  'links.notReady',
  'links.noWarning',
  'links.nameInvalid',
  'links.pathTaken',
  'links.notRestorable',
  'trash.notFound',
  // Export diagnostics (Step 16): the reviewed text is no longer the one to save.
  'diagnostics.expired',
  // Settings → Extra certificates (Step 18): the file holds no certificate.
  'certificate.invalid',
  // App updates (Step 18): the check failed; no network; no newer version to download.
  'update.failed',
  'update.offline',
  'update.notAvailable',
  'trash.pathTaken',
  // Placement: repos, parent folders and tags (PLAN.md §3.6, §3.8 S10, S11).
  'placement.notARepo',
  'placement.notAFolder',
  'placement.libraryFolder',
  'placement.alreadyAdded',
  'placement.repoNotFound',
  'placement.rootNotFound',
  // Instructions (Step 7, PLAN.md §3.12).
  'instructions.paused',
  'instructions.noChange',
  'instructions.othersLinked',
  // The Doctor (Step 7, PLAN.md §3.4).
  'doctor.noCommand',
  // The local prefix and projected copies (Step 8, PLAN.md §3.3).
  'localPrefix.invalid',
  'localPrefix.inUse',
  'localPrefix.same',
  'localPrefix.stillInUse',
  'localPrefix.unresolved',
  'localPrefix.paused',
  'projection.noConflict',
  // Relocation and S9 (Step 9, PLAN.md §3.9, §3.8).
  'relocation.invalid',
  'relocation.unfinished',
  'relocation.notUnfinished',
  'relocation.renameBlocked',
  'relocation.verifyFailed',
  'relocation.pathTaken',
  'relocation.notALibrary',
  'relocation.otherLibrary',
  'relocation.otherRemote',
  'relocation.notMissing',
  // Recovering lost connections (Step 9, PLAN.md §3.5).
  'recovery.notNeeded',
  'placement.remoteMismatch',
  'placement.everywhere',
  'placement.tagUnknown',
  // The editor (Step 10, PLAN.md §3.14).
  'editor.notEditable',
  'editor.notFound',
  'editor.changedOnDisk',
  'editor.fileExists',
  'editor.fileTooLarge',
  'editor.skillExists',
  'editor.nameInvalid',
  'editor.headerUnreadable',
  'editor.notText',
  'history.versionNotFound',
  // The git screens (Step 11, PLAN.md §3.10).
  // Roles, change requests and signing (Step 12, PLAN.md §3.11, §3.10 "Signing").
  'review.notAllowed',
  'review.noApi',
  'review.notARequestBranch',
  'review.signingKeyNeeded',
  'review.keyInvalid',
  'review.keyNotFound',
  'review.signingFailed',
  'sync.identityNeeded',
  'sync.nothingSelected',
  'sync.confirmationNeeded',
  'sync.caseClash',
  'sync.fileTooLarge',
  'sync.markersLeft',
  'sync.libraryTooNew',
  'sync.alreadyPushed',
  'sync.noUpstream',
  'sync.detached',
  'sync.branchName',
  'sync.branchExists',
  'sync.currentBranch',
  'sync.branchNotMerged',
  'sync.nothingToStash',
  'sync.notConflicted',
  'sync.stashNotFound',
  // Imports (Step 13, PLAN.md §3.18).
  'archive.unreadable',
  'archive.sizeMismatch',
  'import.cannotRead',
  'import.urlInvalid',
  'import.sourceNotFound',
  'import.archiveRefused',
  'import.archiveTooLarge',
  'import.noSession',
  'import.unknownSkill',
  'import.notReviewed',
  'import.nothingSelected',
  'import.nameInvalid',
  'import.nameTaken',
  'import.notInCompany',
  'import.originalGone',
  // The prefix lock and the prefix change (Step 14, PLAN.md §3.2).
  'prefix.same',
  'prefix.invalid',
  'prefix.notAllowed',
  'prefix.notReady',
  'prefix.namesBlocked',
  'prefix.localPrefixNeeded',
  'prefix.nothingToAdopt',
  // Everything else.
  'feature.unavailable',
  'url.notAllowed',
  'secrets.unavailable',
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export const ErrorCodeSchema = z.enum(errorCodes);

/** Parameters that a translated message can insert. Plain values only, so they cross every process boundary. */
export type ErrorParams = Readonly<Record<string, string | number | boolean | null>>;

export const ErrorParamsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/** An error as it travels between processes and is shown to the user. */
export const ErrorViewSchema = z.object({
  code: ErrorCodeSchema,
  params: ErrorParamsSchema,
});

export type ErrorView = z.infer<typeof ErrorViewSchema>;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (errorCodes as readonly string[]).includes(value);
}
