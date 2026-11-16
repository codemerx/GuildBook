// What a placement confirmation says about each skill that moves (PLAN.md §3.6): "available in backend-api only, no
// longer everywhere", "removed from backend-billing, still in backend-api", "no longer linked anywhere, because
// backend-api excludes it". Built from the plan's moves, so the text is what's applied.
import type { PlacedWhereView, PlacementPlanView } from '@app/ipc';

export interface MoveLine {
  readonly key: string;
  readonly params: Record<string, string>;
}

const list = (names: readonly string[]) => names.join(', ');

export function moveLine(move: PlacementPlanView['moves'][number]): MoveLine {
  const { skill, from, to } = move;
  const params = (extra: Record<string, string> = {}) => ({ skill, ...extra });
  const removed = from.repos.filter((repo) => !to.repos.includes(repo));
  const added = to.repos.filter((repo) => !from.repos.includes(repo));
  if (to.kind === 'off') return { key: 'placement.moves.off', params: params() };
  if (to.kind === 'excluded')
    return { key: 'placement.moves.excluded', params: params({ repos: list(to.excludedIn) }) };
  if (to.kind === 'repo-only') return { key: 'placement.moves.repoOnly', params: params() };
  if (to.global) {
    const key = to.kind === 'everywhere' ? 'placement.moves.everywhereByChoice' : 'placement.moves.everywhere';
    return from.repos.length > 0
      ? { key: `${key}From`, params: params({ repos: list(from.repos) }) }
      : { key, params: params() };
  }
  if (from.global) return { key: 'placement.moves.reposOnly', params: params({ repos: list(to.repos) }) };
  if (from.repos.length === 0) return { key: 'placement.moves.added', params: params({ repos: list(to.repos) }) };
  if (added.length === 0)
    return { key: 'placement.moves.removedStill', params: params({ removed: list(removed), kept: list(to.repos) }) };
  if (removed.length === 0) return { key: 'placement.moves.addedToo', params: params({ added: list(added) }) };
  return { key: 'placement.moves.moved', params: params({ from: list(from.repos), to: list(to.repos) }) };
}

/** Where a skill is, in a few words: for the "before" of a move. */
export function whereKey(where: PlacedWhereView): MoveLine {
  if (where.global) return { key: 'placement.where.everywhere', params: {} };
  if (where.repos.length > 0) return { key: 'placement.where.repos', params: { repos: list(where.repos) } };
  return { key: 'placement.where.nowhere', params: {} };
}
