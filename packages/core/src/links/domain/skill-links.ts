// The skill-link reconciler's pure parts (IMPLEMENTATION.md §2.5, PLAN.md §3.5, §3.8): which links should exist, what
// each exact path holds, and the plan between them. Every health scenario is a case of the same plan:
// - S1: a free path gets the link
// - S2: a path that holds something that isn't ours is skipped with a red warning
// - S3: our link is gone: a warning, never re-created on its own
// - S4: a real folder at our path is replaced silently when it equals a company version, else a warning
// - S5: another program's link at our path is left alone, with a warning
// - S6: a link whose skill left the library is removed (links only)
// - S8: our link resolves no more, but the skill is still in git: "Deleted on this device"
// - S2 in a code repo: a skill the repo commits at the path is never overwritten or moved (Step 6)
// - S11: a link to the skill that the app didn't make, global while the skill is in repos or the other way round
// Copy mode (PLAN.md §3.4, Step 16) is the second method: in a folder that links can't serve, the skill goes as a copy
// with a marker file. A copy that only the library moved past is refreshed; one edited where it is becomes a red
// warning that offers "bring this change into the library". A folder that changes method swaps link and copy.
// Placement (PLAN.md §3.6, Step 6) decides which folders each skill goes to: the global link folders, or the link
// folders of the repos it's placed in, in every checkout of each.
// The user's answers to the warnings are decisions, one per path; a plan with a decision does what it says.
import {
  type SkillLinkRow,
  type SkillLinkStatus,
  type SkipReason,
  type TrashReason,
  WARNING_STATUSES,
} from '@app/schemas';
import type { PathFlavour } from '../../shared/paths.ts';

export interface LinkableSkill {
  /** The skill's folder under skills/, its git name. */
  readonly folder: string;
  /** Its files were deleted in this library folder, but git still has it (S8). */
  readonly deletedLocally: boolean;
  /** Linked in the global link folders (`inputs.folders`); true unless placement says otherwise (PLAN.md §3.6). */
  readonly global?: boolean;
  /** The repos it's placed in, by id (§3.6): missing ones too, which have no folders now (S10). */
  readonly repos?: readonly string[];
  /** The repo link folders it's placed in, in every checkout of each repo (§3.6). */
  readonly repoFolders?: readonly ChosenFolder[];
  /**
   * Under a local prefix (PLAN.md §3.3, Step 8): the link's name and its projected copy, which the link points at.
   * Without them the link is named after the folder and points at the library.
   */
  readonly name?: string;
  readonly target?: string;
}

export interface ChosenFolder {
  /** Absolute and normalized. */
  readonly path: string;
  /** For a repo link folder: the repo's id and the checkout the folder is in. */
  readonly repo?: string | null;
  readonly checkout?: string | null;
  /** Copy mode (Step 16): the skills go into this folder as copies, not links. */
  readonly copy?: boolean;
}

/** A link to a skill at a path the app didn't make and doesn't want, found in a link folder (S11). */
export interface StrayLink {
  readonly dest: string;
  readonly skill: string;
  readonly folder: string;
  readonly repo: string | null;
  readonly checkout: string | null;
}

/** The user's answer to a warning (PLAN.md §3.8). */
export type LinkDecision =
  /** S2, S5: the thing at the path goes to the trash, then the link is made. */
  | { readonly kind: 'overwrite' }
  /** S2 [Move my folder], S4 "Keep my version": rename it beside, optionally with its `name:` line. */
  | { readonly kind: 'move-aside'; readonly name: string; readonly rewriteName: boolean }
  /** S2, S3 [Don't install it…]. */
  | { readonly kind: 'suppress' }
  /** S3 [Reinstall]. */
  | { readonly kind: 'reinstall' }
  /** S5 [Take it back]. */
  | { readonly kind: 'take-back' }
  /** S4 "Leave it alone on this device", S5 [Leave it]. */
  | { readonly kind: 'leave' }
  /** S4 "Replace it with Acme's version". */
  | { readonly kind: 'replace' }
  /** S4 "Bring my changes into the library". */
  | { readonly kind: 'bring-in' }
  /** Turn a suppressed or left-alone path back on, from the skill's page. */
  | { readonly kind: 'reenable' }
  /** S11: the extra link goes to the trash; placement keeps the other side. */
  | { readonly kind: 'drop-duplicate' };

