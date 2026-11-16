// View models of Step 5 (PLAN.md §3.4, §3.8, §3.13): the tools page, each skill's links, "Needs attention", the plans
// a confirmation shows, and the activity log. The renderer sees these, never core's types (IMPLEMENTATION.md §2.8).
import { SkillLinkStatusSchema } from '@app/schemas';
import { z } from 'zod';

const Path = z.string().min(1).max(4096);
const Name = z.string().min(1).max(200);

export const ToolViewSchema = z.object({
  id: Name,
  name: Name,
  custom: z.boolean(),
  /** One of its folders exists (PLAN.md §3.4 "Detection"); a custom tool counts as found. */
  found: z.boolean(),
  enabled: z.boolean(),
  /** The tool's own folder, and what put it there: the default, its environment variable, or the user. */
  home: z.string().nullable(),
  homeSource: z.enum(['default', 'env', 'user']),
  homeEnv: z.string().nullable(),
  skillDirs: z.array(z.string()),
  sameNameHandling: z.enum(['one-wins', 'lists-both', 'unknown']),
  verified: z.object({ version: z.string(), date: z.string() }).nullable(),
  /** It reads copies, not links: a copy target (copy mode, Step 16). */
  copy: z.boolean().default(false),
});
export type ToolView = z.infer<typeof ToolViewSchema>;

export const LinkFolderViewSchema = z.object({
  path: z.string(),
  enabledTools: z.array(z.string()),
  readers: z.array(z.string()),
  /** Copy mode (Step 16): the skills go into this folder as copies. */
  copy: z.boolean().default(false),
});

export const DuplicateViewSchema = z.object({
  tool: z.string(),
  enabled: z.boolean(),
  handling: z.enum(['one-wins', 'lists-both', 'unknown']),
  folders: z.array(z.string()),
});

export const ToolsViewSchema = z.object({
  tools: z.array(ToolViewSchema),
  choice: z.object({
    folders: z.array(LinkFolderViewSchema),
    duplicates: z.array(DuplicateViewSchema),
    uncovered: z.array(z.string()),
  }),
});
export type ToolsView = z.infer<typeof ToolsViewSchema>;

export const LinkChangeViewSchema = z.object({
  op: z.enum(['create', 'adopt', 'refresh', 'mark', 'replace', 'move-aside', 'bring-in', 'remove', 'drop', 'forget']),
  skill: z.string(),
  dest: z.string(),
  folder: z.string().nullable(),
  status: SkillLinkStatusSchema.nullable(),
  /** A link, or a copy in a copy-mode folder (Step 16). */
  method: z.enum(['link', 'copy']).default('link'),
});
export type LinkChangeView = z.infer<typeof LinkChangeViewSchema>;

/** A plan as a confirmation shows it; its hash goes back with [Apply] (IMPLEMENTATION.md §2.5). */
export const LinkPlanViewSchema = z.object({
  hash: z.string(),
  changes: z.array(LinkChangeViewSchema),
  kept: z.array(z.object({ tool: z.string(), folder: z.string(), readers: z.array(z.string()) })),
  folders: z.array(z.string()),
});
export type LinkPlanView = z.infer<typeof LinkPlanViewSchema>;

export const LinkStateSchema = z.enum(['done', 'frozen', 'paused', 'not-ready', 'missing', 'prefix-waiting']);

export const SkillLinkViewSchema = z.object({
  dest: z.string(),
  folder: z.string(),
  tools: z.array(z.string()),
  status: z.union([SkillLinkStatusSchema, z.literal('pending')]),
  /** A link, or a copy in a copy-mode folder (Step 16). */
  method: z.enum(['link', 'copy']).default('link'),
});
export type SkillLinkView = z.infer<typeof SkillLinkViewSchema>;

export const SkillLinksViewSchema = z.object({
  state: LinkStateSchema,
  skills: z.array(z.object({ skill: z.string(), links: z.array(SkillLinkViewSchema) })),
});
export type SkillLinksView = z.infer<typeof SkillLinksViewSchema>;

