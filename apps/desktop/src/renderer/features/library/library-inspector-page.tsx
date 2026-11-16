// The library inspector (IMPLEMENTATION.md Step 2): a developer page, in development and test builds only, that shows
// what the worker reads from a library: library.yaml, the skills with their tags and fingerprints, the instructions,
// and every validation issue with its message. Issues show an icon and a word, never colour alone (PLAN.md §3.19).
import type { InstanceView, IssueView, LibrarySnapshotView } from '@app/ipc';
import { Link, useParams } from '@tanstack/react-router';
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDeviceQuery, useInstanceQuery } from '../../rpc/queries.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { cn } from '../../ui/cn.ts';

function IssueMessage({ issue }: { issue: IssueView }) {
  const { t } = useTranslation();
  const params = {
    ...issue.params,
    ...(typeof issue.params.unit === 'string' ? { unit: t(`issues.units.${issue.params.unit}`) } : {}),
  };
  return <>{t(issue.messageKey, params)}</>;
}

function Severity({ severity }: { severity: IssueView['severity'] }) {
  const { t } = useTranslation();
  const Icon = severity === 'error' ? AlertCircle : AlertTriangle;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-xs font-medium',
        severity === 'error' ? 'text-danger' : 'text-warning',
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {t(`inspector.severity.${severity}`)}
    </span>
  );
}

function Summary({ snapshot }: { snapshot: LibrarySnapshotView }) {
  const { t } = useTranslation();
  const errors = snapshot.issues.filter((i) => i.severity === 'error').length;
  const warnings = snapshot.issues.length - errors;
  const rows: Array<[string, React.ReactNode]> = [
    [t('inspector.prefix'), snapshot.config.prefix ?? t('inspector.none')],
    [
      t('inspector.id'),
      <span className="break-all font-mono text-xs">{snapshot.config.id ?? t('inspector.none')}</span>,
    ],
    [t('inspector.format'), snapshot.config.format ?? t('inspector.none')],
    [t('inspector.compatibility'), t(`inspector.compatibilityState.${snapshot.compatibility}`)],
    [t('inspector.skills'), snapshot.skills.length],
    [t('inspector.issues'), t('inspector.issueCounts', { errors, warnings })],
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

function Issues({ issues }: { issues: readonly IssueView[] }) {
  const { t } = useTranslation();
  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-success">
        <CheckCircle2 aria-hidden="true" className="size-4" />
        {t('inspector.noIssues')}
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border text-sm" aria-label={t('inspector.issues')}>
      {issues.map((issue, index) => (
        <li key={`${issue.path}-${issue.code}-${index}`} className="flex flex-col gap-1 py-2">
          <div className="flex items-baseline gap-3">
            <Severity severity={issue.severity} />
            <span className="break-all font-mono text-xs text-muted-foreground">{issue.path}</span>
          </div>
          <p>
            <IssueMessage issue={issue} />
          </p>
        </li>
      ))}
    </ul>
  );
}

function Skills({ snapshot }: { snapshot: LibrarySnapshotView }) {
  const { t } = useTranslation();
  if (snapshot.skills.length === 0) return <p className="text-sm text-muted-foreground">{t('inspector.noSkills')}</p>;
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">{t('inspector.skills')}</caption>
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th scope="col" className="py-1 pr-3 font-medium">
            {t('inspector.skill')}
          </th>
          <th scope="col" className="py-1 pr-3 font-medium">
            {t('inspector.tags')}
          </th>
          <th scope="col" className="py-1 pr-3 text-right font-medium">
            {t('inspector.files')}
          </th>
          <th scope="col" className="py-1 pr-3 font-medium">
            {t('inspector.issues')}
          </th>
          <th scope="col" className="py-1 font-medium">
            {t('inspector.fingerprint')}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {snapshot.skills.map((skill) => (
          <tr key={skill.folder} className="align-top">
            <th scope="row" className="py-1.5 pr-3 font-mono text-xs font-normal">
              {skill.folder}
            </th>
            <td className="py-1.5 pr-3">
              <span className="flex flex-wrap gap-1">
                {skill.tags.map((tag) => (
                  <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {tag}
                  </span>
                ))}
              </span>
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{skill.files}</td>
            <td className="py-1.5 pr-3 text-xs">
              {skill.errors + skill.warnings === 0
                ? t('inspector.none')
                : t('inspector.issueCounts', { errors: skill.errors, warnings: skill.warnings })}
            </td>
            <td className="py-1.5 font-mono text-xs">{skill.fingerprint?.slice(0, 12) ?? t('inspector.none')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LibraryInspectorView({
  instance,
  snapshot,
}: {
  instance: InstanceView;
  snapshot: LibrarySnapshotView | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('inspector.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('inspector.subtitle', { name: instance.name })}</p>
      </header>
      {!snapshot || snapshot.state === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
          {t('inspector.loading')}
        </p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('inspector.summary')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Summary snapshot={snapshot} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('inspector.issues')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Issues issues={snapshot.issues} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('inspector.skills')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Skills snapshot={snapshot} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('inspector.tagsAndInstructions')}</CardTitle>
              <CardDescription>
                {snapshot.instructions
                  ? t('inspector.instructions', {
                      path: snapshot.instructions.path,
                      bytes: snapshot.instructions.bytes,
                      characters: snapshot.instructions.characters,
                    })
                  : t('inspector.noInstructions')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {snapshot.tags.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('inspector.noTags')}</p>
              ) : (
                <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
                  {snapshot.tags.map(({ tag, skills }) => (
                    <div key={tag} className="contents">
                      <dt className="font-medium">{tag}</dt>
                      <dd className="font-mono text-xs leading-5">{skills.join(', ')}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export function LibraryInspectorPage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId/inspector' });
  const instances = useDeviceQuery('instances');
  const appInfo = useDeviceQuery('appInfo');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const running = instance?.status === 'ready' || instance?.status === 'setting-up';
  const snapshot = useInstanceQuery(running ? instanceId : undefined, 'librarySnapshot');
  if (!instance || !appInfo.data) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  if (!appInfo.data.features.developerPages) return <p>{t('inspector.unavailable')}</p>;
  return <LibraryInspectorView instance={instance} snapshot={running ? snapshot.data : undefined} />;
}

/** The link from a library's page, shown in development and test builds only. */
export function InspectorLink({ instanceId }: { instanceId: string }) {
  const { t } = useTranslation();
  return (
    <Link to="/library/$instanceId/inspector" params={{ instanceId }} className="text-sm underline underline-offset-2">
      {t('inspector.open')}
    </Link>
  );
}
