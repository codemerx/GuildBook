// The link folders the app made in code repos (PLAN.md §3.6 "Worktrees"): the pure part of their reconciler. The
// skill-link reconciler records each link folder it makes in a checkout, e.g. `.claude/skills`, and the folders above
// it that it had to make too, e.g. `.claude`. Once no link of the app is in such a folder, it goes again, the deepest
// first: an empty `.claude/skills` in a worktree would keep Claude Code's fallback to the main checkout's skills off.
// A folder with anything else in it stays, and the app forgets it: it's no longer only the app's.
import type { PathFlavour } from '../../shared/paths.ts';

export interface MadeFolderInputs {
  /** The link folders that still hold something of the app's (a link, or a warning about its path). */
  readonly kept: readonly string[];
}

export interface MadeFolderObserved {
  readonly folder: string;
  /** `kept`: it holds a kept folder, so it wasn't looked at. Otherwise what lstat found at the path. */
  readonly state: 'kept' | 'dir' | 'other' | 'missing';
}

export type MadeFolderAction =
  /** Removes the folder while it's empty, then forgets it either way. */
  | { readonly op: 'remove'; readonly folder: string }
  /** Forgets a folder that's gone, or that isn't a real folder any more. */
  | { readonly op: 'forget'; readonly folder: string };

/** Whether a made folder holds a kept one: it's that folder, or one of the folders above it. */
export function holdsKept(folder: string, kept: readonly string[], paths: PathFlavour): boolean {
  return kept.some((k) => paths.isInside(folder, k));
}

/** Pure: each made folder that holds nothing kept goes, the deepest first, so `.claude/skills` before `.claude`. */
export function planMadeFolders(observed: readonly MadeFolderObserved[]): {
  actions: MadeFolderAction[];
  conflicts: [];
} {
  const actions: MadeFolderAction[] = [];
  for (const o of observed) {
    if (o.state === 'kept') continue;
    actions.push(o.state === 'dir' ? { op: 'remove', folder: o.folder } : { op: 'forget', folder: o.folder });
  }
  actions.sort((a, b) =>
    a.folder.length !== b.folder.length ? b.folder.length - a.folder.length : a.folder < b.folder ? -1 : 1,
  );
  return { actions, conflicts: [] };
}