export interface SkillLinkInputs {
  readonly libraryRoot: string;
  readonly skills: readonly LinkableSkill[];
  readonly folders: readonly ChosenFolder[];
  readonly decisions?: Readonly<Record<string, LinkDecision>>;
  /** Links found in the link folders that point to a skill but aren't wanted there (S11). */
  readonly strays?: readonly StrayLink[];
}

/** Which paths a plan covers. */
export interface SkillLinkScope {
  /** Only these paths: a decision's plan, so it shows and does nothing else. */
  readonly only?: readonly string[];
  /** Removing the instance (PLAN.md §3.8 S12): the choices go too. */
  readonly forgetChoices?: boolean;
}

export interface SkillLinkDesired {
  readonly dest: string;
  readonly item: string;
  readonly skill: string;
  readonly folder: string;
  readonly repo?: string | null;
  readonly checkout?: string | null;
  readonly target: string;
  readonly deletedLocally: boolean;
  readonly decision: LinkDecision | null;
  /** Where the link's name comes from (PLAN.md §3.3): the git prefix, or the local prefix for a projected copy. */
  readonly nameSource?: NameSource;
  /** Copy mode (Step 16): a copy of the library's folder instead of a link. Left out for a link. */
  readonly method?: 'copy';
}

export type NameSource = SkillLinkRow['nameSource'];

/** What one exact path holds, from lstat and readlink (PLAN.md §3.8 `inspect`). */
export type PathState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'link'; readonly target: string; readonly ours: boolean; readonly resolves: boolean }
  /**
   * `match`: its fingerprint equals the library's current version, an older company version, or none. `committed`: a
   * code repo commits it (S2, Step 6).
   */
  | { readonly kind: 'dir'; readonly match: 'current' | 'older' | 'none'; readonly committed?: boolean }
  | { readonly kind: 'file'; readonly committed?: boolean }
  /**
   * A folder with a copy-mode marker file (Step 16). `ours`: the marker names this instance and the path's item.
   * The fingerprints leave out the marker and the library's ignored files, and read SKILL.md under the git name:
   * `copy` is the folder's now, `library` the library folder's (null when it's gone), `marker` the one the marker
   * recorded when the app wrote the copy.
   */
  | {
      readonly kind: 'copy';
      readonly ours: boolean;
      readonly copy: string;
      readonly library: string | null;
      readonly marker: string;
    };

export interface SkillLinkObserved {
  readonly dest: string;
  readonly state: PathState;
  readonly row: SkillLinkRow | null;
}

interface Placed {
  readonly dest: string;
  readonly item: string;
  readonly skill: string;
  readonly folder: string;
  /** For a link in a code repo: its repo and checkout. Global links leave them out or null. */
  readonly repo?: string | null;
  readonly checkout?: string | null;
  /** Left out for a link named after the git prefix. */
  readonly nameSource?: NameSource;
  /** Copy mode: the step makes or keeps a copy. Left out for a link. */
  readonly method?: 'copy';
}

interface Linked extends Placed {
  readonly target: string;
}

/** Both sides of a copy as the plan saw them: a step checks the side it overwrites first. */
export interface CopySides {
  readonly copy: string;
  readonly library: string | null;
}

