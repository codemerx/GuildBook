// Checks and preview (PLAN.md §3.14, A10.5): the validation issues of this skill or of the instructions (the Agent Skills
// rules, the prefix, size limits, broken links, letter case, long Windows paths), with an icon and text each, and "What
// the agent sees" per enabled tool: the name and description it loads, and the body it reads, through its link.
import type { AgentToolView, IssueView } from '@app/ipc';
import { AlertTriangle, CheckCircle2, Eye, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { LinkStatus } from '../links/link-status.tsx';

export function IssueList({ issues }: { issues: readonly IssueView[] }) {
  const { t } = useTranslation();
  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm">
        <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
        {t('editor.checks.none')}
      </p>
    );
  }
  return (
    <ul aria-label={t('editor.checks.issues')} className="flex flex-col gap-2">
      {issues.map((issue) => (
        <li
          key={`${issue.path}:${issue.code}:${JSON.stringify(issue.params)}`}
          className="flex items-start gap-2 text-sm"
        >
          {issue.severity === 'error' ? (
            <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          ) : (
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          )}
          <span>
            <span className="font-medium">
              {issue.severity === 'error' ? t('editor.checks.error') : t('editor.checks.warning')}
            </span>{' '}
            {t(issue.messageKey, { ...issue.params })}{' '}
            <span className="font-mono text-xs text-muted-foreground">{issue.path}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SizeLine({ bytes, files }: { bytes: number; files: number }) {
  const { t } = useTranslation();
  return (
    <p className="text-sm text-muted-foreground">
      {t('editor.checks.size', { count: files, size: formatSize(bytes) })}
    </p>
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AgentViewList({
  views,
  home,
}: {
  views: readonly AgentToolView[] | undefined;
  home: string | undefined;
}) {
  const { t } = useTranslation();
  if (!views) return <p className="text-sm text-muted-foreground">{t('editor.agent.loading')}</p>;
  if (views.length === 0) return <p className="text-sm text-muted-foreground">{t('editor.agent.noTools')}</p>;
  const short = (path: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path);
  return (
    <ul className="flex flex-col gap-3">
      {views.map((view) => (
        <li key={view.tool}>
          <section aria-label={view.tool} className="flex flex-col gap-2 rounded-md border border-border p-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Eye aria-hidden="true" className="size-4" />
              {view.tool}
            </h3>
            {view.seen ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {t('editor.agent.through', { path: short(view.seen.dest) })}
                </p>
                <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">{t('editor.agent.name')}</dt>
                  <dd className="font-mono">{view.seen.name ?? t('editor.agent.missing')}</dd>
                  <dt className="text-muted-foreground">{t('editor.agent.description')}</dt>
                  <dd>{view.seen.description ?? t('editor.agent.missing')}</dd>
                  <dt className="text-muted-foreground">{t('editor.agent.size')}</dt>
                  <dd>{formatSize(view.seen.size)}</dd>
                </dl>
                <details>
                  <summary className="cursor-pointer text-sm">{t('editor.agent.body')}</summary>
                  <pre
                    data-testid="agent-body"
                    className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs"
                  >
                    {view.seen.body}
                  </pre>
                </details>
              </>
            ) : (
              <p className="flex items-start gap-2 text-sm">
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                <span className="flex flex-col gap-1">
                  {view.places.length === 0
                    ? t('editor.agent.notPlaced', { tool: view.tool })
                    : t('editor.agent.notLinked', { tool: view.tool })}
                  {view.places.map((place) => (
                    <span key={place.dest} className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono">{short(place.dest)}</span>
                      <LinkStatus status={place.status} />
                    </span>
                  ))}
                </span>
              </p>
            )}
          </section>
        </li>
      ))}
    </ul>
  );
}

export function ChecksPanel({
  issues,
  bytes,
  files,
  agents,
  home,
}: {
  issues: readonly IssueView[];
  bytes: number;
  files: number;
  agents: readonly AgentToolView[] | undefined;
  home: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('editor.checks.title')}</CardTitle>
          <CardDescription>{t('editor.checks.body')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <SizeLine bytes={bytes} files={files} />
          <IssueList issues={issues} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('editor.agent.title')}</CardTitle>
          <CardDescription>{t('editor.agent.intro')}</CardDescription>
        </CardHeader>
        <CardContent>
          <AgentViewList views={agents} home={home} />
        </CardContent>
      </Card>
    </div>
  );
}
