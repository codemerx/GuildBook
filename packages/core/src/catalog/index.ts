// The catalog module (IMPLEMENTATION.md §2.3, PLAN.md §3.4): the tools on this device, detection, the choice of link
// folders and the duplicate analysis.
export { detectTools } from './app/detect.ts';
export {
  chooseLinkFolders,
  chooseRepoLinkFolders,
  duplicateAnalysis,
  type DuplicateReport,
  type LinkFolder,
  type LinkFolderChoice,
} from './domain/link-folders.ts';
export {
  type CustomTool,
  type CustomToolInstructions,
  customToolId,
  expandPath,
  NO_TOOL_SETTINGS,
  type ResolvedInstructions,
  type ResolvedTool,
  resolveTools,
  type SameNameHandling,
  type ToolFolderSource,
  type ToolSettings,
} from './domain/tools.ts';
