// The instructions module (IMPLEMENTATION.md §2.3, PLAN.md §3.12): the instruction strategies, marked blocks, the
// instruction reconciler, size limits, and the instance's part of linking per company.
export {
  followLinks,
  instructionReconciler,
  type InstructionReconcilerDeps,
  type InstructionScope,
  readInstructionRow,
} from './app/instruction-reconciler.ts';
export {
  CheckInstructions,
  type InstructionArtifactView,
  type InstructionCheckReport,
  type InstructionNotice,
  type InstructionPreview,
  type InstructionSetupPreview,
  InstructionService,
  type InstructionServiceDeps,
  type InstructionsChanged,
  InstructionsQuery,
  type InstructionsState,
  type InstructionToolView,
  PreviewInstruction,
  ResolveInstruction,
} from './app/instruction-service.ts';
export {
  claudeImportLine,
  type DesiredInstruction,
  desiredInstructions,
  type InstructionFacts,
  type InstructionInputs,
  manualTools,
  NO_FACTS,
  ownedFileName,
  relativeImportLine,
  textFingerprint,
} from './domain/artifacts.ts';
export {
  appendBlock,
  beginMarker,
  blockInside,
  type BlockSpan,
  endMarker,
  findBlock,
  hasOwnText,
  lineBreakOf,
  ownText,
  removeBlock,
  replaceInside,
} from './domain/blocks.ts';
export { measure, type RoomLeft, type RoomState, roomLeft } from './domain/limits.ts';
export {
  type InstructionAction,
  type InstructionDecision,
  type InstructionObserved,
  type InstructionPlanInputs,
  type ObservedFile,
  planInstructions,
  type RowDraft,
} from './domain/plan.ts';
