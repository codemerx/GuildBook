export {
  type CommandContext,
  type CommandDef,
  type CommandHandler,
  defineCommand,
  defineQuery,
  type EngineEvent,
  type EngineStatus,
  type ExecuteOptions,
  InstanceEngine,
  type Progress,
  type QueryDef,
  type QueryHandler,
} from './app/engine.ts';
export {
  type ApplyOptions,
  type ApplyReport,
  type CombinedPlan,
  combinePlans,
  type Conflict,
  makePlan,
  type Plan,
  type PlanBody,
  reconcileFaultPoints,
  type Reconciler,
  ReconcileRunner,
} from './app/reconciler.ts';
export { Scheduler } from './app/scheduler.ts';
export { coalesceTarget, nextIndex, type QueuedItem, shouldPreempt } from './domain/queue.ts';
export { WatchSet, type WatchSetOptions } from './app/watch-set.ts';
export { isWatchMarker, mergeChange, type WatchChange, WATCH_MARKER_PREFIX } from './domain/watch-events.ts';
