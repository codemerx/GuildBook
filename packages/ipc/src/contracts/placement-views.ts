// View models of Step 6 (PLAN.md §3.6): the overview, the repos, the placement edits a confirmation previews, and the
// analysis of nested repos. The renderer sees these, never core's types (IMPLEMENTATION.md §2.8).
import { SkillLinkStatusSchema } from '@app/schemas';
import { z } from 'zod';
import { LinkPlanViewSchema } from './link-views.ts';

const Id = z.string().min(1).max(200);
const Path = z.string().min(1).max(4096);
const Tag = z.string().min(1).max(100);

export const RepoViewSchema = z.object({
  id: Id,
  name: z.string(),
  path: z.string(),
  remote: z.string().nullable(),
  root: z.string().nullable(),
  /** S10: when the folder was found gone, or null. */
  missingSince: z.number().nullable(),
  worktrees: z.array(z.string()),
  rules: z.array(z.string()),
  /** Ticked tags that no skill carries any more. */
  gone: z.array(z.string()),
  /** Tags library.yaml suggests for its remote, not ticked and not turned down. */
  suggestions: z.array(z.string()),
});
export type RepoView = z.infer<typeof RepoViewSchema>;

const How = { via: z.array(z.string()), added: z.boolean() };

export const RepoCellSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('placed'), ...How }),
  z.object({ kind: z.literal('excluded'), ...How }),
  z.object({ kind: z.literal('via-global'), ...How }),
  z.object({ kind: z.literal('off'), ...How }),
  z.object({ kind: z.literal('none') }),
]);
export type RepoCellView = z.infer<typeof RepoCellSchema>;

export const GlobalCellSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('placed') }),
  z.object({ kind: z.literal('by-choice') }),
  z.object({ kind: z.literal('off') }),
  z.object({ kind: z.literal('none'), why: z.enum(['repos', 'excluded', 'repo-only']) }),
]);
export type GlobalCellView = z.infer<typeof GlobalCellSchema>;

export const CellProblemSchema = z.object({
  dest: z.string(),
  status: SkillLinkStatusSchema,
  reason: z.string().nullable(),
  tools: z.array(z.string()),
});
export type CellProblemView = z.infer<typeof CellProblemSchema>;

export const PlacementKindSchema = z.enum(['off', 'everywhere', 'global', 'repos', 'excluded', 'repo-only']);
export type PlacementKindView = z.infer<typeof PlacementKindSchema>;

export const SkillModeViewSchema = z.enum(['default', 'global', 'off']);

export const OverviewRowSchema = z.object({
  skill: z.string(),
  tags: z.array(z.string()),
  mode: SkillModeViewSchema,
  kind: PlacementKindSchema,
  global: GlobalCellSchema,
  globalProblems: z.array(CellProblemSchema),
  cells: z.array(z.object({ repo: z.string(), cell: RepoCellSchema, problems: z.array(CellProblemSchema) })),
  excludedIn: z.array(z.string()),
});
export type OverviewRowView = z.infer<typeof OverviewRowSchema>;

export const OverviewViewSchema = z.object({
  repos: z.array(RepoViewSchema),
  roots: z.array(z.string()),
  tags: z.array(z.object({ tag: z.string(), skills: z.number().int().nonnegative() })),
  repoOnlyTags: z.array(z.string()),
  rows: z.array(OverviewRowSchema),
});
export type OverviewView = z.infer<typeof OverviewViewSchema>;

/** A placement change the user makes (PLAN.md §3.6); a confirmation previews a list of them. */
export const PlacementEditSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rule'), repo: Id, tag: Tag, on: z.boolean() }),
  z.object({ op: z.literal('add'), repo: Id, skill: Id, on: z.boolean() }),
  z.object({ op: z.literal('exclude'), repo: Id, skill: Id, on: z.boolean() }),
  z.object({ op: z.literal('mode'), skill: Id, mode: SkillModeViewSchema }),
  z.object({ op: z.literal('reset'), dropChoices: z.boolean() }),
  z.object({ op: z.literal('retag'), repo: Id, from: Tag, to: Tag }),
  z.object({ op: z.literal('remove-repo'), repo: Id }),
  z.object({ op: z.literal('remove-root'), root: Path, keep: z.array(Id).max(5000) }),
  z.object({ op: z.literal('locate'), repo: Id, path: Path }),
]);
export type PlacementEditView = z.infer<typeof PlacementEditSchema>;

export const PlacedWhereViewSchema = z.object({
  kind: PlacementKindSchema,
  global: z.boolean(),
  repos: z.array(z.string()),
  excludedIn: z.array(z.string()),
});
export type PlacedWhereView = z.infer<typeof PlacedWhereViewSchema>;

export const PlacementPlanViewSchema = LinkPlanViewSchema.extend({
  moves: z.array(z.object({ skill: z.string(), from: PlacedWhereViewSchema, to: PlacedWhereViewSchema })),
});
export type PlacementPlanView = z.infer<typeof PlacementPlanViewSchema>;

export const NestedRepoWarningSchema = z.object({
  outer: z.string(),
  inner: z.string(),
  tool: z.string(),
  lookup: z.enum(['past-git-root', 'unknown']),
});

export const PlacementEditsSchema = z.array(PlacementEditSchema).min(1).max(5000);
