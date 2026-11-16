// The placement module (IMPLEMENTATION.md §2.3, PLAN.md §3.6): repos, parent folders, worktrees, tags, rules, the
// placement calculator and the exclude entries.
export { excludeReconciler, excludeKey, planExcludes, readExcludeRow } from './app/exclude-reconciler.ts';
export {
  AddRepo,
  AddRepoRoot,
  ApplyPlacement,
  type CellProblem,
  DismissSuggestion,
  type GlobalCell,
  LocateRepo,
  OverviewQuery,
  type OverviewRow,
  type OverviewView,
  persistEdits,
  PlacementAnalysis,
  type PlacementNotice,
  type PlacementPlanView,
  PlacementService,
  type PlacementServiceDeps,
  type PlacedWhereView,
  PreviewPlacement,
  type RepoView,
  sameRemote,
  type WatchedRepo,
} from './app/placement-service.ts';
export {
  calculatePlacement,
  type PlacementInputs,
  type PlacementKind,
  type RepoCell,
  repoCell,
  type SkillPlacement,
} from './domain/calculator.ts';
export { addLine, excludeLine, hasLine, removeLine } from './domain/exclude-file.ts';
export {
  matchesPattern,
  nestedRepos,
  type NestedRepoWarning,
  nestedRepoWarnings,
  remoteSlug,
  repoName,
  suggestedTags,
} from './domain/repos.ts';
export { applyEdit, applyEdits, type PlacementEdit, type PlacementState, renameSkills } from './domain/state.ts';
