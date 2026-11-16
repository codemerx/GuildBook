// The projected-copy reconciler's pure parts (PLAN.md §3.3, IMPLEMENTATION.md §2.5). Each copy's row remembers the
// fingerprint both sides had at the last sync, the copy read with its git name restored. Comparing each side with it
// says what happened:
// - the sides are equal: nothing to do (a crash after a step but before its record only needs the record)
// - only the library changed (a pull, a branch switch, the editor): the copy is refreshed
// - only the copy changed (an edit made through a link): it's written back with the git name restored
// - both changed (while the app wasn't running, or while git was busy): the user chooses which to keep
// A copy nobody wants any more goes; one with changes nobody wrote back goes to the trash.
import type { ProjectedCopyRow } from '@app/schemas';
import type { Conflict, PlanBody } from '../../engine/index.ts';

export interface ProjectionDesired {
  /** The copy's folder: `<data folder>/projection/<name>`. */
  readonly key: string;
  /** The skill's git name, its folder under skills/. */
  readonly skill: string;
  /** Its name under the local prefix: the copy's folder name and `name:` line. */
  readonly name: string;
  /** No row yet and nothing in the library: there's nothing to copy. */
  readonly libraryEmpty: boolean;
}

export interface ProjectionObserved {
  readonly key: string;
  readonly row: ProjectedCopyRow | null;
  /** The library folder's fingerprint (ignored files left out); null when it isn't looked at. */
  readonly library: string | null;
  /** The copy's fingerprint with its git name restored (ignored files left out); null when it isn't looked at. */
  readonly copy: string | null;
  /**
   * Both sides' fingerprints under the git name the row was synced with, when the skill's git name changed since (a
   * rename, or a prefix change, Step 14): which side changed is asked of these, so the new name alone changes neither.
   */
  readonly before?: { readonly library: string; readonly copy: string };
  /** Whether the copy's folder is there. */
  readonly copyExists: boolean;
}

/** The side the user keeps when both changed. */
export type CopyDecision = 'library' | 'copy';

interface Sides {
  readonly library: string;
  readonly copy: string;
}

export type ProjectionAction =
  | { readonly op: 'create'; readonly key: string; readonly skill: string; readonly name: string }
  | {
      readonly op: 'refresh';
      readonly key: string;
      readonly skill: string;
      readonly name: string;
      readonly expect: Sides;
    }
  | {
      readonly op: 'write-back';
      readonly key: string;
      readonly skill: string;
      readonly name: string;
      readonly expect: Sides;
    }
  /** The sides are equal: only the row changes. */
  | {
      readonly op: 'adopt';
      readonly key: string;
      readonly skill: string;
      readonly name: string;
      readonly synced: string;
    }
  | {
      readonly op: 'mark';
      readonly key: string;
      readonly skill: string;
      readonly name: string;
      readonly row: ProjectedCopyRow;
    }
  | {
      readonly op: 'remove';
      readonly key: string;
      readonly skill: string;
      /** The copy has changes that never reached the library: it goes to the trash. */
      readonly trash: boolean;
    }
  | { readonly op: 'forget'; readonly key: string; readonly skill: string };

export interface ProjectionScope {
  /** Copies nobody wants are removed; false while links may still point at them (PLAN.md §3.3 "Changing"). */
  readonly removals: boolean;
  readonly decisions?: Readonly<Record<string, CopyDecision>>;
  /** Only these copies: a decision's plan. */
  readonly only?: readonly string[];
}

export const BOTH_CHANGED = 'both-changed';

/** Pure: the actions that bring the copies in line with the library, and the copies that wait for the user. */
export function planProjection(
  scope: ProjectionScope,
  desired: readonly ProjectionDesired[],
  observed: readonly ProjectionObserved[],
  now: number,
): PlanBody<ProjectionAction> {
  const byKey = new Map(observed.map((o) => [o.key, o]));
  const wanted = new Set(desired.map((d) => d.key));
  const actions: ProjectionAction[] = [];
  const conflicts: Conflict[] = [];
  const inScope = (key: string) => !scope.only || scope.only.includes(key);
  for (const d of desired) {
    if (!inScope(d.key)) continue;
    const o = byKey.get(d.key);
    const row = o?.row ?? null;
    const base = { key: d.key, skill: d.skill, name: d.name };
    if (!o || o.library === null || o.copy === null) continue;
    const sides: Sides = { library: o.library, copy: o.copy };
    if (row === null) {
      if (d.libraryEmpty) continue;
      // A copy made before a crash, before its row: equal sides only need the row; anything else is made again.
      if (o.copyExists && sides.library === sides.copy) actions.push({ op: 'adopt', ...base, synced: sides.library });
      else actions.push({ op: 'create', ...base });
      continue;
    }
    if (sides.library === sides.copy) {
      if (row.synced !== sides.library || row.status !== 'synced' || row.name !== d.name || row.skill !== d.skill) {
        actions.push({ op: 'adopt', ...base, synced: sides.library });
      }
      continue;
    }
    const libraryChanged = (o.before?.library ?? sides.library) !== row.synced;
    const copyChanged = (o.before?.copy ?? sides.copy) !== row.synced;
    const decision = scope.decisions?.[d.key];
    if (libraryChanged && copyChanged && decision === undefined) {
      conflicts.push({ key: d.key, reason: BOTH_CHANGED });
      if (row.status !== 'both-changed') {
        actions.push({ op: 'mark', ...base, row: { ...row, status: 'both-changed', since: now } });
      }
      continue;
    }
    // Only the library changed, or the user keeps it: the copy follows. Only the copy changed, or the user keeps it:
    // the library follows.
    const keepCopy = decision === 'copy' || (decision === undefined && copyChanged);
    actions.push({ op: keepCopy ? 'write-back' : 'refresh', ...base, expect: sides });
  }
  for (const o of observed) {
    if (wanted.has(o.key) || !o.row || !scope.removals || !inScope(o.key)) continue;
    if (!o.copyExists) {
      actions.push({ op: 'forget', key: o.key, skill: o.row.skill });
      continue;
    }
    // Changes that never reached the library aren't lost: such a copy goes to the trash.
    const changed = o.copy !== null && o.copy !== o.row.synced;
    actions.push({ op: 'remove', key: o.key, skill: o.row.skill, trash: changed });
  }
  // New copies before anything else, removals last: links may still point at the old ones while new ones are made.
  const order = (action: ProjectionAction) => (action.op === 'remove' || action.op === 'forget' ? 1 : 0);
  actions.sort((a, b) => order(a) - order(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { actions, conflicts };
}

/** The row an action leaves, or null when it goes. */
export function projectionRowAfter(
  action: ProjectionAction,
  before: ProjectedCopyRow | null,
  synced: string | null,
  now: number,
): ProjectedCopyRow | null {
  switch (action.op) {
    case 'remove':
    case 'forget':
      return null;
    case 'mark':
      return action.row;
    case 'adopt':
      return {
        skill: action.skill,
        name: action.name,
        synced: action.synced,
        status: 'synced',
        since: before?.since ?? now,
      };
    case 'create':
    case 'refresh':
    case 'write-back':
      return {
        skill: action.skill,
        name: action.name,
        synced: synced ?? before?.synced ?? '',
        status: 'synced',
        since: before?.status === 'synced' ? before.since : now,
      };
  }
}
