// The prefix module (IMPLEMENTATION.md §2.3, PLAN.md §3.2): the prefix lock, the correction before it, the Admin's
// prefix change, and the adjustments on every device after it (Step 14).
export {
  AdoptPrefix,
  ChangePrefix,
  type PrefixRequest,
  PREFIX_CHANGE_OPERATION,
  type PrefixBlocker,
  type PrefixChangePreview,
  type PrefixChangeResult,
  prefixChangeSteps,
  type PrefixMention,
  type PrefixNotice,
  PrefixQuery,
  PrefixService,
  type PrefixServiceDeps,
  type PrefixState,
  type PrefixWaiting,
  PreviewAdoptPrefix,
  PreviewPrefixChange,
  type PullPrefixChange,
} from './app/prefix-service.ts';
export {
  newPrefixProblem,
  type NewPrefixProblem,
  newPrefixWarnings,
  type PrefixAction,
  prefixAction,
  type PrefixRefusal,
  type PrefixRename,
  type RenamePlan,
  type RenameProblem,
  renamePlan,
} from './domain/prefix-change.ts';
