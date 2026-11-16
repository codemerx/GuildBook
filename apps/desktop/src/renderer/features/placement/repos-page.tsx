// The repos of a library (PLAN.md §3.6 "Adding repos"): the repo folders and parent folders the user added, each repo
// named after its remote, its worktrees, its ticked tags, and the tag suggestions library.yaml makes for it ("This
// looks like a backend repo. Use the backend tag?"). Nothing is applied without a click. The app never searches the
// disk on its own: the user picks each folder. [Remove] on a parent folder removes the repos found in it, except those
// the user keeps.
import type { InstanceView, OverviewView, PlacementEditView, RepoView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { Link, useParams } from '@tanstack/react-router';
import { AlertTriangle, FolderGit2, FolderPlus, GitBranch, Lightbulb, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, keys, queryClient, useDeviceQuery, useInstanceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { displayPath, PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { LibraryNav } from '../links/library-nav.tsx';
import { pickFolder } from '../shell/folder-access.tsx';
import { PlacementConfirm, type PlacementActions, placementActions } from './placement-confirm.tsx';
import { RemovalConfirm } from './removal-confirm.tsx';

export interface RepoActions {
  /** Picks a folder and adds it as a repo; false when the dialog was cancelled. */
  addRepo(): Promise<boolean>;
  addRoot(): Promise<boolean>;
  dismiss(repo: string, tag: string): Promise<void>;
  /** S10 [Locate]: picks the repo's new folder. */
  locate(repo: string): Promise<boolean>;
}

export function repoActions(instanceId: string): RepoActions {
  const pick = pickFolder;
  return {
    async addRepo() {
      const path = await pick('repo');
      if (path === null) return false;
      await callInstance(instanceId, 'addRepo', { path });
      return true;
    },
    async addRoot() {
      const path = await pick('repo-root');
      if (path === null) return false;
      await callInstance(instanceId, 'addRepoRoot', { path });
      return true;
    },
    async dismiss(repo, tag) {
      await callInstance(instanceId, 'dismissSuggestion', { repo, tag });
      // No link changes, so no event: the overview is read again here.
      await queryClient.invalidateQueries({ queryKey: keys.instance(instanceId, 'overview') });
    },
    async locate(repo) {
      const path = await pick('repo');
      if (path === null) return false;
      await callInstance(instanceId, 'locateRepo', { repo, path });
      return true;
    },
  };
}

/** "This looks like a backend repo. Use the backend tag?" [Use backend] [No thanks]. */
export function Suggestions({
  repo,
  repos,
  actions,
  overview,
}: {
  repo: RepoView;
  repos: RepoActions;
  actions: PlacementActions;
  overview: OverviewView;
}) {
  const { t } = useTranslation();
  const [use, setUse] = useState<string | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  if (repo.suggestions.length === 0) return null;
  const count = (tag: string) => overview.tags.find((entry) => entry.tag === tag)?.skills ?? 0;
  return (
    <div className="flex flex-col gap-2">
      {repo.suggestions.map((tag) => (
        <div
          key={tag}
          role="note"
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted p-3 text-sm"
        >
          <Lightbulb aria-hidden="true" className="size-4 shrink-0" />
          <span className="grow">{t('placement.suggest.text', { repo: repo.name, tag, count: count(tag) })}</span>
          <Button type="button" size="sm" onClick={() => setUse(tag)}>
            {t('placement.suggest.use', { tag })}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void repos.dismiss(repo.id, tag).catch((e: unknown) => setError(e as ErrorView))}
          >
            {t('placement.suggest.dismiss')}
          </Button>
        </div>
      ))}
      {error && <ErrorMessage error={error} />}
      {use && (
        <PlacementConfirm
          actions={actions}
          open
          onOpenChange={(open) => !open && setUse(null)}
          title={t('placement.repo.tickTitle', { tag: use, repo: repo.name })}
          choices={[
            { label: t('placement.confirm.apply'), edits: [{ op: 'rule', repo: repo.id, tag: use, on: true }] },
          ]}
        />
      )}
    </div>
  );
}

function RepoRow({
  repo,
  home,
  instanceId,
  repos,
  actions,
  overview,
}: {
  repo: RepoView;
  home: string | undefined;
  instanceId: string;
  repos: RepoActions;
  actions: PlacementActions;
  overview: OverviewView;
}) {
  const { t } = useTranslation();
  const placed = overview.rows.filter((row) =>
    row.cells.some((cell) => cell.repo === repo.id && cell.cell.kind === 'placed'),
  ).length;
  return (
    <Card role="region" aria-label={repo.name}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <FolderGit2 aria-hidden="true" className="size-4" />
          <Link
            to="/library/$instanceId/repos/$repoId"
            params={{ instanceId, repoId: repo.id }}
            className="underline-offset-2 hover:underline"
          >
            {repo.name}
          </Link>
          {repo.missingSince !== null && (
            <span className="inline-flex items-center gap-1 text-sm font-medium text-danger">
              <AlertTriangle aria-hidden="true" className="size-4" />
              {t('placement.repo.notFound')}
            </span>
          )}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-baseline gap-1">
          <PathText path={repo.path} home={home} />
          {repo.remote && <span>· {repo.remote}</span>}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">
          {[
            repo.rules.length > 0
              ? t('placement.repo.rules', { tags: repo.rules.join(', ') })
              : t('placement.repo.noRules'),
            t('placement.repo.placed', { count: placed }),
            repo.worktrees.length > 0 ? t('placement.repo.worktrees', { count: repo.worktrees.length }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <Suggestions repo={repo} repos={repos} actions={actions} overview={overview} />
      </CardContent>
    </Card>
  );
}

export function ReposPageView({
  instance,
  overview,
  home,
  repos,
  actions,
}: {
  instance: InstanceView;
  overview: OverviewView | undefined;
  home: string | undefined;
  repos: RepoActions;
  actions: PlacementActions;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeRoot, setRemoveRoot] = useState<string | null>(null);
  const run = (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    task()
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">{t('placement.repos.title', { name: instance.name })}</h1>
        <LibraryNav instanceId={instance.id} attention={instance.attention} />
        <p className="text-sm text-muted-foreground">{t('placement.repos.body')}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => run(() => repos.addRepo())}>
            <FolderPlus aria-hidden="true" />
            {t('placement.repos.addRepo')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => run(() => repos.addRoot())}
          >
            <FolderPlus aria-hidden="true" />
            {t('placement.repos.addRoot')}
          </Button>
        </div>
        {error && <ErrorMessage error={error} />}
      </header>
      {overview && overview.roots.length > 0 && (
        <section aria-label={t('placement.repos.rootsLabel')} className="flex flex-col gap-1 text-sm">
          <h2 className="font-medium">{t('placement.repos.roots')}</h2>
          <ul className="flex flex-col gap-1">
            {overview.roots.map((root) => (
              <li key={root} className="flex items-center gap-2">
                <GitBranch aria-hidden="true" className="size-3.5 text-muted-foreground" />
                <PathText path={root} home={home} />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('placement.repos.removeRootLabel', { path: displayPath(root, home) })}
                  onClick={() => setRemoveRoot(root)}
                >
                  <Trash2 aria-hidden="true" />
                  {t('placement.repos.removeRoot')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {overview && overview.repos.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('placement.repos.empty')}</p>
      )}
      {overview?.repos.map((repo) => (
        <RepoRow
          key={repo.id}
          repo={repo}
          home={home}
          instanceId={instance.id}
          repos={repos}
          actions={actions}
          overview={overview}
        />
      ))}
      {overview && removeRoot !== null && (
        <RemoveRootConfirm
          root={removeRoot}
          found={overview.repos.filter((repo) => repo.root === removeRoot)}
          home={home}
          actions={actions}
          onOpenChange={(open) => {
            if (!open) setRemoveRoot(null);
          }}
        />
      )}
    </div>
  );
}

/** [Remove] on a parent folder: the repos found in it go, except those ticked to keep (PLAN.md §3.6 "Adding repos"). */
function RemoveRootConfirm({
  root,
  found,
  home,
  actions,
  onOpenChange,
}: {
  root: string;
  found: readonly RepoView[];
  home: string | undefined;
  actions: PlacementActions;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [keep, setKeep] = useState<ReadonlySet<string>>(new Set());
  const tick = (repo: string, on: boolean) => {
    const next = new Set(keep);
    if (on) next.add(repo);
    else next.delete(repo);
    setKeep(next);
  };
  return (
    <RemovalConfirm
      actions={actions}
      onOpenChange={onOpenChange}
      title={t('placement.repos.removeRootTitle', { path: displayPath(root, home) })}
      description={t('placement.repos.removeRootBody')}
      label={t('placement.repos.removeRootConfirm')}
      edits={[{ op: 'remove-root', root, keep: found.filter((repo) => keep.has(repo.id)).map((repo) => repo.id) }]}
    >
      {found.length > 0 && (
        <section aria-label={t('placement.repos.keepTitle')} className="flex flex-col gap-2 text-sm">
          <h3 className="font-medium">{t('placement.repos.keepTitle')}</h3>
          <p className="text-muted-foreground">{t('placement.repos.keepBody')}</p>
          <ul className="flex flex-col gap-1">
            {found.map((repo) => (
              <li key={repo.id}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={keep.has(repo.id)}
                    onChange={(event) => tick(repo.id, event.target.checked)}
                  />
                  {t('placement.repos.keep', { repo: repo.name })}
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}
    </RemovalConfirm>
  );
}

export function ReposPage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId/repos' });
  const instances = useDeviceQuery('instances');
  const appInfo = useDeviceQuery('appInfo');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const overview = useInstanceQuery(instance?.status === 'ready' ? instanceId : undefined, 'overview');
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  return (
    <ReposPageView
      instance={instance}
      overview={overview.data}
      home={appInfo.data?.homePath}
      repos={repoActions(instanceId)}
      actions={placementActions(instanceId)}
    />
  );
}

/** Edits that tick or untick a tag on a repo. */
export const ruleEdit = (repo: string, tag: string, on: boolean): PlacementEditView[] => [
  { op: 'rule', repo, tag, on },
];
