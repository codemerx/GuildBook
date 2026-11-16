// The recovery module (IMPLEMENTATION.md Step 9, PLAN.md §3.5): [Recover connections] rebuilds the registry from the
// links on disk when instance.db was lost without a backup.
export {
  RECOVERY_KIND,
  RecoverConnections,
  type RecoveryReport,
  RecoveryQuery,
  RecoveryService,
  type RecoveryServiceDeps,
  type RecoveryState,
} from './app/recovery-service.ts';
export {
  type FoundLink,
  type Recovered,
  type RecoveredLink,
  recoverConnections,
  type RecoveryInputs,
  type RecoveryTool,
} from './domain/recovery.ts';