export type SkillLinkAction =
  | ({ readonly op: 'create' } & Linked)
  /** Copy mode: the content the copy and the library agree on, recorded (and in the marker). */
  | ({ readonly op: 'adopt' } & Placed & { readonly contentFingerprint?: string })
  /** Copy mode: only the library changed since the copy was written, so the copy follows it. */
  | ({ readonly op: 'refresh' } & Linked & { readonly expect: CopySides })
  | ({ readonly op: 'mark' } & Placed & {
        readonly status: SkillLinkStatus;
        readonly reason: SkipReason | null;
        readonly takenBy: string | null;
      })
  | ({ readonly op: 'replace' } & Linked & { readonly trash: TrashReason; readonly why: ReplaceWhy })
  | ({ readonly op: 'move-aside' } & Linked & { readonly to: string; readonly rewriteName: string | null })
  /** S4, or a copy's change (Step 16, `expect` set): the folder's content goes into the library. */
  | ({ readonly op: 'bring-in' } & Linked & { readonly expect?: CopySides })
  | {
      readonly op: 'remove';
      readonly dest: string;
      readonly target: string;
      readonly skill: string;
      /** Where the link was: for the activity log's tools and repo. */
      readonly folder?: string;
      readonly repo?: string | null;
      readonly checkout?: string | null;
      /**
       * Copy mode: the copy goes to the trash. `changed`: it has edits that never reached the library, so it's kept as
       * a diverged copy; `expect` is the content the plan saw.
       */
      readonly copy?: { readonly changed: boolean; readonly expect: string };
    }
  /** S11 [Keep … only]: a link the app didn't make goes to the trash. */
  | {
      readonly op: 'drop';
      readonly dest: string;
      readonly target: string;
      readonly skill: string;
      readonly folder?: string;
      readonly repo?: string | null;
      readonly checkout?: string | null;
    }
  | { readonly op: 'forget'; readonly dest: string; readonly skill: string };

/**
 * Why a replace happens: shown in the activity log. `mode`: the folder switched between links and copies (Step 16).
 */
export type ReplaceWhy = 'detached' | 'stale' | 'overwrite' | 'take-back' | 'replace' | 'mode';

export interface SkillLinkConflict {
  readonly key: string;
  readonly reason: SkillLinkStatus;
}

export const SKILLS_FOLDER = 'skills';

/** The library item of a skill folder: a path inside the library, with forward slashes (PLAN.md §3.5). */
export function itemOf(skill: string): string {
  return `${SKILLS_FOLDER}/${skill}`;
}

export function targetOf(libraryRoot: string, item: string, paths: PathFlavour): string {
  return paths.normalize(paths.join(libraryRoot, ...item.split('/')));
}

export function isWarning(status: SkillLinkStatus): boolean {
  return WARNING_STATUSES.includes(status);
}

/** Pure: one link per linkable skill in each folder its placement chooses: the global ones, or its repos'. */
export function desiredSkillLinks(
  inputs: SkillLinkInputs,
  scope: SkillLinkScope,
  paths: PathFlavour,
): SkillLinkDesired[] {
  const desired: SkillLinkDesired[] = [];
  for (const skill of inputs.skills) {
    const folders = [...(skill.global === false ? [] : inputs.folders), ...(skill.repoFolders ?? [])];
    for (const folder of folders) {
      const dest = paths.normalize(paths.join(folder.path, skill.name ?? skill.folder));
      const item = itemOf(skill.folder);
      desired.push({
        dest,
        item,
        skill: skill.folder,
        folder: folder.path,
        repo: folder.repo ?? null,
        checkout: folder.checkout ?? null,
        target: skill.target === undefined ? targetOf(inputs.libraryRoot, item, paths) : paths.normalize(skill.target),
        deletedLocally: skill.deletedLocally,
        decision: inputs.decisions?.[dest] ?? null,
        ...(skill.target === undefined ? {} : { nameSource: 'local-prefix' as const }),
        ...(folder.copy ? { method: 'copy' as const } : {}),
      });
    }
  }
  const only = scope.only;
  return desired
    .filter((d) => !only || only.includes(d.dest))
    .sort((a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0));
}

function same(row: SkillLinkRow | null, status: SkillLinkStatus, extra: Partial<SkillLinkRow> = {}): boolean {
  if (!row || row.status !== status) return false;
  return Object.entries(extra).every(([key, value]) => row[key as keyof SkillLinkRow] === value);
}

/** The content a copy was written with: the row's, or the marker's when the row is gone (a lost database). */
export function copyBase(row: SkillLinkRow | null, state: Extract<PathState, { kind: 'copy' }>): string {
  return row?.contentFingerprint ?? state.marker;
}

