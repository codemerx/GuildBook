// One repo's page (PLAN.md §3.6 "Repo screen example"): its folder and remote, its worktrees, its tags with how many
// skills each ticks, and every skill with how it's placed there ("via backend, database", "added individually",
// "excluded by you"). Ticking a tag is a lasting rule; every change shows its plan first. A repo whose folder is gone
// (S10) offers [Locate] and [Remove repo]; removing it asks about each skill it leaves in no repo.
import type { InstanceView, OverviewView, RepoView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useNavigate, useParams } from '@tanstack/react-router';
import { AlertTriangle, MapPin, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeviceQuery, useInstanceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { LibraryNav } from '../links/library-nav.tsx';
import { type CellQuestion, repoCellQuestion } from './cell-actions.ts';
import { PlacementConfirm, type PlacementActions, placementActions } from './placement-confirm.tsx';
import { RemovalConfirm } from './removal-confirm.tsx';
import { type RepoActions, repoActions, Suggestions } from './repos-page.tsx';

export function RepoPageView({
  instance,
  overview,
  repo,
  home,
  actions,
  repos,
  onRemoved,
}: {
  instance: InstanceView;
  overview: OverviewView;
  repo: RepoView;
  home: string | undefined;
  actions: PlacementActions;
  repos: RepoActions;
  onRemoved: () => void;
}) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState<CellQuestion | null>(null);
  const [tag, setTag] = useState<{ tag: string; on: boolean } | null>(null);
  const [remove, setRemove] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const how = (via: readonly string[], added: boolean, excluded: boolean) =>
    [
      via.length > 0 ? t('placement.how.via', { tags: via.join(', ') }) : null,
      added ? t('placement.how.added') : null,
      excluded ? t('placement.how.excluded') : null,
    ]
      .filter(Boolean)
      .join(' · ');
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">{repo.name}</h1>
        <LibraryNav instanceId={instance.id} attention={instance.attention} />
        <p className="flex flex-wrap items-baseline gap-1 text-sm text-muted-foreground">
          <PathText path={repo.path} home={home} />
          {repo.remote && <span>· {repo.remote}</span>}
        </p>
      </header>
      {repo.missingSince !== null && (
        <Card role="region" aria-label={t('placement.repo.missingTitle', { repo: repo.name })}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle aria-hidden="true" className="size-4 text-danger" />
              {t('placement.repo.missingTitle', { repo: repo.name })}
            </CardTitle>
            <CardDescription>{t('placement.repo.missingBody')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void repos.locate(repo.id).catch((e: unknown) => setError(e as ErrorView))}
            >
              <MapPin aria-hidden="true" />
              {t('placement.repo.locate')}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setRemove(true)}>
              {t('placement.repo.remove')}
            </Button>
          </CardContent>
        </Card>
      )}
      {error && <ErrorMessage error={error} />}
      <Suggestions repo={repo} repos={repos} actions={actions} overview={overview} />
      {repo.worktrees.length > 0 && (
        <section aria-label={t('placement.repo.worktreesLabel')} className="flex flex-col gap-1 text-sm">
          <h2 className="font-medium">{t('placement.repo.worktreesTitle')}</h2>
          <ul className="flex flex-col gap-1">
            {repo.worktrees.map((tree) => (
              <li key={tree}>
                <PathText path={tree} home={home} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <Card role="region" aria-label={t('placement.repo.tags')}>
        <CardHeader>
          <CardTitle>{t('placement.repo.tags')}</CardTitle>
          <CardDescription>{t('placement.repo.tagsBody')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1 text-sm">
            {[...new Set([...overview.tags.map((entry) => entry.tag), ...repo.gone])].sort().map((name) => {
              const ticked = repo.rules.includes(name);
              const count = overview.tags.find((entry) => entry.tag === name)?.skills ?? 0;
              return (
                <li key={name} className="flex items-center gap-2">
                  <label className="flex grow items-center gap-2">
                    <input type="checkbox" checked={ticked} onChange={() => setTag({ tag: name, on: !ticked })} />
                    <span className="font-medium">{name}</span>
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {repo.gone.includes(name)
                      ? t('placement.repo.tagGone')
                      : ticked
                        ? t('placement.repo.tagSkills', { count })
                        : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
      <Card role="region" aria-label={t('placement.repo.skills')}>
        <CardHeader>
          <CardTitle>{t('placement.repo.skills')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1 text-sm">
            {overview.rows.map((row) => {
              const cell = row.cells.find((c) => c.repo === repo.id)?.cell ?? { kind: 'none' as const };
              const on = cell.kind === 'placed' || cell.kind === 'via-global';
              const label =
                cell.kind === 'none'
                  ? ''
                  : cell.kind === 'via-global'
                    ? t('placement.cellText.viaGlobal')
                    : cell.kind === 'off'
                      ? t('placement.cellText.off')
                      : how(cell.via, cell.added, cell.kind === 'excluded');
              return (
                <li key={row.skill} className="flex items-center gap-2">
                  <label className="flex grow items-center gap-2">
                    <input type="checkbox" checked={on} onChange={() => setQuestion(repoCellQuestion(row, repo))} />
                    <span className="font-mono text-xs">{row.skill}</span>
                  </label>
                  <span className="text-xs text-muted-foreground">{label}</span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
      {repo.missingSince === null && (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setRemove(true)}>
            <Trash2 aria-hidden="true" />
            {t('placement.repo.remove')}
          </Button>
        </div>
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
      {tag && (
        <PlacementConfirm
          actions={actions}
          open
          onOpenChange={(open) => !open && setTag(null)}
          title={t(tag.on ? 'placement.repo.tickTitle' : 'placement.repo.untickTitle', {
            tag: tag.tag,
            repo: repo.name,
          })}
          choices={[
            { label: t('placement.confirm.apply'), edits: [{ op: 'rule', repo: repo.id, tag: tag.tag, on: tag.on }] },
          ]}
        />
      )}
      {remove && (
        <RemovalConfirm
          actions={{
            preview: (edits) => actions.preview(edits),
            apply: async (edits, hash) => {
              await actions.apply(edits, hash);
              onRemoved();
            },
          }}
          onOpenChange={setRemove}
          title={t('placement.repo.removeTitle', { repo: repo.name })}
          description={t('placement.repo.removeBody')}
          label={t('placement.repo.remove')}
          edits={[{ op: 'remove-repo', repo: repo.id }]}
        />
      )}
    </div>
  );
}

export function RepoPage() {
  const { t } = useTranslation();
  const { instanceId, repoId } = useParams({ from: '/library/$instanceId/repos/$repoId' });
  const navigate = useNavigate();
  const instances = useDeviceQuery('instances');
  const appInfo = useDeviceQuery('appInfo');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const overview = useInstanceQuery(instance?.status === 'ready' ? instanceId : undefined, 'overview');
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  const repo = overview.data?.repos.find((r) => r.id === repoId);
  if (!overview.data) return null;
  if (!repo) return <p>{t('placement.repo.gone')}</p>;
  return (
    <RepoPageView
      instance={instance}
      overview={overview.data}
      repo={repo}
      home={appInfo.data?.homePath}
      actions={placementActions(instanceId)}
      repos={repoActions(instanceId)}
      onRemoved={() => void navigate({ to: '/library/$instanceId/repos', params: { instanceId } })}
    />
  );
}
