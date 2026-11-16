// Which found skills the user selected for [Add] (PLAN.md §3.18), kept while they move between the table and the review
// of each skill: local UI state, by import. A skill whose name is already used starts unselected.
import type { ImportCandidateView, ImportSessionView } from '@app/ipc';
import { create } from 'zustand';

interface SelectionState {
  /** By import id: the ids the user selected; an import without an entry has its default selection. */
  readonly chosen: Readonly<Record<string, readonly string[]>>;
  readonly set: (importId: string, ids: readonly string[]) => void;
}

export const useSelectionStore = create<SelectionState>((setState) => ({
  chosen: {},
  set: (importId, ids) => setState((state) => ({ chosen: { ...state.chosen, [importId]: ids } })),
}));

/** The default: every skill that can be added as it is. */
export function defaultSelection(candidates: readonly ImportCandidateView[]): string[] {
  return candidates.filter((c) => c.clash === null).map((c) => c.id);
}

export function selectedIn(session: ImportSessionView, chosen: Readonly<Record<string, readonly string[]>>): string[] {
  const ids = new Set(session.candidates.map((c) => c.id));
  return (chosen[session.id] ?? defaultSelection(session.candidates)).filter((id) => ids.has(id));
}

/** The review gate as the table shows it: [Add] needs a selection, and every selected skill opened (✓). */
export function gateOf(session: ImportSessionView, selected: readonly string[]): { canAdd: boolean; waiting: number } {
  const waiting = session.candidates.filter((c) => selected.includes(c.id) && !c.opened).length;
  return { canAdd: selected.length > 0 && waiting === 0, waiting };
}