/** The action for one wanted link, or none. */
function planOne(d: SkillLinkDesired, seen: SkillLinkObserved | undefined, paths: PathFlavour): SkillLinkAction | null {
  const copyMode = d.method === 'copy';
  const placed: Placed = {
    dest: d.dest,
    item: d.item,
    skill: d.skill,
    folder: d.folder,
    repo: d.repo ?? null,
    checkout: d.checkout ?? null,
    ...(d.nameSource === 'local-prefix' ? { nameSource: d.nameSource } : {}),
    ...(copyMode ? { method: 'copy' as const } : {}),
  };
  const linked: Linked = { ...placed, target: d.target };
  const seenState: PathState = seen?.state ?? { kind: 'missing' };
  // A copy-mode folder that isn't the app's (its marker names another instance or skill) is a folder like any other.
  const state: PathState = seenState.kind === 'copy' && !seenState.ours ? { kind: 'dir', match: 'none' } : seenState;
  const decision = d.decision;
  const stored = seen?.row ?? null;
  // A row of another skill at the path is written again: under a local prefix a prefix change keeps the link's name,
  // and the row follows the skill's new git name (Step 14). A row of the other method is written again too.
  const sameMethod = (stored?.method ?? 'link') === (copyMode ? 'copy' : 'link');
  const mark = (status: SkillLinkStatus, reason: SkipReason | null = null, takenBy: string | null = null) =>
    same(stored, status, { reason, takenBy, skill: d.skill }) && sameMethod
      ? null
      : ({ op: 'mark', ...placed, status, reason, takenBy } as const);
  const replace = (trash: TrashReason, why: ReplaceWhy) => ({ op: 'replace', ...linked, trash, why }) as const;
  const moveAside = (name: string, rewrite: boolean) =>
    ({
      op: 'move-aside',
      ...linked,
      to: paths.join(d.folder, name),
      rewriteName: rewrite ? name : null,
    }) as const;

  // A choice the user made stays, until they turn the path back on.
  if (stored && (stored.status === 'suppressed' || stored.status === 'detached-by-user')) {
    if (decision?.kind !== 'reenable') return null;
  }
  const row = decision?.kind === 'reenable' ? null : stored;
  const ours = row !== null && row.status !== 'skipped' && row.status !== 'duplicate';

  // A skill the code repo commits at the path is the repo's own: never overwritten or moved (S2). The only answer is
  // an exclusion, which is a placement change.
  if ((state.kind === 'dir' || state.kind === 'file') && state.committed) {
    if (decision?.kind === 'suppress') return mark('suppressed');
    return mark('skipped', 'committed');
  }

  switch (state.kind) {
    case 'missing':
      if (decision?.kind === 'suppress') return mark('suppressed');
      // A copy needs the library's files: a skill deleted on this device waits for [Restore] (S8).
      if (copyMode && d.deletedLocally) return mark('deleted');
      if (decision?.kind === 'reinstall') return { op: 'create', ...linked };
      // A skill deleted on this device that never had a link here gets none: there is nothing to point at.
      if (d.deletedLocally && !row) return null;
      if (
        row &&
        (row.status === 'linked' ||
          row.status === 'missing' ||
          row.status === 'deleted' ||
          row.status === 'copy-changed')
      ) {
        return mark('missing');
      }
      return { op: 'create', ...linked };

    case 'link':
      if (state.ours) {
        // The folder serves copies now: our link makes way for a copy (Step 16).
        if (copyMode) return d.deletedLocally ? mark('deleted') : replace('copy', 'mode');
        if (!state.resolves) return mark('deleted');
        return same(stored, 'linked', { skill: d.skill }) && sameMethod && decision?.kind !== 'reenable'
          ? null
          : { op: 'adopt', ...placed };
      }
      if (decision?.kind === 'take-back') return replace('other-link', 'take-back');
      if (decision?.kind === 'overwrite') return replace('other-link', 'overwrite');
      if (decision?.kind === 'leave') return mark('detached-by-user', null, state.target);
      if (decision?.kind === 'suppress') return mark('suppressed');
      return ours ? mark('taken-over', null, state.target) : mark('skipped', 'link');

    case 'copy': {
      // The app's copy (Step 16). Its edits are never lost: only an unchanged copy follows the library on its own.
      const base = copyBase(row, state);
      const copyChanged = state.copy !== base;
      const sides: CopySides = { copy: state.copy, library: state.library };
      if (state.library === null) return mark('deleted');
      if (decision?.kind === 'bring-in') return { op: 'bring-in', ...linked, expect: sides };
      if (decision?.kind === 'replace') return replace('diverged-copy', 'replace');
      if (decision?.kind === 'leave') return mark('detached-by-user');
      if (!copyMode) {
        // The folder serves links now: an unchanged copy makes way for the link; an edited one asks first.
        if (!copyChanged || state.copy === state.library) return replace('copy', 'mode');
        return mark('copy-changed', state.library !== base ? 'library-changed' : null);
      }
      if (state.copy === state.library) {
        const recorded =
          same(stored, 'linked', { skill: d.skill, contentFingerprint: state.copy }) &&
          sameMethod &&
          state.marker === state.copy;
        return recorded && decision?.kind !== 'reenable'
          ? null
          : { op: 'adopt', ...placed, contentFingerprint: state.copy };
      }
      if (!copyChanged) return { op: 'refresh', ...linked, expect: sides };
      return mark('copy-changed', state.library !== base ? 'library-changed' : null);
    }

    case 'dir':
      if (decision?.kind === 'overwrite') return replace('overwritten', 'overwrite');
      if (decision?.kind === 'replace') return replace('diverged-copy', 'replace');
      if (decision?.kind === 'bring-in') return { op: 'bring-in', ...linked };
      if (decision?.kind === 'move-aside') return moveAside(decision.name, decision.rewriteName);
      if (decision?.kind === 'suppress') return mark('suppressed');
      if (decision?.kind === 'leave') return mark('detached-by-user');
      // Nobody's work is lost: a copy of a company version is replaced without asking (S4 DETACHED, STALE).
      if (state.match === 'current') return replace('replaced-copy', 'detached');
      if (state.match === 'older') return replace('replaced-copy', 'stale');
      return ours ? mark('diverged') : mark('skipped', 'folder');

    case 'file':
      if (decision?.kind === 'overwrite') return replace('overwritten', 'overwrite');
      if (decision?.kind === 'move-aside') return moveAside(decision.name, false);
      if (decision?.kind === 'suppress') return mark('suppressed');
      return mark('skipped', 'file');
  }
}

