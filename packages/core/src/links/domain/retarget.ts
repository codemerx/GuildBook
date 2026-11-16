// Relocation's "rewrite each link in place" (PLAN.md §3.9 step 5) as a plan of retarget actions (IMPLEMENTATION.md
// §2.6): every registered link of the app that points at the library's old place gets the same item at the new place.
// The link's path and name never change, so no second link exists at any time. A link that isn't ours any more, or
// points somewhere else, is skipped and reported (§3.8). Links to projected copies point into the data folder: they
// need nothing (§3.3).
import type { SkillLinkRow } from '@app/schemas';
import type { PathFlavour } from '../../shared/paths.ts';
import { targetOf } from './skill-links.ts';

export interface RetargetInputs {
  /** The library's old and new folders. */
  readonly from: string;
  readonly to: string;
  /** The registry's skill-link rows, by path. */
  readonly rows: ReadonlyArray<readonly [string, SkillLinkRow]>;
}

export interface RetargetDesired {
  readonly dest: string;
  readonly skill: string;
  readonly folder: string;
  readonly repo: string | null;
  readonly checkout: string | null;
  readonly from: string;
  readonly to: string;
}

export interface RetargetObserved {
  readonly dest: string;
  /** The link's target as stored, or null when the path isn't a link (or is gone). */
  readonly target: string | null;
}

export interface RetargetAction {
  readonly op: 'retarget';
  readonly dest: string;
  readonly skill: string;
  readonly folder: string;
  readonly repo: string | null;
  readonly checkout: string | null;
  readonly from: string;
  readonly to: string;
}

/** The rows whose link the app made and keeps at its path: the ones that point at the library. */
const RETARGETED: readonly SkillLinkRow['status'][] = ['linked', 'deleted'];

/** Pure: each of the app's links to the library, with its target at the old and at the new place. */
export function desiredRetargets(inputs: RetargetInputs, paths: PathFlavour): RetargetDesired[] {
  const out: RetargetDesired[] = [];
  for (const [dest, row] of inputs.rows) {
    if (!RETARGETED.includes(row.status) || row.nameSource === 'local-prefix') continue;
    out.push({
      dest,
      skill: row.skill,
      folder: row.folder,
      repo: row.repo ?? null,
      checkout: row.checkout ?? null,
      from: targetOf(inputs.from, row.item, paths),
      to: targetOf(inputs.to, row.item, paths),
    });
  }
  return out.sort((a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0));
}

/**
 * Pure: a retarget for each link that still points at the old place. One that points at the new place is done (a
 * step repeated after a crash); anything else is skipped, as a conflict that names the path.
 */
export function planRetargets(
  desired: readonly RetargetDesired[],
  observed: readonly RetargetObserved[],
  paths: PathFlavour,
): { actions: RetargetAction[]; conflicts: Array<{ key: string; reason: 'not-ours' }> } {
  const byDest = new Map(observed.map((o) => [o.dest, o.target]));
  const actions: RetargetAction[] = [];
  const conflicts: Array<{ key: string; reason: 'not-ours' }> = [];
  for (const d of desired) {
    const target = byDest.get(d.dest) ?? null;
    if (target !== null && paths.same(paths.normalize(target), d.to)) continue;
    if (target !== null && paths.same(paths.normalize(target), d.from)) actions.push({ op: 'retarget', ...d });
    else conflicts.push({ key: d.dest, reason: 'not-ours' });
  }
  return { actions, conflicts };
}
