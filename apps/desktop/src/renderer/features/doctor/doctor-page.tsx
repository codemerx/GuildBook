// The Doctor view (PLAN.md §3.4): what each enabled tool really gets from this library on this computer. The link
// folders and whether SKILL.md can be read through each link, the duplicate risk and nested repos, the instructions and
// the room left, the installed version against the verified one, the tool's own list of skills on request, skills
// whose names may not load, and the places company content doesn't reach. Copy targets (copy mode, Step 16) show their
// copies, the ones edited where they are, and where copies take company content.
import type { DoctorToolView, DoctorView, InstanceView, ToolCommandView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useQueries } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, Cloud, Info, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, useDeviceQuery, useInstanceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { LibraryNav } from '../links/library-nav.tsx';
import { type DiagnosticsActions, ExportDiagnostics } from './diagnostics.tsx';

export interface DoctorActions {
  /** A tool's list command, run by main; the names come back filtered to prefixes in use. */
  list(toolId: string): Promise<ToolCommandView>;
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <span>{children}</span>
    </p>
  );
}

function Ok({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm">
      <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
      <span>{children}</span>
    </p>
  );
}

/** "verified with Kimi Code 1.47; you have 1.52" (PLAN.md §3.4). */
function VersionText({ tool, version }: { tool: DoctorToolView; version: ToolCommandView | undefined }) {
  const { t } = useTranslation();
  if (!tool.versionCommand) return <span>{t('doctor.versionNone')}</span>;
  if (!version) return <span>{t('doctor.versionRunning')}</span>;
  if (version.state === 'not-found') return <span>{t('doctor.versionNotFound')}</span>;
  if (version.state !== 'ok' || version.version === null) return <span>{t('doctor.versionFailed')}</span>;
  if (!tool.verified) return <span>{t('doctor.versionInstalled', { version: version.version })}</span>;
  const same =
    tool.verified.version.split('.').slice(0, 2).join('.') === version.version.split('.').slice(0, 2).join('.');
  return same ? (
    <span>{t('doctor.versionSame', { tool: tool.name, verified: tool.verified.version })}</span>
  ) : (
    <Warn>
      {t('doctor.versionVerified', { tool: tool.name, verified: tool.verified.version, version: version.version })}
    </Warn>
  );
}