/**
 * S11: the strays that make a skill visible twice, global and in a repo. A stray in a repo counts while the skill is
 * global; a stray in a global folder counts while the skill is in repos.
 */
function duplicates(
  desired: readonly SkillLinkDesired[],
  strays: readonly StrayLink[],
  observed: readonly SkillLinkObserved[],
): Map<string, StrayLink> {
  const global = new Set<string>();
  const inRepo = new Set<string>();
  for (const d of desired) ((d.repo ?? null) === null ? global : inRepo).add(d.skill);
  const wanted = new Set(desired.map((d) => d.dest));
  // A path with a row of the app's own (not a stray's) is the app's link: one that's no longer wanted is removed.
  const own = new Set(observed.filter((o) => o.row && o.row.status !== 'duplicate').map((o) => o.dest));
  const out = new Map<string, StrayLink>();
  for (const stray of strays) {
    if (wanted.has(stray.dest) || own.has(stray.dest)) continue;
    const other = stray.repo === null ? inRepo : global;
    if (other.has(stray.skill)) out.set(stray.dest, stray);
  }
  return out;
}

/** Pure: the actions that bring the paths to the wanted links, and the warnings left after them. */
export function planSkillLinks(
  inputs: SkillLinkScope & {
    readonly strays?: readonly StrayLink[];
    readonly decisions?: Readonly<Record<string, LinkDecision>>;
    /** Every wanted link, when `desired` is only a scope's: S11 compares the skill's other side. */
    readonly allDesired?: readonly SkillLinkDesired[];
  },
  desired: readonly SkillLinkDesired[],
  observed: readonly SkillLinkObserved[],
  paths: PathFlavour,
): { actions: SkillLinkAction[]; conflicts: SkillLinkConflict[] } {
  const byDest = new Map(observed.map((o) => [o.dest, o]));
  const wanted = new Set(desired.map((d) => d.dest));
  const doubles = duplicates(inputs.allDesired ?? desired, inputs.strays ?? [], observed);
  const actions: SkillLinkAction[] = [];
  const conflicts: SkillLinkConflict[] = [];
  for (const d of desired) {
    const seen = byDest.get(d.dest);
    const action = planOne(d, seen, paths);
    if (action) actions.push(action);
    const status = action?.op === 'mark' ? action.status : action ? 'linked' : (seen?.row?.status ?? null);
    if (status && isWarning(status)) conflicts.push({ key: d.dest, reason: status });
  }
  // S11: a stray link that makes its skill visible twice is a red warning until the user keeps one side. It's never
  // the app's link, so it's never removed without that answer.
  for (const [dest, stray] of doubles) {
    if (inputs.only && !inputs.only.includes(dest)) continue;
    const seen = byDest.get(dest);
    if (!seen || seen.state.kind !== 'link' || !seen.state.ours) continue;
    if (inputs.decisions?.[dest]?.kind === 'drop-duplicate') {
      actions.push({
        op: 'drop',
        dest,
        target: seen.state.target,
        skill: stray.skill,
        folder: stray.folder,
        repo: stray.repo,
        checkout: stray.checkout,
      });
      continue;
    }
    if (seen.row?.status !== 'duplicate') {
      actions.push({
        op: 'mark',
        dest,
        item: itemOf(stray.skill),
        skill: stray.skill,
        folder: stray.folder,
        repo: stray.repo,
        checkout: stray.checkout,
        status: 'duplicate',
        reason: null,
        takenBy: null,
      });
    }
    conflicts.push({ key: dest, reason: 'duplicate' });
  }
  // Rows nobody wants any more: our link goes (links only), the rest is forgotten. A user's choice stays, unless the
  // instance is being removed. A stray's row is forgotten too: the link isn't ours to remove.
  for (const seen of observed) {
    if (wanted.has(seen.dest) || doubles.has(seen.dest) || !seen.row) continue;
    if (inputs.only && !inputs.only.includes(seen.dest)) continue;
    const choice = seen.row.status === 'suppressed' || seen.row.status === 'detached-by-user';
    if (choice && !inputs.forgetChoices) continue;
    if (seen.state.kind === 'link' && seen.state.ours && seen.row.status !== 'duplicate') {
      actions.push({
        op: 'remove',
        dest: seen.dest,
        target: seen.state.target,
        skill: seen.row.skill,
        folder: seen.row.folder,
        repo: seen.row.repo ?? null,
        checkout: seen.row.checkout ?? null,
      });
    } else if (seen.state.kind === 'copy' && seen.state.ours) {
      // The app's copy goes to the trash: one with edits that never reached the library is kept longer (Step 16).
      actions.push({
        op: 'remove',
        dest: seen.dest,
        target: seen.dest,
        skill: seen.row.skill,
        folder: seen.row.folder,
        repo: seen.row.repo ?? null,
        checkout: seen.row.checkout ?? null,
        copy: { changed: seen.state.copy !== copyBase(seen.row, seen.state), expect: seen.state.copy },
      });
    } else actions.push({ op: 'forget', dest: seen.dest, skill: seen.row.skill });
  }
  actions.sort((a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0));
  return { actions, conflicts };
}

