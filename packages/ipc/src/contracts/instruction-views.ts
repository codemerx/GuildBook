// View models of the Instructions page and the Doctor (IMPLEMENTATION.md Step 7, PLAN.md §3.12, §3.4): the shapes the
// renderer gets from an instance's worker. Core's types never cross the port.
import { z } from 'zod';

const Path = z.string().min(1).max(4096);
const Name = z.string().min(1).max(200);
const Hash = z.string().min(1).max(200);
const Text = z.string().max(1_000_000);

export const InstructionDecisionSchema = z.enum(['bring-in', 'discard']);

export const InstructionArtifactViewSchema = z.object({
  key: Path,
  written: Path,
  artifact: z.enum(['owned-file', 'block', 'config-entry']),
  role: z.enum(['copy', 'import']),
  status: z.enum(['linked', 'edited', 'damaged', 'pending']),
  since: z.number().nullable(),
});
export type InstructionArtifactView = z.infer<typeof InstructionArtifactViewSchema>;

export const RoomLeftViewSchema = z.object({
  tool: Name,
  file: Path,
  unit: z.enum(['bytes', 'characters']),
  limit: z.number().int(),
  used: z.number().int(),
  left: z.number().int(),
  state: z.enum(['ok', 'near', 'over']),
  repoFilesCount: z.boolean(),
});
export type RoomLeftView = z.infer<typeof RoomLeftViewSchema>;

export const InstructionToolViewSchema = z.object({
  id: Name,
  name: Name,
  method: z.enum(['import-file', 'owned-file', 'marked-block', 'manual', 'none']),
  artifacts: z.array(InstructionArtifactViewSchema),
  status: z.enum(['linked', 'edited', 'damaged', 'pending', 'manual', 'none', 'off']),
  room: RoomLeftViewSchema.nullable(),
});
export type InstructionToolView = z.infer<typeof InstructionToolViewSchema>;

export const InstructionsViewSchema = z.object({
  state: z.enum(['done', 'frozen', 'paused', 'not-ready']),
  linked: z.boolean(),
  library: z
    .object({ path: Path, bytes: z.number().int().nonnegative(), characters: z.number().int().nonnegative() })
    .nullable(),
  /** The text to paste into Cursor's settings, while Cursor is enabled. */
  manualText: Text.nullable(),
  tools: z.array(InstructionToolViewSchema),
  waiting: z.array(InstructionArtifactViewSchema),
});
export type InstructionsView = z.infer<typeof InstructionsViewSchema>;

export const InstructionPreviewViewSchema = z.object({
  hash: Hash,
  key: Path,
  decision: InstructionDecisionSchema,
  edited: Text,
  library: Text,
  changes: z.array(z.object({ op: z.string().max(50), key: Path })),
});
export type InstructionPreviewView = z.infer<typeof InstructionPreviewViewSchema>;

export const InstructionCheckReportSchema = z.object({
  state: z.enum(['done', 'frozen', 'paused', 'not-ready']),
  applied: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
});

export const DoctorToolViewSchema = z.object({
  id: Name,
  name: Name,
  custom: z.boolean(),
  home: Path.nullable(),
  folders: z.array(
    z.object({
      path: Path,
      links: z.number().int(),
      unreadable: z.array(Name),
      /** Copy mode (Step 16): the skills go here as copies; `changed` lists the ones edited where they are. */
      copy: z.boolean(),
      changed: z.array(Name),
    }),
  ),
  duplicate: z.object({ folders: z.array(Path), handling: z.enum(['one-wins', 'lists-both', 'unknown']) }).nullable(),
  nested: z.array(z.object({ outer: Name, inner: Name, lookup: z.string().max(50) })),
  instructions: InstructionToolViewSchema.shape.status,
  room: RoomLeftViewSchema.nullable(),
  verified: z.object({ version: z.string().max(100), date: z.string().max(100) }).nullable(),
  versionCommand: z.boolean(),
  listCommand: z.boolean(),
  linkedSkills: z.array(Name),
});
export type DoctorToolView = z.infer<typeof DoctorToolViewSchema>;

export const DoctorViewSchema = z.object({
  tools: z.array(DoctorToolViewSchema),
  invalidNames: z.array(
    z.object({
      folder: Name,
      name: z.string().max(500).nullable(),
      problems: z.array(z.string().max(100)),
      tools: z.array(Name),
    }),
  ),
  manual: z.array(Name),
  skillsOnly: z.array(Name),
  uncovered: z.array(Name),
  /** The enabled copy targets and their folders (Step 16): where copies take company content. */
  copyTargets: z.array(z.object({ tool: Name, folders: z.array(Path) })),
  warnings: z.number().int().nonnegative(),
});
export type DoctorView = z.infer<typeof DoctorViewSchema>;
