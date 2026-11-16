// The developer git page (IMPLEMENTATION.md Step 3 "Tour"): what the git engine reads from the library, in development
// and test builds only. The branch and its upstream, local changes, a merge or rebase in progress with its conflicts,
// incoming commits and the history. States show an icon and a word, never colour alone (PLAN.md §3.19). The real git
// screens come with Step 11.
import type { GitChangeView, GitCommitView, InstanceView, LibraryGitView } from '@app/ipc';
import { Link, useParams } from '@tanstack/react-router';
import { AlertCircle, ArrowDown, ArrowUp, CheckCircle2, GitMerge, Loader2, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDeviceQuery, useInstanceQuery } from '../../rpc/queries.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';

const shortId = (id: string | null) => (id === null ? null : id.slice(0, 7));

/** A commit time in UTC, the same on every device and in every screenshot. */
function CommitTime({ ms }: { ms: number }) {
  const iso = new Date(ms).toISOString();
  return (
    <time dateTime={iso} data-time="" className="tabular-nums">
      {`${iso.slice(0, 10)} ${iso.slice(11, 16)}`}
    </time>
  );
}

function Branch({ git }: { git: LibraryGitView }) {
  const { t } = useTranslation();
  const rows: Array<[string, React.ReactNode]> = [
    [t('gitPage.branch'), git.branch ?? t('gitPage.detached')],
    [t('gitPage.head'), <span className="font-mono text-xs">{shortId(git.head) ?? t('gitPage.noCommits')}</span>],
    [t('gitPage.upstream'), git.upstream ?? t('gitPage.noUpstream')],
    [
      t('gitPage.sync'),
      <span className="inline-flex flex-wrap gap-3">
        <span className="inline-flex items-center gap-1">
          <ArrowUp aria-hidden="true" className="size-3.5" />
          {t('gitPage.toPush', { count: git.ahead })}
        </span>
        <span className="inline-flex items-center gap-1">
          <ArrowDown aria-hidden="true" className="size-3.5" />
          {t('gitPage.incomingCount', { count: git.behind })}
        </span>
      </span>,
    ],
    [t('gitPage.stashes'), git.stashes],
  ];
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function OperationState({ git }: { git: LibraryGitView }) {
  const { t } = useTranslation();
  const conflicts = git.changes.filter((c) => c.change === 'conflicted');
  if (git.operation === 'none' && !git.busy) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-success">
        <CheckCircle2 aria-hidden="true" className="size-4" />
        {t('gitPage.noOperation')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 text-sm">
      {git.operation !== 'none' && (
        <p className="flex items-center gap-1.5 font-medium text-warning">
          <GitMerge aria-hidden="true" className="size-4" />
          {t(`gitPage.operation.${git.operation}`)}
        </p>
      )}
      {git.busy && (
        <p className="flex items-center gap-1.5 font-medium text-warning">
          <Lock aria-hidden="true" className="size-4" />
          {t('gitPage.busy')}
        </p>
      )}
      {conflicts.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-1.5 font-medium text-danger">
            <AlertCircle aria-hidden="true" className="size-4" />
            {t('gitPage.conflicts', { count: conflicts.length })}
          </p>
          <ul className="flex flex-col gap-0.5 pl-6" aria-label={t('gitPage.conflictList')}>
            {conflicts.map((c) => (
              <li key={c.path}>
                <span className="break-all font-mono text-xs">{c.path}</span>{' '}
                <span className="text-xs text-muted-foreground">
                  ({t(`gitPage.conflict.${c.conflict ?? 'bothModified'}`)})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Changes({ changes }: { changes: readonly GitChangeView[] }) {
  const { t } = useTranslation();
  if (changes.length === 0) return <p className="text-sm text-muted-foreground">{t('gitPage.noChanges')}</p>;
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">{t('gitPage.changes')}</caption>
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th scope="col" className="py-1 pr-3 font-medium">
            {t('gitPage.file')}
          </th>
          <th scope="col" className="py-1 pr-3 font-medium">
            {t('gitPage.change')}
          </th>
          <th scope="col" className="py-1 font-medium">
            {t('gitPage.stagedColumn')}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {changes.map((change) => (
          <tr key={`${change.path}-${change.change}`} className="align-top">
            <th scope="row" className="break-all py-1.5 pr-3 font-mono text-xs font-normal">
              {change.from ? `${change.from} → ${change.path}` : change.path}
            </th>
            <td className="py-1.5 pr-3">{t(`gitPage.changeKind.${change.change}`)}</td>
            <td className="py-1.5">{change.staged ? t('gitPage.staged') : t('gitPage.notStaged')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Commits({ commits, label, empty }: { commits: readonly GitCommitView[]; label: string; empty: string }) {
  if (commits.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ol className="flex flex-col divide-y divide-border text-sm" aria-label={label}>
      {commits.map((commit) => (
        <li key={commit.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
          <span className="font-mono text-xs text-muted-foreground">{shortId(commit.id)}</span>
          <span className="min-w-0 flex-1">
            {commit.merge && <GitMerge aria-hidden="true" className="mr-1 inline size-3.5" />}
            {commit.subject}
          </span>
          <span className="text-xs text-muted-foreground">
            {commit.author} · <CommitTime ms={commit.authorDate} />
          </span>
        </li>
      ))}
    </ol>
  );
}

export function LibraryGitView({ instance, git }: { instance: InstanceView; git: LibraryGitView | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('gitPage.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('gitPage.subtitle', { name: instance.name })}</p>
      </header>
      {!git ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
          {t('gitPage.loading')}
        </p>
      ) : git.state !== 'ready' ? (
        git.error && <ErrorMessage error={git.error} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('gitPage.branchTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Branch git={git} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('gitPage.stateTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <OperationState git={git} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('gitPage.changes')}</CardTitle>
              <CardDescription>{t('gitPage.changesHint')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Changes changes={git.changes} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('gitPage.incoming')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Commits commits={git.incoming} label={t('gitPage.incoming')} empty={t('gitPage.noIncoming')} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('gitPage.history')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Commits commits={git.log} label={t('gitPage.history')} empty={t('gitPage.noCommits')} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export function LibraryGitPage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId/git' });
  const instances = useDeviceQuery('instances');
  const appInfo = useDeviceQuery('appInfo');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const running = instance?.status === 'ready' || instance?.status === 'setting-up';
  const git = useInstanceQuery(running ? instanceId : undefined, 'libraryGit');
  if (!instance || !appInfo.data) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  if (!appInfo.data.features.developerPages) return <p>{t('inspector.unavailable')}</p>;
  return <LibraryGitView instance={instance} git={running ? git.data : undefined} />;
}

/** The link from a library's page, shown in development and test builds only. */
export function GitPageLink({ instanceId }: { instanceId: string }) {
  const { t } = useTranslation();
  return (
    <Link to="/library/$instanceId/git" params={{ instanceId }} className="text-sm underline underline-offset-2">
      {t('gitPage.open')}
    </Link>
  );
}
