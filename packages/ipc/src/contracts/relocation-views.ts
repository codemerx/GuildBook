// View models of Step 9: changing the library's location (PLAN.md §3.9) with its pre-flight check, progress and
// summary; S9's locate check (§3.8); and [Recover connections] (§3.5). Core's types never cross the port.
import { z } from 'zod';
import { LocationCheckViewSchema } from './views.ts';

const Name = z.string().min(1).max(200);
const Path = z.string().min(1).max(4096);

/** The pre-flight check of a new location: problems refuse it, warnings (a cloud folder) don't. */
export const RelocationPreviewSchema = LocationCheckViewSchema.extend({
  method: z.enum(['rename', 'copy']),
  hash: z.string().max(200),
});
export type RelocationPreviewView = z.infer<typeof RelocationPreviewSchema>;

/** "Library moved to ~/Work/acme. 214 files · 4 connections updated (Claude Code ×3, …) · 0 skipped" (§3.9). */
export const RelocationSummarySchema = z.object({
  from: Path,
  to: Path,
  method: z.enum(['rename', 'copy', 'locate']),
  files: z.number().int().nonnegative(),
  connections: z.number().int().nonnegative(),
  groups: z.array(z.object({ tools: z.array(Name), count: z.number().int().positive() })),
  skipped: z.array(Path),
  carried: z.array(Path),
  keptBoth: z.array(Path),
});
export type RelocationSummaryView = z.infer<typeof RelocationSummarySchema>;

export const RelocationProgressSchema = z.object({ done: z.number().int(), total: z.number().int() });

/** A move that's under way or stopped with an error, tried again at the next start or with [Try again]. */
export const RelocationStatusSchema = z.object({
  unfinished: z
    .object({ id: z.string().max(100), from: Path, to: Path, error: z.object({ code: z.string() }).nullable() })
    .nullable(),
});
export type RelocationStatusView = z.infer<typeof RelocationStatusSchema>;

/** S9 [Locate folder…]: what the picked folder is. */
export const LocateCheckSchema = z.object({
  path: z.string().max(4096),
  problems: z.array(z.object({ code: z.string(), params: z.record(z.string(), z.string()) })),
});
export type LocateCheckView = z.infer<typeof LocateCheckSchema>;

/** Whether the connections wait for [Recover connections] (PLAN.md §3.5). */
export const RecoveryStateSchema = z.object({ needed: z.boolean(), since: z.number().int().nullable() });
export type RecoveryStateView = z.infer<typeof RecoveryStateSchema>;

export const RecoveryReportSchema = z.object({
  links: z.number().int().nonnegative(),
  tools: z.array(Name),
  repos: z.array(z.object({ name: Name, skills: z.array(Name) })),
  notRepos: z.array(Path),
});
export type RecoveryReportView = z.infer<typeof RecoveryReportSchema>;
