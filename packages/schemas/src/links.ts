// The registry's rows for what the app creates outside the library (PLAN.md §3.5). Every kind of artifact is a row in
// the one registry table, keyed by its exact path: skill links now; owned files, blocks, config entries and copies in
// later steps, each as its own `kind`. The row's data is versioned with the instance database's migrations.
import { z } from 'zod';

export const SKILL_LINK_KIND = 'skill-link';

/**
 * A skill link's state (PLAN.md §3.5, §3.8):
 * - `linked`: our link is there and resolves
 * - `skipped`: the path holds something that isn't ours (S2)
 * - `suppressed`: the user said "Don't install it…" (S2, S3)
 * - `missing`: our link is gone (S3)
 * - `diverged`: a real folder replaced our link and matches no company version (S4)
 * - `taken-over`: another tool's link replaced ours (S5)
 * - `deleted`: the library's files were deleted through the link (S8)
 * - `detached-by-user`: the user left a changed copy or another tool's link alone (S4, S5)
 * - `duplicate`: a link to the skill that the app didn't make, where the skill is linked the other way too: global and
 *   in a repo (S11, Step 6)
 * - `copy-changed`: a copy-mode copy was edited where it is (Step 16): offered as "bring this change into the library"
 */
export const SkillLinkStatusSchema = z.enum([
  'linked',
  'skipped',
  'suppressed',
  'missing',
  'diverged',
  'taken-over',
  'deleted',
  'detached-by-user',
  'duplicate',
  'copy-changed',
]);
export type SkillLinkStatus = z.infer<typeof SkillLinkStatusSchema>;

/** The statuses that are red warnings in "Needs attention" (PLAN.md §3.8). */
export const WARNING_STATUSES: readonly SkillLinkStatus[] = [
  'skipped',
  'missing',
  'diverged',
  'taken-over',
  'deleted',
  'duplicate',
  'copy-changed',
];

/**
 * What took a skipped path (S2); `committed` is a skill the code repo commits there (S2, Step 6); `no-access` is a path the
 * app may not write to (a read-only or full folder): it is tried again at every check. For `copy-changed`,
 * `library-changed` says the library changed too since the copy was made (Step 16).
 */
export const SkipReasonSchema = z.enum(['folder', 'file', 'link', 'committed', 'library-changed', 'no-access']);
export type SkipReason = z.infer<typeof SkipReasonSchema>;

export const SkillLinkRowSchema = z.object({
  /** The library item, as a path inside the library: the target is always the library folder plus this (§3.5). */
  item: z.string().min(1),
  /** The skill's git name: its folder under skills/. */
  skill: z.string().min(1),
  /** The link folder the link is in, e.g. `~/.claude/skills`, absolute. */
  folder: z.string().min(1),
  /**
   * For a link in a code repo (PLAN.md §3.6): the repo's id; null (or, in rows from before Step 6's migration, left
   * out) for a global link.
   */
  repo: z.string().nullable().default(null),
  /** For a link in a code repo: the checkout it's in, the main one or a worktree. */
  checkout: z.string().nullable().default(null),
  /**
   * How the link is made (IMPLEMENTATION.md §2.14 link strategies): `link` is a symlink or a junction; `copy` is a copy of
   * the skill folder with the marker file, for the folders links can't serve (copy mode, PLAN.md §3.4, Step 16).
   */
  method: z.enum(['link', 'copy']),
  /** Where the link's name comes from: the git prefix now; the local prefix from Step 8. */
  nameSource: z.enum(['git-prefix', 'local-prefix']),
  status: SkillLinkStatusSchema,
  /** For `skipped`: what took the path. */
  reason: SkipReasonSchema.nullable(),
  /** For `taken-over`: where the other link points. */
  takenBy: z.string().nullable(),
  /** When the status began (the "name taken (2026-10-09)" in §3.5). */
  since: z.number().int(),
  createdAt: z.number().int(),
  lastVerifiedAt: z.number().int(),
  /**
   * Copy mode (PLAN.md §3.5 `content_fingerprint`): the content the app last wrote into the copy, read under the git
   * name, with the marker file and the library's ignored files left out. Null for a link, and in rows from before
   * Step 16.
   */
  contentFingerprint: z.string().nullable().default(null),
});
export type SkillLinkRow = z.infer<typeof SkillLinkRowSchema>;

