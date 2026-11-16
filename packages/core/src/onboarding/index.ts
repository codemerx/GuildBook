// The onboarding module (IMPLEMENTATION.md §2.3, PLAN.md §3.17): setting up and joining a library. Step 4 adds the URL
// check, sign-in and the download, the folder check, creating a library, and access to it afterwards; Step 15 adds
// the remaining wizard pages.
export { checkDownloadedLibrary, type DownloadedLibrary } from './domain/downloaded-library.ts';
export {
  type CheckedLibraryUrl,
  checkLibraryUrl,
  type ConnectedLibrary,
  defaultLibraryFolder,
  libraryName,
  type LibraryUrlProblem,
} from './domain/library-url.ts';
export {
  checkLocation,
  type CloudService,
  cloudService,
  DEFAULT_NEEDED_BYTES,
  expandHome,
  type LocationCheck,
  type LocationContext,
  type LocationFacts,
  type LocationProblem,
  type LocationWarning,
  neededBytes,
} from './domain/location.ts';
export {
  checkEmptyRepo,
  type EmptyCheck,
  FIRST_COMMIT_MESSAGE,
  GITATTRIBUTES,
  GITIGNORE_ENTRIES,
  mergeGitignore,
  type NewLibraryFiles,
  newLibraryFiles,
  type RootEntry,
} from './domain/new-library.ts';
export {
  INVITE_LINK_MAX,
  type Invite,
  type InviteCheck,
  inviteLink,
  type InviteProblem,
  isAppLink,
  parseInviteLink,
} from './domain/invite-link.ts';
export {
  FinishSetup,
  SetupAnswerName,
  type SetupChanged,
  SetupChooseTools,
  SetupGo,
  type SetupRepoView,
  SetupSetLibraryTags,
  SetupSetSkillTags,
  type SetupSummary,
  SetupSummaryQuery,
  type SetupTakenName,
  SetupTickTag,
  type SetupToolView,
  SetupWizard,
  type SetupWizardDeps,
  SetupWizardQuery,
  type SetupWizardView,
} from './app/setup-wizard.ts';
export { accessCheckBranch, accessFrom, type HostAccess, hostAccess, keyRole } from './app/access.ts';
export {
  basicHeader,
  defaultTokenUser,
  HostCredentials,
  type HostCredentialsDeps,
  RENEW_AHEAD_MS,
} from './app/credentials.ts';
export { checkFolder, type FolderCheckDeps, folderFacts } from './app/folder.ts';
export {
  type ConnectedInstance,
  type DownloadOutcome,
  type SetupOffer,
  type SetupResult,
  SetupSession,
  type SetupSessionDeps,
  type SetupSnapshot,
  type SetupStep,
  type SignInInput,
  type SignInRequest,
} from './app/setup.ts';
export {
  credentialFor,
  type CredentialForOptions,
  deviceSignIn,
  type DeviceSignInOptions,
  endpointFor,
  SLOW_DOWN_MS,
  wait,
} from './app/sign-in.ts';
export {
  type AccessLostReason,
  type AccessSnapshot,
  InstanceAccess,
  type InstanceAccessDeps,
} from './app/instance-access.ts';
