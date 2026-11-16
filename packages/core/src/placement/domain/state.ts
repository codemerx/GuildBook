// The placement choices as one value, and the edits the user makes to them (PLAN.md §3.6). An edit is plain data: the
// same edit is applied to a copy of the state for a preview, and written to instance.db when the user confirms, so the
// confirmation shows exactly what's applied (IMPLEMENTATION.md §2.5).
import type { RepoRecord, SkillMode } from '@app/schemas';
import type { RepoSkill, RepoTag } from './calculator.ts';

export interface PlacementState {
  readonly repos: readonly RepoRecord[];
  readonly rules: readonly RepoTag[];
  readonly added: readonly RepoSkill[];
  readonly excluded: readonly RepoSkill[];
  readonly modes: ReadonlyArray<{ readonly skill: string; readonly mode: SkillMode }>;
}

export type PlacementEdit =
  /** Tick or untick a tag on a repo: a lasting rule (§3.6 "Ticking a tag on a repo is a lasting rule"). */
  | { readonly op: 'rule'; readonly repo: string; readonly tag: string; readonly on: boolean }
  /** Add a skill to a repo individually; adding it there also ends its exclusion there. */
  | { readonly op: 'add'; readonly repo: string; readonly skill: string; readonly on: boolean }
  /** Exclude a skill in a repo; excluding it there also ends its individual addition there. */
  | { readonly op: 'exclude'; readonly repo: string; readonly skill: string; readonly on: boolean }
  /** Off, Everywhere (global by choice), or back to the rules. */
  | { readonly op: 'mode'; readonly skill: string; readonly mode: SkillMode }
  /**
   * [Reset to tag rules] (§3.17 "Setting up repos later"): skills set to Everywhere go back to the rules; Off stays.
   * With `dropChoices`, the exclusions and individual additions go too.
   */
  | { readonly op: 'reset'; readonly dropChoices: boolean }
  /** "The tag no longer exists" (§3.6 Day 12): [Use another tag] moves the rule to the other tag. */
  | { readonly op: 'retag'; readonly repo: string; readonly from: string; readonly to: string }
  /** S10 [Remove repo]: the repo goes with its rules, additions and exclusions. */
  | { readonly op: 'remove-repo'; readonly repo: string }
  /**
   * [Remove] on a parent folder (§3.6 "Adding repos"): the repos found in it go with their rules, additions and
   * exclusions, the removed ones too, so adding the folder again finds them all again. A repo in `keep` stays, as if the
   * user had added it.
   */
  | { readonly op: 'remove-root'; readonly root: string; readonly keep: readonly string[] }
  /** S10 [Locate]: the repo's folder is somewhere else now. */
  | { readonly op: 'locate'; readonly repo: string; readonly path: string };

const same = (a: { repo: string; skill: string }, b: { repo: string; skill: string }) =>
  a.repo === b.repo && a.skill === b.skill;

function toggle<T>(list: readonly T[], item: T, on: boolean, equal: (a: T, b: T) => boolean): T[] {
  const rest = list.filter((entry) => !equal(entry, item));
  return on ? [...rest, item] : rest;
}

/** Pure: the state after one edit. */
export function applyEdit(state: PlacementState, edit: PlacementEdit): PlacementState {
  switch (edit.op) {
    case 'rule':
      return {
        ...state,
        rules: toggle(
          state.rules,
          { repo: edit.repo, tag: edit.tag },
          edit.on,
          (a, b) => a.repo === b.repo && a.tag === b.tag,
        ),
      };
    case 'add': {
      const entry = { repo: edit.repo, skill: edit.skill };
      return {
        ...state,
        added: toggle(state.added, entry, edit.on, same),
        excluded: edit.on ? state.excluded.filter((e) => !same(e, entry)) : state.excluded,
      };
    }
    case 'exclude': {
      const entry = { repo: edit.repo, skill: edit.skill };
      return {
        ...state,
        excluded: toggle(state.excluded, entry, edit.on, same),
        added: edit.on ? state.added.filter((a) => !same(a, entry)) : state.added,
      };
    }
    case 'mode':
      return {
        ...state,
        modes: [
          ...state.modes.filter((m) => m.skill !== edit.skill),
          ...(edit.mode === 'default' ? [] : [{ skill: edit.skill, mode: edit.mode }]),
        ],
      };
    case 'reset':
      return {
        ...state,
        modes: state.modes.filter((m) => m.mode !== 'global'),
        added: edit.dropChoices ? [] : state.added,
        excluded: edit.dropChoices ? [] : state.excluded,
      };
    case 'retag': {
      const rules = state.rules.filter((r) => !(r.repo === edit.repo && r.tag === edit.from));
      const has = rules.some((r) => r.repo === edit.repo && r.tag === edit.to);
      return { ...state, rules: has ? rules : [...rules, { repo: edit.repo, tag: edit.to }] };
    }
    case 'remove-repo':
      // The repo stays as a hidden record, as instance.db keeps it: a parent folder never adds it again (§3.6).
      return {
        repos: state.repos.map((r) => (r.id === edit.repo ? { ...r, hidden: true, missingSince: null } : r)),
        rules: state.rules.filter((r) => r.repo !== edit.repo),
        added: state.added.filter((a) => a.repo !== edit.repo),
        excluded: state.excluded.filter((e) => e.repo !== edit.repo),
        modes: state.modes,
      };
    case 'remove-root': {
      const found = (r: { root: string | null }) => r.root === edit.root;
      const gone = new Set(state.repos.filter((r) => found(r) && !edit.keep.includes(r.id)).map((r) => r.id));
      return {
        repos: state.repos.filter((r) => !gone.has(r.id)).map((r) => (found(r) ? { ...r, root: null } : r)),
        rules: state.rules.filter((r) => !gone.has(r.repo)),
        added: state.added.filter((a) => !gone.has(a.repo)),
        excluded: state.excluded.filter((e) => !gone.has(e.repo)),
        modes: state.modes,
      };
    }
    case 'locate':
      return {
        ...state,
        repos: state.repos.map((r) => (r.id === edit.repo ? { ...r, path: edit.path, missingSince: null } : r)),
      };
  }
}

export function applyEdits(state: PlacementState, edits: readonly PlacementEdit[]): PlacementState {
  return edits.reduce(applyEdit, state);
}

/**
 * Pure: the choices after skills were renamed in git (S6), as a pull would leave them: each choice moves to the new
 * name. The pull preview plans with this before the rename happens (IMPLEMENTATION.md §2.5).
 */
export function renameSkills(
  state: PlacementState,
  renames: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): PlacementState {
  if (renames.length === 0) return state;
  const to = new Map(renames.map((r) => [r.from, r.to]));
  const name = (skill: string) => to.get(skill) ?? skill;
  return {
    ...state,
    added: state.added.map((a) => ({ ...a, skill: name(a.skill) })),
    excluded: state.excluded.map((e) => ({ ...e, skill: name(e.skill) })),
    modes: state.modes.map((m) => ({ ...m, skill: name(m.skill) })),
  };
}