function ToolCard({
  tool,
  home,
  version,
  actions,
}: {
  tool: DoctorToolView;
  home: string | undefined;
  version: ToolCommandView | undefined;
  actions: DoctorActions;
}) {
  const { t } = useTranslation();
  const [listed, setListed] = useState<ToolCommandView | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const missing = listed ? tool.linkedSkills.filter((skill) => !listed.skills.includes(skill)) : [];
  return (
    <section aria-label={t('doctor.toolLabel', { tool: tool.name })} className="flex flex-col gap-2 py-3">
      <h3 className="font-semibold">{tool.name}</h3>
      {tool.folders.length === 0 && <Warn>{t('doctor.noFolder', { tool: tool.name })}</Warn>}
      {tool.folders.map((folder) => (
        <div key={folder.path} className="flex flex-col gap-1">
          <span className="flex flex-wrap items-baseline gap-2 text-sm">
            <PathText path={folder.path} home={home} />
            <span className="text-xs text-muted-foreground">
              {t(folder.copy ? 'doctor.copies' : 'doctor.links', { count: folder.links })}
            </span>
          </span>
          {folder.unreadable.length > 0 ? (
            <Warn>
              {t(folder.copy ? 'doctor.unreadableCopy' : 'doctor.unreadable', { skills: folder.unreadable.join(', ') })}
            </Warn>
          ) : (
            folder.links > 0 && <Ok>{t(folder.copy ? 'doctor.readableCopy' : 'doctor.readable')}</Ok>
          )}
          {folder.changed.length > 0 && <Warn>{t('doctor.copyChanged', { skills: folder.changed.join(', ') })}</Warn>}
        </div>
      ))}
      {tool.duplicate && tool.duplicate.handling !== 'one-wins' && (
        <Warn>
          {t(tool.duplicate.handling === 'lists-both' ? 'doctor.duplicateListsBoth' : 'doctor.duplicateUnknown')}
        </Warn>
      )}
      {tool.nested.map((nested) => (
        <Warn key={`${nested.outer}/${nested.inner}`}>
          {t('doctor.nested', { outer: nested.outer, inner: nested.inner })}
        </Warn>
      ))}
      {tool.instructions !== 'off' && (
        <p className="text-sm">{t('doctor.instructions', { state: t(`instructions.state.${tool.instructions}`) })}</p>
      )}
      {tool.room && tool.room.state !== 'ok' && (
        <Warn>
          {tool.room.left >= 0
            ? t('instructions.room', {
                left: tool.room.left.toLocaleString('en'),
                limit: tool.room.limit.toLocaleString('en'),
                unit: t(`instructions.units.${tool.room.unit}`),
              })
            : t('instructions.roomOver', {
                over: (-tool.room.left).toLocaleString('en'),
                limit: tool.room.limit.toLocaleString('en'),
                unit: t(`instructions.units.${tool.room.unit}`),
              })}
        </Warn>
      )}
      <div className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{t('doctor.version')}: </span>
        <VersionText tool={tool} version={version} />
        {!tool.verified && <span> {t('doctor.notVerified')}</span>}
      </div>
      {tool.listCommand && (
        <div className="flex flex-col gap-1">
          <div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-label={t('doctor.listLabel', { tool: tool.name })}
              onClick={() => {
                setError(null);
                actions
                  .list(tool.id)
                  .then(setListed)
                  .catch((e: unknown) => setError(e as ErrorView));
              }}
            >
              <ListChecks aria-hidden="true" />
              {t('doctor.list')}
            </Button>
          </div>
          {error && <ErrorMessage error={error} />}
          {listed && listed.state !== 'ok' && <Warn>{t('doctor.listFailed')}</Warn>}
          {listed && listed.state === 'ok' && (
            <>
              <p className="text-sm">{t('doctor.listResult', { tool: tool.name, count: listed.skills.length })}</p>
              {missing.length > 0 ? (
                <Warn>{t('doctor.listMissing', { skills: missing.join(', ') })}</Warn>
              ) : (
                <Ok>{t('doctor.listAll')}</Ok>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function DoctorPageView({
  instance,
  report,
  versions,
  home,
  actions,
  diagnostics,
}: {
  instance: InstanceView;
  report: DoctorView | undefined;
  versions: ReadonlyMap<string, ToolCommandView>;
  home: string | undefined;
  actions: DoctorActions;
  /** Export diagnostics (Step 16), for a problem the Doctor doesn't explain. */
  diagnostics?: DiagnosticsActions;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">{t('doctor.title', { name: instance.name })}</h1>
        <LibraryNav instanceId={instance.id} attention={instance.attention} />
        <p className="text-sm text-muted-foreground">{t('doctor.intro')}</p>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>{t('doctor.diagnostics')}</span>
          <ExportDiagnostics home={home} {...(diagnostics ? { actions: diagnostics } : {})} />
        </div>
      </header>
      {report && (
        <>
          {report.warnings === 0 ? (
            <Ok>{t('doctor.healthy')}</Ok>
          ) : (
            <Warn>{t('doctor.warnings', { count: report.warnings })}</Warn>
          )}
          <Card>
            <CardHeader>
              <CardTitle>{t('doctor.toolsTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-border">
              {report.tools.length === 0 && <p className="text-sm text-muted-foreground">{t('doctor.noTools')}</p>}
              {report.tools.map((tool) => (
                <ToolCard key={tool.id} tool={tool} home={home} version={versions.get(tool.id)} actions={actions} />
              ))}
            </CardContent>
          </Card>
          {report.invalidNames.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t('doctor.namesTitle')}</CardTitle>
                <CardDescription>
                  {t('doctor.namesBody', {
                    tools: [...new Set(report.invalidNames.flatMap((name) => name.tools))].join(', '),
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1">
                  {report.invalidNames.map((name) => (
                    <li key={name.folder}>
                      <Warn>
                        {t('doctor.nameLine', {
                          folder: name.folder,
                          problems: name.problems.map((problem) => t(`doctor.names.${problem}`)).join('; '),
                        })}
                      </Warn>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Cloud aria-hidden="true" className="size-4" />
                {t('doctor.reachTitle')}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <ul className="flex list-disc flex-col gap-1 pl-5">
                <li>{t('doctor.reachCloud')}</li>
                <li>{t('doctor.reachCowork')}</li>
                <li>{t(report.copyTargets.length > 0 ? 'doctor.reachContainersCopies' : 'doctor.reachContainers')}</li>
                <li>{t('doctor.reachSsh')}</li>
                {report.manual.length > 0 && <li>{t('doctor.reachManual', { tools: report.manual.join(', ') })}</li>}
                {report.skillsOnly.length > 0 && (
                  <li>{t('doctor.reachSkillsOnly', { tools: report.skillsOnly.join(', ') })}</li>
                )}
                {report.uncovered.length > 0 && (
                  <li>{t('doctor.reachUncovered', { tools: report.uncovered.join(', ') })}</li>
                )}
              </ul>
              <p className="flex items-start gap-2 text-muted-foreground">
                <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {t('doctor.reachOptions')}
              </p>
              {report.copyTargets.length > 0 && (
                <div className="flex flex-col gap-1">
                  <p className="font-medium">{t('doctor.copiesTitle')}</p>
                  {report.copyTargets.map((target) => (
                    <Ok key={target.tool}>
                      {t('doctor.copiesReach', { tool: target.tool })}{' '}
                      {target.folders.map((folder) => (
                        <PathText key={folder} path={folder} home={home} />
                      ))}
                    </Ok>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export const doctorActions: DoctorActions = {
  list: (toolId) => callDevice('runToolCommand', { toolId, which: 'list' }),
};

export function DoctorPage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId/doctor' });
  const instances = useDeviceQuery('instances');
  const appInfo = useDeviceQuery('appInfo');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const report = useInstanceQuery(instance?.status === 'ready' ? instanceId : undefined, 'doctor');
  const withVersion = report.data?.tools.filter((tool) => tool.versionCommand) ?? [];
  const versions = useQueries({
    queries: withVersion.map((tool) => ({
      queryKey: ['device', 'runToolCommand', tool.id, 'version'],
      queryFn: () => callDevice('runToolCommand', { toolId: tool.id, which: 'version' }),
    })),
  });
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  const byTool = new Map<string, ToolCommandView>();
  for (const [index, tool] of withVersion.entries()) {
    const data = versions[index]?.data;
    if (data) byTool.set(tool.id, data);
  }
  return (
    <DoctorPageView
      instance={instance}
      report={report.data}
      versions={byTool}
      home={appInfo.data?.homePath}
      actions={doctorActions}
    />
  );
}