/**
 * The registry row an action leaves, or null when the row goes. `written` is the content a copy-mode step left in the
 * copy (Step 16); a step that writes no copy keeps the one the row had.
 */
export function rowAfter(
  action: SkillLinkAction,
  before: SkillLinkRow | null,
  now: number,
  written: string | null = null,
): SkillLinkRow | null {
  if (action.op === 'remove' || action.op === 'forget' || action.op === 'drop') return null;
  const status: SkillLinkStatus = action.op === 'mark' ? action.status : 'linked';
  const reason = action.op === 'mark' ? action.reason : null;
  const takenBy = action.op === 'mark' ? action.takenBy : null;
  const copy = action.method === 'copy';
  const fingerprint =
    written ??
    (action.op === 'adopt' ? action.contentFingerprint : undefined) ??
    (copy || action.op === 'mark' ? (before?.contentFingerprint ?? null) : null);
  return {
    item: action.item,
    skill: action.skill,
    folder: action.folder,
    repo: action.repo ?? null,
    checkout: action.checkout ?? null,
    method: copy ? 'copy' : 'link',
    nameSource: 'nameSource' in action && action.nameSource ? action.nameSource : 'git-prefix',
    status,
    reason,
    takenBy,
    since: before && before.status === status ? before.since : now,
    createdAt: before?.createdAt ?? now,
    lastVerifiedAt: now,
    contentFingerprint: fingerprint,
  };
}
