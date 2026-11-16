// The tool catalog's format (PLAN.md §3.4): one data entry per tool, not code. It ships with the app and is refreshed
// as a signed file (ADR 0026), so the format is versioned. Field names follow the published data file.
import { z } from 'zod';

export const CATALOG_SCHEMA_VERSION = 1;

const VerifiedSchema = z.object({
  version: z.string(),
  date: z.string(),
  os: z.array(z.enum(['mac', 'win', 'linux'])),
});

/** A limit on the instruction files a tool reads (PLAN.md §3.12): Codex counts bytes, Windsurf characters. */
const LimitSchema = z.object({
  amount: z.number().int().positive(),
  unit: z.enum(['bytes', 'characters']),
});

/**
 * How the company's instructions reach the tool (PLAN.md §3.12, IMPLEMENTATION.md §2.14 "Instruction strategy"):
 * - `import-file`: an owned file in the folder `path` that imports the library's file (Claude Code's `@path`)
 * - `owned-file`: an owned file in the folder `path` with a copy of the text (Copilot CLI). With `import_from`, a
 *   marked block in that file imports the copy by a relative path, because the tool imports only files next to it
 *   (Gemini CLI).
 * - `marked-block`: a marked block with a copy of the text in the file `path` (Codex, Windsurf). With `override`, the
 *   block goes into that file while it has text of its own (Codex's AGENTS.override.md). With `config_entry`, the file
 *   is never created: while it's missing, the tool's config file gets one entry that points at an owned copy next to
 *   it (OpenCode's `instructions` list).
 * - `manual`: the tool keeps them in its settings, not in a file (Cursor); the app shows the text to copy.
 */
const InstructionsSchema = z.object({
  method: z.enum(['import-file', 'owned-file', 'marked-block', 'manual']),
  path: z.string(),
  limit: LimitSchema.nullable(),
  /** The owned file's name after the prefix: `.md` unless the tool wants another, e.g. `.instructions.md`. */
  file_suffix: z
    .string()
    .regex(/^[A-Za-z0-9._-]*\.md$/)
    .optional(),
  import_from: z.string().optional(),
  override: z.string().optional(),
  config_entry: z.string().optional(),
});

export const ToolEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  /** Folders whose existence means "installed". */
  detect: z.array(z.string()),
  /** The environment variable that moves the tool's folder, e.g. CODEX_HOME. */
  home_env: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .nullable(),
  /**
   * The tool's folder inside the one `home_env` names, when the variable names a parent: OpenCode's folder is
   * `$XDG_CONFIG_HOME/opencode`, not the variable's folder itself.
   */
  home_env_subdir: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  /** Every folder the tool reads skills from, in its order. */
  user_skill_dirs: z.array(z.string()),
  repo_skill_dirs: z.array(z.string()),
  repo_lookup: z.enum(['to-git-root', 'past-git-root', 'unknown']),
  same_name_handling: z.enum(['one-wins', 'lists-both', 'unknown']),
  instructions: InstructionsSchema.nullable(),
  list_command: z.string().nullable(),
  version_command: z.string().nullable(),
  follows_links: z.boolean(),
  verified: VerifiedSchema.nullable(),
});

export const CatalogSchema = z.object({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  tools: z.array(ToolEntrySchema),
});

export type ToolEntry = z.infer<typeof ToolEntrySchema>;
export type InstructionsLimit = z.infer<typeof LimitSchema>;
export type InstructionsEntry = z.infer<typeof InstructionsSchema>;
export type InstructionsMethod = InstructionsEntry['method'];
export type Catalog = z.infer<typeof CatalogSchema>;

/** A refreshed catalog's detached signature: ed25519 over the exact bytes of the JSON file (ADR 0026). */
export const CatalogSignatureSchema = z.object({
  keyId: z.string().min(1).max(100),
  /** Base64. */
  signature: z.string().min(1).max(200),
});

export type CatalogSignature = z.infer<typeof CatalogSignatureSchema>;

/** Each tool's instruction-file limit, for the editor's and the Doctor's warnings (PLAN.md §3.12). */
export function instructionLimits(catalog: Catalog): Array<{ tool: string } & InstructionsLimit> {
  return catalog.tools.flatMap((tool) =>
    tool.instructions?.limit ? [{ tool: tool.name, ...tool.instructions.limit }] : [],
  );
}

/** The variables that move tools' folders, which the login-shell reader keeps (PLAN.md §3.4, A1.15). */
export function homeEnvVariables(catalog: Catalog): string[] {
  return [...new Set(catalog.tools.flatMap((tool) => (tool.home_env ? [tool.home_env] : [])))].sort();
}
