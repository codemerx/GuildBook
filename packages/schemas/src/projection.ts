// Projected copies (PLAN.md §3.3): on a device with a local prefix, each skill has a copy in the instance's data folder
// that differs from the library only in its `name:` line, and the tool links point at the copy. A copy's registry row
// is keyed by the copy's folder and remembers what the two sides last agreed on, so a change on either side is found,
// and a change on both sides is asked about.
import { z } from 'zod';

export const PROJECTED_COPY_KIND = 'projected-copy';

/** The folder in the data folder that holds the copies (PLAN.md §3.3). */
export const PROJECTION_FOLDER = 'projection';

/**
 * - `synced`: both sides held the same content at `synced`
 * - `both-changed`: the library and the copy both changed since then; the user chooses which to keep
 */
export const ProjectedCopyStatusSchema = z.enum(['synced', 'both-changed']);
export type ProjectedCopyStatus = z.infer<typeof ProjectedCopyStatusSchema>;

export const ProjectedCopyRowSchema = z.object({
  /** The skill's git name: its folder under skills/. Write-back restores exactly this name (PLAN.md §3.3). */
  skill: z.string().min(1),
  /** The copy's folder name and `name:` line: the skill's name under the local prefix. */
  name: z.string().min(1),
  /**
   * The fingerprint both sides had at the last sync, the copy read with its git name restored. Ignored files don't
   * count.
   */
  synced: z.string().min(1),
  status: ProjectedCopyStatusSchema,
  since: z.number().int(),
});
export type ProjectedCopyRow = z.infer<typeof ProjectedCopyRowSchema>;
