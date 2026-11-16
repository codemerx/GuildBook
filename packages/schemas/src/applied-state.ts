// The applied-state baseline (IMPLEMENTATION.md Step 3, PLAN.md §3.10): the commit and the skill list an instance last
// adjusted links for, so "before and after" can be compared even when the app wasn't watching. Kept in instance.db.
import { z } from 'zod';

export const AppliedSkillSchema = z.object({
  /** The skill's folder under skills/. */
  folder: z.string().min(1),
  /** git's tree id of the folder. */
  fingerprint: z.string().regex(/^[0-9a-f]{40,64}$/),
});

export const AppliedStateSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  skills: z.array(AppliedSkillSchema),
  /** Epoch milliseconds, from the instance's clock. */
  recordedAt: z.number().int(),
});

export type AppliedSkill = z.infer<typeof AppliedSkillSchema>;
export type AppliedState = z.infer<typeof AppliedStateSchema>;
