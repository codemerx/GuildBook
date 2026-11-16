// The imports module (IMPLEMENTATION.md §2.3, PLAN.md §3.18): import sources, the layout scanner, name fixing,
// `metadata.source`, safe unpacking and the review gate.
export {
  AddImportedSkills,
  CancelImport,
  type ImportCandidate,
  type ImportFile,
  type ImportFileEntry,
  ImportFileQuery,
  ImportOffersQuery,
  type ImportReport,
  type ImportReview,
  ImportService,
  type ImportServiceDeps,
  ImportSessionQuery,
  type ImportSessionView,
  type ImportSource,
  KeepOriginal,
  type OriginalOffer,
  RenameImportSkill,
  ReplaceOriginal,
  ReviewImportSkill,
  SaveImportFile,
  StartImport,
  withImportHeader,
} from './app/import-service.ts';
export { type FoundSkill, type ScanResult, scanSource } from './app/source-scan.ts';
export { unpackArchive } from './app/unpack.ts';
export {
  ARCHIVE_ENTRIES_MAX,
  ARCHIVE_FILE_MAX,
  ARCHIVE_TOTAL_MAX,
  type ArchiveProblem,
  type ArchiveProblemCode,
  archiveProblems,
  entryPath,
} from './domain/archive.ts';
export { type LayoutKind, type NotImported, type NotImportedKind } from './domain/layout.ts';
export { importedName, nameUsable, standardName } from './domain/naming.ts';
export { type Mention, mentionsOf, reviewGate, type SkillFlags, skillFlags } from './domain/review.ts';
export { repoOf, sourceRecord, type SourceFacts } from './domain/source-record.ts';
