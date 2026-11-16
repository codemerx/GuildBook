// The activity module (IMPLEMENTATION.md §2.3, PLAN.md §3.13): the activity log, and the instance's trash that it
// restores from (PLAN.md §3.8 "Retention").
export { type ActivityEntry, type ActivityKind, ActivityLog } from './app/activity-log.ts';
export { DAY_MS, InstanceTrash, type SweepReport, type TrashDeps } from './app/trash.ts';