/**
 * The marker file in each copy-mode copy (PLAN.md §3.4, `brand.copyModeMarkerFile`): whose copy it is, and the content the
 * app wrote. A copy whose marker names another instance or item isn't the app's, and the marker keeps a copy
 * recognisable when the database is lost.
 */
export const CopyMarkerSchema = z.object({
  instance: z.string().min(1).max(200),
  item: z.string().min(1).max(4096),
  contentFingerprint: z.string().min(1).max(200),
});
export type CopyMarker = z.infer<typeof CopyMarkerSchema>;

/**
 * A link folder the app made in a code repo's checkout, e.g. `<checkout>/.claude/skills`, and each missing folder above
 * it, e.g. `<checkout>/.claude` (PLAN.md §3.6 "Worktrees"). The app removes it again when no link of the app is in it
 * and nothing else is either: an empty `.claude/skills` would keep Claude Code's fallback to the main checkout's skills
 * switched off. The registry's key is the folder's path.
 */
export const LINK_FOLDER_KIND = 'link-folder';

export const LinkFolderRowSchema = z.object({
  /** The folder, absolute. */
  folder: z.string().min(1),
  /** The code repo's id, and the checkout the folder is in: the main one or a worktree. */
  repo: z.string().min(1),
  checkout: z.string().min(1),
  createdAt: z.number().int(),
});
export type LinkFolderRow = z.infer<typeof LinkFolderRowSchema>;

/** Why something went to the trash, and so how long it's kept (PLAN.md §3.8 "Retention"). */
export const TrashReasonSchema = z.enum([
  // A user's folder or file the user chose to overwrite (S2).
  'overwritten',
  // A real folder equal to a company version, replaced by the link (S4 DETACHED, STALE).
  'replaced-copy',
  // A changed copy the user replaced with the company's version, or brought into the library (S4).
  'diverged-copy',
  // Another tool's link (S5 [Take it back]).
  'other-link',
  // Relocation leftovers (Step 9): kept 7 days.
  'relocation',
  // A projected copy that goes with changes of its own, or the side the user didn't keep when both changed (Step 8).
  'projected-copy',
  // The original of an imported skill, replaced by the company skill ([Replace], Step 13).
  'imported-original',
  // A copy-mode copy the app removed: no longer wanted, or replaced by a link (Step 16). An edited one is a diverged copy.
  'copy',
]);
export type TrashReason = z.infer<typeof TrashReasonSchema>;

export const TRASH_RETENTION_DAYS: Readonly<Record<TrashReason, number>> = {
  overwritten: 30,
  'replaced-copy': 30,
  'diverged-copy': 30,
  'other-link': 30,
  relocation: 7,
  'projected-copy': 30,
  'imported-original': 30,
  copy: 7,
};

export const TrashEntrySchema = z.object({
  id: z.string().regex(/^trash_[0-9a-z]{4,32}$/),
  /** Where it was, absolute. */
  originalPath: z.string().min(1),
  /** What it was: a folder, a file, or a link (another tool's). */
  kind: z.enum(['dir', 'file', 'link']),
  reason: TrashReasonSchema,
  /** The skill it concerned, for the activity log. */
  skill: z.string().nullable(),
  trashedAt: z.number().int(),
  expiresAt: z.number().int(),
  /** `moving` until the move into the trash finished; a crash in between is cleaned up at the next start. */
  state: z.enum(['moving', 'kept', 'restored']),
});
export type TrashEntry = z.infer<typeof TrashEntrySchema>;
