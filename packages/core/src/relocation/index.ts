// The relocation module (IMPLEMENTATION.md Step 9, PLAN.md §3.9, §3.8 S9): changing the library's location as a
// durable operation, and finding a library folder that was moved outside the app.
export {
  CheckLocate,
  DownloadAgain,
  type LocateCheck,
  LocateLibrary,
  type LocateProblem,
  PreviewRelocation,
  Relocate,
  type RelocationPreview,
  RelocationQuery,
  RelocationService,
  type RelocationServiceDeps,
  type RelocationStatus,
  RetryRelocation,
} from './app/relocation-service.ts';
export {
  carryOver,
  type CarryOver,
  initialRelocationState,
  isGitPath,
  type Manifest,
  RELOCATION_OPERATION,
  type RelocationMethod,
  type RelocationParams,
  type RelocationProblem,
  type RelocationState,
  relocationSteps,
  type RelocationStep,
  type RelocationSummary,
  type RewrittenConnection,
  summarize,
} from './domain/relocation.ts';
