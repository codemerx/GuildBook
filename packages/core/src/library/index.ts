// The library module (IMPLEMENTATION.md §2.3): library.yaml, the SKILL.md model, the names, git URLs, the scanner over a
// LibrarySource, the snapshot and its validation, and fingerprints.
export {
  AddSkillFile,
  type AddFileResult,
  CreateSkill,
  DeleteSkillFile,
  type EditorActivity,
  type LibraryFile,
  LibraryFiles,
  type LibraryFilesDeps,
  ReadLibraryFile,
  RenameSkill,
  SaveLibraryFile,
  type SaveResult,
  type SkillFileEntry,
  SkillFilesQuery,
} from './app/library-files.ts';
export { LibraryModel, type LibraryModelDeps } from './app/library-model.ts';
export { isFetchBookkeeping } from './domain/watch-events.ts';
export {
  DROP_FOLDERS,
  type DropFolder,
  type EditablePath,
  editablePath,
  fileKind,
  type FileKind,
  fileNameOk,
  fileSizeRule,
  INSTRUCTIONS_PATH,
  isText,
} from './domain/editable.ts';
export { type NewSkill, SKILL_TEMPLATES, type SkillTemplate, skillFiles } from './domain/templates.ts';
export {
  type LibraryChanged,
  LibraryService,
  type LibraryServiceDeps,
  LibrarySnapshotQuery,
  LoadLibrary,
  RefreshLibrary,
} from './app/library-service.ts';
export {
  type Affected,
  affectedBy,
  fingerprintFolder,
  MARKDOWN_SCAN_MAX,
  refreshLibrary,
  type ScanOptions,
  scanLibrary,
  scanSkill,
} from './app/scanner.ts';
export { gitTreeSource, type LibrarySource, overlaySource, type SourceEntry, workingTreeSource } from './app/source.ts';
export {
  blobId,
  EMPTY_TREE,
  type FileMode,
  isFingerprintJunk,
  linkBlobId,
  type TreeFile,
  treeId,
} from './domain/fingerprint.ts';
export { type GitUrl, type GitUrlKey, type GitUrlProblem, parseGitUrl, sameRepository } from './domain/git-url.ts';
export {
  compareIssues,
  type Issue,
  type IssueCode,
  issue,
  issueCodes,
  type IssueParams,
  type IssueSeverity,
  issueSeverities,
} from './domain/issues.ts';
export { type Compatibility, type LibraryConfig, readLibraryConfig } from './domain/library-config.ts';
export { type MarkdownLink, markdownLinks, resolveLink } from './domain/markdown-links.ts';
export {
  effectivePrefix,
  type LibraryId,
  localName,
  newLibraryId,
  parseLibraryId,
  parsePrefix,
  parseSkillName,
  parseTag,
  type Prefix,
  type SkillName,
  type Tag,
  withOtherPrefix,
} from './domain/names.ts';
export {
  caseConflictIssues,
  type EntryFacts,
  fileSizeIssues,
  headerIssues,
  type InstructionLimit,
  instructionIssues,
  layoutIssues,
  markdownLinkIssues,
  NEAR_LIMIT,
  SKILL_MD_MAX_LINES,
  skillLengthIssues,
  type SkillFacts,
  symlinkIssues,
  WINDOWS_MAX_PATH,
  windowsPathIssues,
} from './domain/rules.ts';
export {
  buildSnapshot,
  fingerprintOf,
  INSTRUCTIONS_DIR,
  INSTRUCTIONS_FILE,
  type LibraryFacts,
  libraryPaths,
  type LibrarySnapshot,
  type SkillSummary,
  SKILLS_DIR,
  type SnapshotContext,
} from './domain/snapshot.ts';
export { compareVersions } from './domain/versions.ts';