export const AttentionItemSchema = z.object({
  id: z.string(),
  kind: z.union([
    SkillLinkStatusSchema,
    z.enum([
      'frozen',
      'library-missing',
      'connections-lost',
      'relocation-unfinished',
      'repo-missing',
      'tag-gone',
      'copy-conflict',
      'name-too-long',
      'wrong-prefix',
      'prefix-waiting',
    ]),
  ]),
  skill: z.string().nullable(),
  dest: z.string().nullable(),
  folder: z.string().nullable(),
  tools: z.array(z.string()),
  reason: z.string().nullable(),
  takenBy: z.string().nullable(),
  since: z.number(),
  /** The code repo it's about (Step 6): its id and name. */
  repoId: z.string().nullable(),
  repo: z.string().nullable(),
  /** For a tag that no longer exists: the tag, and the repos whose rule uses it. */
  tag: z.string().nullable(),
  repos: z.array(z.string()),
});
export type AttentionItemView = z.infer<typeof AttentionItemSchema>;

/** The user's answer to a warning (PLAN.md §3.8). */
export const LinkDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('overwrite') }),
  z.object({ kind: z.literal('move-aside'), name: z.string().min(1).max(64), rewriteName: z.boolean() }),
  z.object({ kind: z.literal('suppress') }),
  z.object({ kind: z.literal('reinstall') }),
  z.object({ kind: z.literal('take-back') }),
  z.object({ kind: z.literal('leave') }),
  z.object({ kind: z.literal('replace') }),
  z.object({ kind: z.literal('bring-in') }),
  z.object({ kind: z.literal('reenable') }),
  z.object({ kind: z.literal('drop-duplicate') }),
]);
export type LinkDecisionView = z.infer<typeof LinkDecisionSchema>;

export const LinkCheckReportSchema = z.object({
  state: LinkStateSchema,
  applied: z.number().int().nonnegative(),
  attention: z.number().int().nonnegative(),
});

export const FileDifferenceSchema = z.object({
  path: z.string(),
  change: z.enum(['added', 'removed', 'changed']),
});

/** One activity-log entry (PLAN.md §3.13), with what's still in the trash from it. */
export const ActivityEntryViewSchema = z.object({
  id: z.number().int(),
  ts: z.number(),
  kind: z.string(),
  path: z.string().nullable(),
  author: z.string().nullable(),
  details: z.json(),
  trash: z
    .object({
      id: z.string(),
      state: z.enum(['moving', 'kept', 'restored']),
      expiresAt: z.number(),
      originalPath: z.string(),
    })
    .nullable(),
});
export type ActivityEntryView = z.infer<typeof ActivityEntryViewSchema>;

/** A custom tool's instructions file and method (PLAN.md §3.4 "Custom tools"). */
export const CustomToolInstructionsViewSchema = z.object({
  method: z.enum(['marked-block', 'owned-file']),
  path: Path,
});

export const CustomToolViewSchema = z.object({
  id: Name,
  name: Name,
  skillDirs: z.array(Path),
  instructions: CustomToolInstructionsViewSchema.nullable(),
  /** A copy target (Step 16): its folder gets copies of the skills, not links (PLAN.md §3.4 copy mode). */
  copy: z.boolean().default(false),
});

/** Tool settings kept once per device (PLAN.md §3.4): custom tools and the folders the user changed. */
export const ToolSettingsViewSchema = z.object({
  customTools: z.array(CustomToolViewSchema),
  toolFolders: z.record(z.string(), z.string()),
});
export type ToolSettingsView = z.infer<typeof ToolSettingsViewSchema>;

export const LinkRefSchema = { dest: Path };

/**
 * A tool's version or list command, run by main with the login shell's PATH (PLAN.md §3.4 "Keeping the catalog
 * current", the Doctor). The list command's output is filtered to names starting with a prefix in use before it
 * leaves main, so no other skill name is ever stored or sent (PLAN.md §3.7 rule 3).
 */
export const ToolCommandViewSchema = z.object({
  toolId: Name,
  which: z.enum(['version', 'list']),
  state: z.enum(['ok', 'failed', 'not-found', 'none']),
  /** `version`: the version found in the output. */
  version: z.string().max(100).nullable(),
  /** `list`: the skill names it printed that start with a prefix in use. */
  skills: z.array(Name),
  ranAt: z.number().int(),
});
export type ToolCommandView = z.infer<typeof ToolCommandViewSchema>;
