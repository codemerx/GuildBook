// What a click on an overview cell asks (PLAN.md §3.6 "Click a cell to place or remove the skill there", "How the app
// enforces it"): the question, and the placement edits behind each answer.
// - Placing a skill that's available everywhere asks "Make it available only in <repo>?" [Move to <repo> only].
// - Removing a skill from its last repo asks [Make it available everywhere] [Turn it off].
// - A skill set to Everywhere can't be excluded from one repo: its cell offers to switch it to specific repos.
import type { OverviewRowView, PlacementEditView, RepoView } from '@app/ipc';

export interface CellQuestion {
  /** A translation key and its parameters, for the dialog's title. */
  readonly title: { readonly key: string; readonly params: Record<string, string> };
  readonly body: { readonly key: string; readonly params: Record<string, string> } | null;
  readonly choices: ReadonlyArray<{
    readonly label: { readonly key: string; readonly params: Record<string, string> };
    readonly edits: readonly PlacementEditView[];
  }>;
}

const k = (key: string, params: Record<string, string> = {}) => ({ key, params });

/** The question a repo cell asks. */
export function repoCellQuestion(row: OverviewRowView, repo: RepoView): CellQuestion {
  const skill = row.skill;
  const params = { skill, repo: repo.name };
  const cell = row.cells.find((c) => c.repo === repo.id)?.cell ?? { kind: 'none' as const };
  const add: PlacementEditView = { op: 'add', repo: repo.id, skill, on: true };
  switch (cell.kind) {
    case 'placed': {
      // Unticking a placed cell: an exclusion where a tag places it, else the addition ends.
      const edit: PlacementEditView =
        cell.via.length > 0
          ? { op: 'exclude', repo: repo.id, skill, on: true }
          : { op: 'add', repo: repo.id, skill, on: false };
      const others = row.cells.filter((c) => c.repo !== repo.id && c.cell.kind !== 'none');
      if (cell.via.length === 0 && others.length === 0) {
        // Its last repo, and nothing else claims it (Day 16).
        return {
          title: k('placement.cell.lastRepoTitle', params),
          body: k('placement.cell.lastRepoBody', params),
          choices: [
            { label: k('placement.cell.everywhere'), edits: [edit] },
            { label: k('placement.cell.turnOff'), edits: [edit, { op: 'mode', skill, mode: 'off' }] },
          ],
        };
      }
      return {
        title: k('placement.cell.removeTitle', params),
        body: cell.via.length > 0 ? k('placement.cell.removeViaBody', { ...params, tags: cell.via.join(', ') }) : null,
        choices: [{ label: k('placement.cell.remove', params), edits: [edit] }],
      };
    }
    case 'excluded':
      return {
        title: k('placement.cell.includeTitle', params),
        body: null,
        choices: [
          { label: k('placement.cell.include', params), edits: [{ op: 'exclude', repo: repo.id, skill, on: false }] },
        ],
      };
    case 'via-global':
      return {
        title: k('placement.cell.everywhereTitle', params),
        body: k('placement.cell.everywhereBody', params),
        choices: [
          { label: k('placement.cell.moveOnly', params), edits: [{ op: 'mode', skill, mode: 'default' }, add] },
        ],
      };
    case 'off':
      return {
        title: k('placement.cell.turnOnTitle', params),
        body: null,
        choices: [
          { label: k('placement.cell.turnOnHere', params), edits: [{ op: 'mode', skill, mode: 'default' }, add] },
        ],
      };
    case 'none': {
      if (row.global.kind === 'placed' || row.global.kind === 'by-choice') {
        // "acme-db-migrations is currently available everywhere. Make it available only in backend-api?"
        const edits: PlacementEditView[] =
          row.global.kind === 'by-choice' ? [{ op: 'mode', skill, mode: 'default' }, add] : [add];
        return {
          title: k('placement.cell.moveTitle', params),
          body: k('placement.cell.moveBody', params),
          choices: [{ label: k('placement.cell.moveOnly', params), edits }],
        };
      }
      const edits: PlacementEditView[] = row.mode === 'off' ? [{ op: 'mode', skill, mode: 'default' }, add] : [add];
      return {
        title: k('placement.cell.addTitle', params),
        body: null,
        choices: [{ label: k('placement.cell.add', params), edits }],
      };
    }
  }
}

/** The question the Global cell asks. */
export function globalCellQuestion(row: OverviewRowView): CellQuestion {
  const skill = row.skill;
  switch (row.global.kind) {
    case 'placed':
      return {
        title: k('placement.cell.globalOffTitle', { skill }),
        body: null,
        choices: [{ label: k('placement.cell.turnOff'), edits: [{ op: 'mode', skill, mode: 'off' }] }],
      };
    case 'by-choice':
      return {
        title: k('placement.cell.byChoiceTitle', { skill }),
        body: k('placement.cell.byChoiceBody', { skill }),
        choices: [
          { label: k('placement.cell.useRules'), edits: [{ op: 'mode', skill, mode: 'default' }] },
          { label: k('placement.cell.turnOff'), edits: [{ op: 'mode', skill, mode: 'off' }] },
        ],
      };
    case 'off':
      return {
        title: k('placement.cell.turnOnTitle', { skill, repo: '' }),
        body: null,
        choices: [{ label: k('placement.cell.turnOn'), edits: [{ op: 'mode', skill, mode: 'default' }] }],
      };
    case 'none':
      return {
        title: k('placement.cell.makeEverywhereTitle', { skill }),
        body: k('placement.cell.makeEverywhereBody', { skill }),
        choices: [{ label: k('placement.cell.makeEverywhere'), edits: [{ op: 'mode', skill, mode: 'global' }] }],
      };
  }
}

/**
 * Bulk actions on the selected rows (PLAN.md §3.6 "Bulk"). Placing a skill that's Everywhere or Off in a repo first
 * hands it back to the rules, as its cell does; a skill set to Everywhere can't be excluded from one repo, so excluding
 * leaves it out.
 */
export function bulkEdits(
  action: 'place' | 'exclude' | 'off',
  rows: readonly OverviewRowView[],
  repo: string | null,
): PlacementEditView[] {
  if (action === 'off') return rows.map((row) => ({ op: 'mode', skill: row.skill, mode: 'off' }));
  if (repo === null) return [];
  return rows.flatMap((row): PlacementEditView[] => {
    const skill = row.skill;
    if (action === 'exclude') return row.mode === 'global' ? [] : [{ op: 'exclude', repo, skill, on: true }];
    const back: PlacementEditView[] = row.mode === 'default' ? [] : [{ op: 'mode', skill, mode: 'default' }];
    return [...back, { op: 'add', repo, skill, on: true }];
  });
}
