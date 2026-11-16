// The overview (PLAN.md §3.6 "Overview screen"): one table with every skill × Global and each added repo, with the
// skill's tags. A cell shows ● placed (how, on hover), ○ excluded, ● via global, (off), or a red problem that opens
// "Needs attention". Clicking a cell places or removes the skill there, after a confirmation built from the plan.
// Filters (tag, repo, only problems, only Off), bulk actions on selected rows, the two other views (by repo, by tag),
// and [Reset to tag rules]. The table renders only the rows in view, for libraries with 1,000 skills.
import type { InstanceView, OverviewRowView, OverviewView, PlacementEditView, RepoView } from '@app/ipc';
import { Link, useParams } from '@tanstack/react-router';
import { AlertTriangle, FolderPlus, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeviceQuery, useInstanceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { cn } from '../../ui/cn.ts';
import { VirtualRows } from '../../ui/virtual-rows.tsx';
import { LibraryNav } from '../links/library-nav.tsx';
import { bulkEdits, type CellQuestion, globalCellQuestion, repoCellQuestion } from './cell-actions.ts';
import { PlacementConfirm, type PlacementActions, placementActions } from './placement-confirm.tsx';
import { type RepoActions, repoActions } from './repos-page.tsx';

export type OverviewGrouping = 'skills' | 'repos' | 'tags';

export interface OverviewFilters {
  readonly tag: string | null;
  readonly repo: string | null;
  readonly problems: boolean;
  readonly off: boolean;
}

export const NO_FILTERS: OverviewFilters = { tag: null, repo: null, problems: false, off: false };

const hasProblem = (row: OverviewRowView) =>
  row.globalProblems.length > 0 || row.cells.some((cell) => cell.problems.length > 0);

/** The rows the filters keep (PLAN.md §3.6 "Filters: by tag, by repo, only problems, only Off"). */
export function filterRows(rows: readonly OverviewRowView[], filters: OverviewFilters): OverviewRowView[] {
  return rows.filter(
    (row) =>
      (filters.tag === null || row.tags.includes(filters.tag)) &&
      (filters.repo === null || row.cells.some((c) => c.repo === filters.repo && c.cell.kind !== 'none')) &&
      (!filters.problems || hasProblem(row)) &&
      (!filters.off || row.mode === 'off'),
  );
}

const ROW_HEIGHT = 44;

const GROUPINGS: readonly OverviewGrouping[] = ['skills', 'repos', 'tags'];

function CellText({ text, tone }: { text: string; tone?: string }) {
  return <span className={cn('text-xs', tone)}>{text}</span>;
}

export function OverviewTable({
  overview,
  rows,
  selected,
  onSelect,
  onCell,
  instanceId,
}: {
  overview: OverviewView;
  rows: readonly OverviewRowView[];
  selected: ReadonlySet<string>;
  onSelect: (skill: string, on: boolean) => void;
  onCell: (question: CellQuestion) => void;
  instanceId: string;
}) {
  const { t } = useTranslation();
  const columns = `2.5rem minmax(13rem, 1.4fr) minmax(8rem, 1fr) repeat(${overview.repos.length + 1}, minmax(8.5rem, 1fr))`;
  const how = (via: readonly string[], added: boolean) =>
    [via.length > 0 ? t('placement.how.via', { tags: via.join(', ') }) : null, added ? t('placement.how.added') : null]
      .filter(Boolean)
      .join(' · ');
  const problemText = (problem: OverviewRowView['globalProblems'][number]) =>
    problem.status === 'skipped' && problem.reason === 'committed'
      ? t('placement.problem.committed')
      : t('placement.problem.status', { status: t(`links.status.${problem.status}`), tools: problem.tools.join(', ') });
  return (
    <div role="table" aria-label={t('placement.table.label')} aria-rowcount={rows.length + 1} className="text-sm">
      <div role="rowgroup">
        <div
          role="row"
          aria-rowindex={1}
          className="grid items-end gap-2 border-b border-border pb-2 font-medium text-muted-foreground"
          style={{ gridTemplateColumns: columns }}
        >
          {/* The cell keeps its grid column; only its text is hidden. */}
          <span role="columnheader">
            <span className="sr-only">{t('placement.table.select')}</span>
          </span>
          <span role="columnheader">{t('placement.table.skill')}</span>
          <span role="columnheader">{t('placement.table.tags')}</span>
          <span role="columnheader">{t('placement.table.global')}</span>
          {overview.repos.map((repo) => (
            <span role="columnheader" key={repo.id} className="flex flex-col">
              <Link
                to="/library/$instanceId/repos/$repoId"
                params={{ instanceId, repoId: repo.id }}
                className="truncate text-foreground underline-offset-2 hover:underline"
              >
                {repo.name}
              </Link>
              {repo.missingSince !== null && (
                <span className="inline-flex items-center gap-1 text-xs text-danger">
                  <AlertTriangle aria-hidden="true" className="size-3" />
                  {t('placement.repo.notFound')}
                </span>
              )}
            </span>
          ))}
        </div>
      </div>
      <VirtualRows
        rows={rows}
        rowHeight={ROW_HEIGHT}
        height={Math.min(rows.length * ROW_HEIGHT, 520)}
        render={(row, index) => (
          <div
            role="row"
            key={row.skill}
            aria-rowindex={index + 2}
            className="grid items-center gap-2 border-b border-border/60"
            style={{ gridTemplateColumns: columns, height: ROW_HEIGHT }}
          >
            <span role="cell">
              <input
                type="checkbox"
                aria-label={t('placement.table.selectSkill', { skill: row.skill })}
                checked={selected.has(row.skill)}
                onChange={(event) => onSelect(row.skill, event.target.checked)}
              />
            </span>
            <span role="cell" className="truncate font-mono text-xs">
              {row.skill}
            </span>
            <span role="cell" className="truncate text-xs text-muted-foreground">
              {row.tags.join(', ')}
            </span>
            <span role="cell">
              {row.globalProblems.length > 0 ? (
                <Link
                  to="/library/$instanceId/attention"
                  params={{ instanceId }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-danger"
                >
                  <AlertTriangle aria-hidden="true" className="size-3.5" />
                  {problemText(row.globalProblems[0] as OverviewRowView['globalProblems'][number])}
                </Link>
              ) : (
                <button
                  type="button"
                  className="w-full rounded px-1 py-1 text-left hover:bg-accent"
                  aria-label={t('placement.cell.globalLabel', {
                    skill: row.skill,
                    state: t(`placement.global.${row.global.kind === 'none' ? row.global.why : row.global.kind}`),
                  })}
                  title={t(`placement.global.${row.global.kind === 'none' ? row.global.why : row.global.kind}`)}
                  onClick={() => onCell(globalCellQuestion(row))}
                >
                  {row.global.kind === 'placed' && <CellText text={t('placement.cellText.global')} />}
                  {row.global.kind === 'by-choice' && <CellText text={t('placement.cellText.byChoice')} />}
                  {row.global.kind === 'off' && (
                    <CellText text={t('placement.cellText.off')} tone="text-muted-foreground" />
                  )}
                  {row.global.kind === 'none' && row.global.why === 'excluded' && (
                    <CellText
                      text={t('placement.cellText.excludedIn', { repos: row.excludedIn.join(', ') })}
                      tone="text-muted-foreground"
                    />
                  )}
                  {row.global.kind === 'none' && row.global.why === 'repo-only' && (
                    <CellText text={t('placement.cellText.repoOnly')} tone="text-muted-foreground" />
                  )}
                </button>
              )}
            </span>
            {overview.repos.map((repo) => {
              const entry = row.cells.find((c) => c.repo === repo.id);
              const cell = entry?.cell ?? { kind: 'none' as const };
              const problem = entry?.problems[0];
              if (problem) {
                return (
                  <span role="cell" key={repo.id}>
                    <Link
                      to="/library/$instanceId/attention"
                      params={{ instanceId }}
                      className="inline-flex items-center gap-1 text-xs font-medium text-danger"
                    >
                      <AlertTriangle aria-hidden="true" className="size-3.5" />
                      {problemText(problem)}
                    </Link>
                  </span>
                );
              }
              const detail = cell.kind === 'none' ? '' : how(cell.via, cell.added);
              const state = t(`placement.state.${cell.kind}`, { how: detail });
              return (
                <span role="cell" key={repo.id}>
                  <button
                    type="button"
                    className="w-full rounded px-1 py-1 text-left hover:bg-accent"
                    aria-label={t('placement.cell.label', { skill: row.skill, repo: repo.name, state })}
                    title={state}
                    onClick={() => onCell(repoCellQuestion(row, repo))}
                  >
                    {cell.kind === 'placed' && <CellText text={t('placement.cellText.placed')} />}
                    {cell.kind === 'excluded' && (
                      <CellText text={t('placement.cellText.excluded')} tone="text-muted-foreground" />
                    )}
                    {cell.kind === 'via-global' && <CellText text={t('placement.cellText.viaGlobal')} />}
                    {cell.kind === 'off' && (
                      <CellText text={t('placement.cellText.off')} tone="text-muted-foreground" />
                    )}
                  </button>
                </span>
              );
            })}
          </div>
        )}
      />
    </div>
  );
}

/** "What does backend-api get?": each repo with the skills placed there. */
function ByRepo({ overview, rows }: { overview: OverviewView; rows: readonly OverviewRowView[] }) {
  const { t } = useTranslation();
  const groups = [
    {
      id: 'global',
      name: t('placement.table.global'),
      skills: rows
        .filter((r) => r.global.kind === 'placed' || r.global.kind === 'by-choice')
        .map((r) => ({ skill: r.skill, how: '' })),
    },
    ...overview.repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      skills: rows.flatMap((row) => {
        const cell = row.cells.find((c) => c.repo === repo.id)?.cell;
        if (cell?.kind !== 'placed') return [];
        return [
          {
            skill: row.skill,
            how: [
              cell.via.length > 0 ? t('placement.how.via', { tags: cell.via.join(', ') }) : '',
              cell.added ? t('placement.how.added') : '',
            ]
              .filter(Boolean)
              .join(' · '),
          },
        ];
      }),
    })),
  ];
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {groups.map((group) => (
        <Card key={group.id} role="region" aria-label={group.name}>
          <CardHeader>
            <CardTitle>{group.name}</CardTitle>
            <CardDescription>{t('placement.group.count', { count: group.skills.length })}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {group.skills.map((entry) => (
                <li key={entry.skill} className="flex justify-between gap-2">
                  <span className="font-mono text-xs">{entry.skill}</span>
                  <span className="text-xs text-muted-foreground">{entry.how}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** "Where is backend used?": each tag with its skills and where they are. */
function ByTag({ overview, rows }: { overview: OverviewView; rows: readonly OverviewRowView[] }) {
  const { t } = useTranslation();
  const name = (id: string) => overview.repos.find((r) => r.id === id)?.name ?? id;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {overview.tags.map(({ tag }) => {
        const skills = rows.filter((row) => row.tags.includes(tag));
        const ticked = overview.repos.filter((repo) => repo.rules.includes(tag)).map((repo) => repo.name);
        return (
          <Card key={tag} role="region" aria-label={tag}>
            <CardHeader>
              <CardTitle>{tag}</CardTitle>
              <CardDescription>
                {ticked.length > 0
                  ? t('placement.group.tickedOn', { repos: ticked.join(', ') })
                  : t('placement.group.notTicked')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-1 text-sm">
                {skills.map((row) => {
                  const where =
                    row.global.kind === 'placed' || row.global.kind === 'by-choice'
                      ? t('placement.where.everywhere')
                      : row.mode === 'off'
                        ? t('placement.cellText.off')
                        : row.cells
                            .filter((c) => c.cell.kind === 'placed')
                            .map((c) => name(c.repo))
                            .join(', ') || t('placement.where.nowhere');
                  return (
                    <li key={row.skill} className="flex justify-between gap-2">
                      <span className="font-mono text-xs">{row.skill}</span>
                      <span className="text-xs text-muted-foreground">{where}</span>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export function OverviewPageView({
  instance,
  overview,
  actions,
  repos,
  initial,
}: {
  instance: InstanceView;
  overview: OverviewView | undefined;
  actions: PlacementActions;
  repos: RepoActions;
  initial?: { grouping?: OverviewGrouping; filters?: OverviewFilters };
}) {
  const { t } = useTranslation();
  const [grouping, setGrouping] = useState<OverviewGrouping>(initial?.grouping ?? 'skills');
  const [filters, setFilters] = useState<OverviewFilters>(initial?.filters ?? NO_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [question, setQuestion] = useState<CellQuestion | null>(null);
  const [bulkRepo, setBulkRepo] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ edits: PlacementEditView[]; title: string; description?: string } | null>(null);
  const [reset, setReset] = useState(false);
  const [dropChoices, setDropChoices] = useState(false);
  const rows = useMemo(() => filterRows(overview?.rows ?? [], filters), [overview, filters]);
  const chosen = rows.filter((row) => selected.has(row.skill));
  const set = (patch: Partial<OverviewFilters>) => setFilters({ ...filters, ...patch });
  const repoFor = (id: string | null): RepoView | undefined => overview?.repos.find((r) => r.id === id);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">{t('placement.overview.title', { name: instance.name })}</h1>
        <LibraryNav instanceId={instance.id} attention={instance.attention} />
        <p className="text-sm text-muted-foreground">{t('placement.overview.body')}</p>
      </header>
      {overview && overview.repos.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('placement.overview.noReposTitle')}</CardTitle>
            <CardDescription>{t('placement.overview.noReposBody')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => void repos.addRepo()}>
              <FolderPlus aria-hidden="true" />
              {t('placement.repos.addRepo')}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => void repos.addRoot()}>
              <FolderPlus aria-hidden="true" />
              {t('placement.repos.addRoot')}
            </Button>
          </CardContent>
        </Card>
      )}
      {overview && (
        <section aria-label={t('placement.overview.controls')} className="flex flex-wrap items-end gap-4 text-sm">
          <fieldset className="flex items-center gap-1 rounded-md border border-border p-1">
            <legend className="sr-only">{t('placement.view.label')}</legend>
            {GROUPINGS.map((view) => (
              <label
                key={view}
                className={cn(
                  'cursor-pointer rounded px-2 py-1',
                  grouping === view ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground',
                )}
              >
                <input
                  type="radio"
                  name="grouping"
                  className="sr-only"
                  checked={grouping === view}
                  onChange={() => setGrouping(view)}
                />
                {t(`placement.view.${view}`)}
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('placement.filter.tag')}</span>
            <select
              aria-label={t('placement.filter.tag')}
              className="h-8 rounded-md border border-input bg-background px-2"
              value={filters.tag ?? ''}
              onChange={(event) => set({ tag: event.target.value || null })}
            >
              <option value="">{t('placement.filter.all')}</option>
              {overview.tags.map(({ tag }) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('placement.filter.repo')}</span>
            <select
              aria-label={t('placement.filter.repo')}
              className="h-8 rounded-md border border-input bg-background px-2"
              value={filters.repo ?? ''}
              onChange={(event) => set({ repo: event.target.value || null })}
            >
              <option value="">{t('placement.filter.all')}</option>
              {overview.repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={filters.problems} onChange={(e) => set({ problems: e.target.checked })} />
            {t('placement.filter.problems')}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={filters.off} onChange={(e) => set({ off: e.target.checked })} />
            {t('placement.filter.off')}
          </label>
          <Button type="button" size="sm" variant="secondary" className="ml-auto" onClick={() => setReset(true)}>
            <RotateCcw aria-hidden="true" />
            {t('placement.reset.button')}
          </Button>
        </section>
      )}
      {chosen.length > 0 && grouping === 'skills' && overview && (
        <section
          aria-label={t('placement.bulk.label')}
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted p-2 text-sm"
        >
          <span className="font-medium">{t('placement.bulk.selected', { count: chosen.length })}</span>
          <select
            aria-label={t('placement.bulk.repo')}
            className="h-8 rounded-md border border-input bg-background px-2"
            value={bulkRepo ?? ''}
            onChange={(event) => setBulkRepo(event.target.value || null)}
          >
            <option value="">{t('placement.bulk.chooseRepo')}</option>
            {overview.repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            disabled={bulkRepo === null}
            onClick={() =>
              setBulk({
                edits: bulkEdits('place', chosen, bulkRepo),
                title: t('placement.bulk.placeTitle', { count: chosen.length, repo: repoFor(bulkRepo)?.name ?? '' }),
              })
            }
          >
            {t('placement.bulk.place')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={bulkRepo === null}
            onClick={() => {
              const edits = bulkEdits('exclude', chosen, bulkRepo);
              // Skills set to Everywhere are left out: they can't be excluded from one repo (PLAN.md §3.6 "Bulk").
              const left = chosen.filter((row) => !edits.some((edit) => 'skill' in edit && edit.skill === row.skill));
              const repo = repoFor(bulkRepo)?.name ?? '';
              setBulk({
                edits,
                title:
                  edits.length > 0
                    ? t('placement.bulk.excludeTitle', { count: edits.length, repo })
                    : t('placement.bulk.excludeNoneTitle', { repo }),
                ...(left.length > 0
                  ? {
                      description: t('placement.bulk.leftOut', {
                        count: left.length,
                        skills: left.map((row) => row.skill).join(', '),
                      }),
                    }
                  : {}),
              });
            }}
          >
            {t('placement.bulk.exclude')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              setBulk({
                edits: bulkEdits('off', chosen, null),
                title: t('placement.bulk.offTitle', { count: chosen.length }),
              })
            }
          >
            {t('placement.bulk.off')}
          </Button>
        </section>
      )}
      {overview && grouping === 'skills' && (
        <OverviewTable
          overview={overview}
          rows={rows}
          selected={selected}
          instanceId={instance.id}
          onSelect={(skill, on) => {
            const next = new Set(selected);
            if (on) next.add(skill);
            else next.delete(skill);
            setSelected(next);
          }}
          onCell={setQuestion}
        />
      )}
      {overview && grouping === 'repos' && <ByRepo overview={overview} rows={rows} />}
      {overview && grouping === 'tags' && <ByTag overview={overview} rows={rows} />}
      {overview && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('placement.overview.noRows')}</p>
      )}
      {question && (
        <PlacementConfirm
          actions={actions}
          open
          onOpenChange={(open) => !open && setQuestion(null)}
          title={t(question.title.key, question.title.params)}
          description={question.body ? t(question.body.key, question.body.params) : undefined}
          choices={question.choices.map((choice) => ({
            label: t(choice.label.key, choice.label.params),
            edits: choice.edits,
          }))}
        />
      )}
      {bulk && (bulk.edits.length > 0 || bulk.description !== undefined) && (
        <PlacementConfirm
          actions={actions}
          open
          onOpenChange={(open) => {
            if (open) return;
            setBulk(null);
            setSelected(new Set());
          }}
          title={bulk.title}
          description={bulk.description}
          choices={bulk.edits.length > 0 ? [{ label: t('placement.confirm.apply'), edits: bulk.edits }] : []}
        />
      )}
      {reset && (
        <PlacementConfirm
          actions={actions}
          open
          onOpenChange={setReset}
          title={t('placement.reset.title')}
          description={t('placement.reset.body')}
          choices={[{ label: t('placement.confirm.apply'), edits: [{ op: 'reset', dropChoices }] }]}
        >
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={dropChoices} onChange={(event) => setDropChoices(event.target.checked)} />
            {t('placement.reset.dropChoices')}
          </label>
        </PlacementConfirm>
      )}
    </div>
  );
}

export function OverviewPage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId/overview' });
  const instances = useDeviceQuery('instances');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const overview = useInstanceQuery(instance?.status === 'ready' ? instanceId : undefined, 'overview');
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  return (
    <OverviewPageView
      instance={instance}
      overview={overview.data}
      actions={placementActions(instanceId)}
      repos={repoActions(instanceId)}
    />
  );
}
