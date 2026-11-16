// The projection module (IMPLEMENTATION.md Step 8, PLAN.md §3.3): the local prefix, its choice and the durable
// operation that enables, changes or drops it, and the projected copies that the tool links point at under it.
export {
  ChangeLocalPrefix,
  type CopyConflictView,
  CopyDifferences,
  type DevicePrefixes,
  type FileComparison,
  LOCAL_PREFIX_OPERATION,
  type LocalPrefixPreview,
  LocalPrefixQuery,
  type LocalPrefixState,
  localPrefixSteps,
  PreviewLocalPrefix,
  type PrefixCheck,
  type ProjectionNotice,
  ProjectionService,
  type ProjectionServiceDeps,
  ResolveCopy,
  ResumeOperations,
  type SkipReason,
} from './app/projection-service.ts';
export {
  projectionReconciler,
  type ProjectionInputs,
  type ProjectionReconcilerDeps,
  readCopyRow,
  renamedSkillMd,
} from './app/projection-reconciler.ts';
export { prefixesUsedByFolders } from './app/user-folders.ts';
export {
  clashOf,
  type LocalPrefixContext,
  localPrefixCandidates,
  type LocalPrefixProblem,
  localPrefixProblem,
  longestFitting,
  projectedName,
  shorterSuggestion,
  suggestLocalPrefix,
  tooLongUnder,
} from './domain/local-prefix.ts';
export {
  BOTH_CHANGED,
  type CopyDecision,
  planProjection,
  type ProjectionAction,
  type ProjectionDesired,
  type ProjectionObserved,
  projectionRowAfter,
  type ProjectionScope,
} from './domain/projection.ts';
