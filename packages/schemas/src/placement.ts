// Placement (PLAN.md §3.6): where each skill is linked on this device. The added repos and parent folders, the tag
// rules, the individual additions and exclusions, and each skill's mode are personal choices kept in instance.db
// ("Stored where"). Skills are named by their git name, so a rename moves the choices with them (§3.8 S6).
import { z } from 'zod';

/** A repo's id in instance.db: the folder may move (S10 [Locate]), the id stays. */
export const RepoIdSchema = z.string().regex(/^repo_[0-9a-z]{4,32}$/, 'not a repo id');
export type RepoId = z.infer<typeof RepoIdSchema>;

export const RepoRecordSchema = z.object({
  id: RepoIdSchema,
  /** The main checkout's folder, absolute. */
  path: z.string().min(1),
  /** The `origin` remote's URL as git reports it, or null when the repo has none. */
  remote: z.string().nullable(),
  /** What the UI calls it: the remote's last part, or the folder's name (PLAN.md §3.6 "Adding repos"). */
  name: z.string().min(1).max(200),
  /** The parent folder it was found in, or null when the user added the repo itself. */
  root: z.string().nullable(),
  addedAt: z.number().int(),
  /** When the last check found the folder gone (S10), or null. */
  missingSince: z.number().int().nullable(),
  /**
   * A repo the user removed ([Remove repo]): a parent folder never adds it again; adding it by hand does (PLAN.md §3.6
   * "Adding repos").
   */
  hidden: z.boolean(),
});
export type RepoRecord = z.infer<typeof RepoRecordSchema>;

/**
 * A skill's own choice (PLAN.md §3.6 "How placement is calculated"): `default` lets the tag rules decide; `global` is
 * "Everywhere" (global by choice); `off` links it nowhere.
 */
export const SkillModeSchema = z.enum(['default', 'global', 'off']);
export type SkillMode = z.infer<typeof SkillModeSchema>;

/**
 * An entry the app keeps in a code repo's `.git/info/exclude` (PLAN.md §3.6), so its links never show in `git status`.
 * The registry's key is the exclude file and the line together.
 */
export const EXCLUDE_ENTRY_KIND = 'exclude-entry';

export const ExcludeEntryRowSchema = z.object({
  /** The exclude file, absolute: one per repo, shared by its worktrees. */
  file: z.string().min(1),
  /** The line, e.g. `.claude/skills/acme-db-migrations`. */
  line: z.string().min(1),
  repo: RepoIdSchema,
  /** The line was in the file before the app added it: removing our entry then leaves it. */
  preexisting: z.boolean(),
  createdAt: z.number().int(),
});
export type ExcludeEntryRow = z.infer<typeof ExcludeEntryRowSchema>;
