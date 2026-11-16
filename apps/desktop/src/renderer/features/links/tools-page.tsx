// The tools page (PLAN.md §3.4): which tools are found on this device, which this library links skills into, the
// folder each tool uses (moved by an environment variable, or changed by the user), and custom tools. Enabling or
// disabling tools applies a plan the user confirms; links in a folder another enabled tool still reads stay, and the
// confirmation says so (A5.16). Tool folders and custom tools are kept once per device (A5.18). A copy target (Step 16)
// is a custom tool whose folder gets copies instead of links: WSL, a folder mounted into a container or VM, or a
// sandboxed app (PLAN.md §3.4 copy mode).
import type { InstanceView, LinkPlanView, ToolSettingsView, ToolsView, ToolView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useParams } from '@tanstack/react-router';
import { CheckCircle2, CircleDashed, Copy, FolderOpen, Info, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, callInstance, queryInstance, useDeviceQuery, useInstanceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { Input } from '../../ui/input.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { LibraryNav } from './library-nav.tsx';

/** A custom tool's instructions (Step 7): a file that gets a block, or a folder for an owned file. */
export interface CustomInstructions {
  readonly method: 'marked-block' | 'owned-file';
  readonly path: string;
}

export interface ToolsActions {
  preview(enabled: readonly string[]): Promise<LinkPlanView>;
  apply(enabled: readonly string[], plan: LinkPlanView): Promise<void>;
  changeFolder(tool: ToolView): Promise<void>;
  resetFolder(tool: ToolView): Promise<void>;
  /** A custom tool, or with `copy` a copy target (Step 16): the user picks its folder. */
  addCustom(name: string, instructions: CustomInstructions | null, copy?: boolean): Promise<void>;
  removeCustom(tool: ToolView): Promise<void>;
}

function Detected({ tool }: { tool: ToolView }) {
  const { t } = useTranslation();
  if (tool.custom && tool.copy) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Copy aria-hidden="true" className="size-3.5" />
        {t('tools.copyTarget')}
      </span>
    );
  }
  if (tool.custom) return <span className="text-xs text-muted-foreground">{t('tools.custom')}</span>;
  return tool.found ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
      <CheckCircle2 aria-hidden="true" className="size-3.5" />
      {t('tools.found')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <CircleDashed aria-hidden="true" className="size-3.5" />
      {t('tools.notFound')}
    </span>
  );
}

/** The confirmation, built from the plan (A5.16): what each folder gains and loses, and which links stay. */
function PlanSummary({ plan, home }: { plan: LinkPlanView; home: string | undefined }) {
  const { t } = useTranslation();
  const byFolder = new Map<string, { added: number; removed: number; warnings: number; copies: boolean }>();
  for (const change of plan.changes) {
    const folder = change.folder ?? '';
    const entry = byFolder.get(folder) ?? { added: 0, removed: 0, warnings: 0, copies: false };
    // A copy target's changes are copies (Step 16).
    if (change.method === 'copy') entry.copies = true;
    if (change.op === 'remove') entry.removed++;
    else if (change.op === 'mark') entry.warnings++;
    else entry.added++;
    byFolder.set(folder, entry);
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      {byFolder.size === 0 && <p>{t('tools.confirm.noChanges')}</p>}
      <ul className="flex flex-col gap-2">
        {[...byFolder.entries()].map(([folder, counts]) => (
          <li key={folder} className="flex flex-col gap-0.5">
            <PathText path={folder} home={home} />
            <span className="text-muted-foreground">
              {[
                counts.added > 0
                  ? t(counts.copies ? 'tools.confirm.copiesAdded' : 'tools.confirm.added', { count: counts.added })
                  : null,
                counts.removed > 0
                  ? t(counts.copies ? 'tools.confirm.copiesRemoved' : 'tools.confirm.removed', {
                      count: counts.removed,
                    })
                  : null,
                counts.warnings > 0 ? t('tools.confirm.warnings', { count: counts.warnings }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </li>
        ))}
      </ul>
      {plan.kept.map((kept) => (
        <p
          key={`${kept.tool}-${kept.folder}`}
          className="flex items-start gap-2 rounded-md border border-border bg-muted p-3"
        >
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {t('tools.confirm.kept', { tool: kept.tool, readers: kept.readers.join(', ') })}{' '}
            <PathText path={kept.folder} home={home} />
          </span>
        </p>
      ))}
    </div>
  );
}

export function ToolsPageView({
  instance,
  tools,
  home,
  actions,
}: {
  instance: InstanceView;
  tools: ToolsView | undefined;
  home: string | undefined;
  actions: ToolsActions;
}) {
  const { t } = useTranslation();
  const [wanted, setWanted] = useState<Set<string> | null>(null);
  const [plan, setPlan] = useState<LinkPlanView | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customHow, setCustomHow] = useState<'none' | CustomInstructions['method']>('none');
  const [customPath, setCustomPath] = useState('');
  const [copyName, setCopyName] = useState('');
  const enabledNow = new Set(tools?.tools.filter((tool) => tool.enabled).map((tool) => tool.id) ?? []);
  const selected = wanted ?? enabledNow;
  const changed = tools !== undefined && [...selected].sort().join() !== [...enabledNow].sort().join();
  const names = new Map(tools?.tools.map((tool) => [tool.id, tool.name]) ?? []);
  const run = (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    task()
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(false));
  };
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setWanted(next);
  };
  const found = tools?.tools.filter((tool) => tool.found && !tool.custom) ?? [];
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">{t('tools.title', { name: instance.name })}</h1>
        <LibraryNav instanceId={instance.id} attention={instance.attention} />
        {tools && (
          <p className="text-sm text-muted-foreground">
            {found.length > 0
              ? t('tools.foundOnDevice', { tools: found.map((tool) => tool.name).join(', ') })
              : t('tools.noneFound')}
          </p>
        )}
      </header>
      {error && <ErrorMessage error={error} />}
      {tools && (
        <Card>
          <CardHeader>
            <CardTitle>{t('tools.listTitle')}</CardTitle>
            <CardDescription>{t('tools.listBody')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('tools.columns.tool')}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('tools.columns.found')}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('tools.columns.folder')}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    {t('tools.columns.enabled')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tools.tools
                  .filter((tool) => tool.found || tool.enabled || tool.custom)
                  .map((tool) => (
                    <tr key={tool.id}>
                      <th scope="row" className="py-2 pr-3 font-medium">
                        {tool.name}
                      </th>
                      <td className="py-2 pr-3">
                        <Detected tool={tool} />
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-col gap-1">
                          {(tool.custom ? tool.skillDirs : tool.home ? [tool.home] : []).map((dir) => (
                            <PathText key={dir} path={dir} home={home} />
                          ))}
                          {tool.homeSource === 'env' && tool.homeEnv && (
                            <span className="text-xs text-muted-foreground">
                              {t('tools.movedByEnv', { variable: tool.homeEnv })}
                            </span>
                          )}
                          {tool.homeSource === 'user' && !tool.custom && (
                            <span className="text-xs text-muted-foreground">{t('tools.changedByYou')}</span>
                          )}
                          <span className="flex flex-wrap gap-1">
                            {!tool.custom && (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                aria-label={t('tools.changeFolderLabel', { tool: tool.name })}
                                onClick={() => run(() => actions.changeFolder(tool))}
                              >
                                <FolderOpen aria-hidden="true" />
                                {t('tools.changeFolder')}
                              </Button>
                            )}
                            {tool.homeSource === 'user' && !tool.custom && (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                aria-label={t('tools.resetFolderLabel', { tool: tool.name })}
                                onClick={() => run(() => actions.resetFolder(tool))}
                              >
                                {t('tools.resetFolder')}
                              </Button>
                            )}
                            {tool.custom && (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                aria-label={t('tools.removeCustomLabel', { tool: tool.name })}
                                onClick={() => run(() => actions.removeCustom(tool))}
                              >
                                <Trash2 aria-hidden="true" />
                                {t('tools.removeCustom')}
                              </Button>
                            )}
                          </span>
                        </div>
                      </td>
                      <td className="py-2">
                        <input
                          type="checkbox"
                          aria-label={t('tools.enableLabel', { tool: tool.name })}
                          checked={selected.has(tool.id)}
                          onChange={(event) => toggle(tool.id, event.target.checked)}
                        />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div className="flex gap-3">
              <Button
                type="button"
                disabled={!changed || busy}
                onClick={() => run(async () => setPlan(await actions.preview([...selected])))}
              >
                {t('tools.apply')}
              </Button>
              {changed && (
                <Button type="button" variant="ghost" onClick={() => setWanted(null)}>
                  {t('tools.undo')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      {tools && tools.choice.folders.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('tools.foldersTitle')}</CardTitle>
            <CardDescription>{t('tools.foldersBody')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <ul className="flex flex-col gap-2">
              {tools.choice.folders.map((folder) => (
                <li key={folder.path} className="flex flex-col gap-0.5">
                  <PathText path={folder.path} home={home} />
                  <span className="text-muted-foreground">
                    {t('tools.servesTools', { tools: folder.readers.map((id) => names.get(id) ?? id).join(', ') })}
                  </span>
                  {folder.copy && <span className="text-muted-foreground">{t('tools.copiesHere')}</span>}
                </li>
              ))}
            </ul>
            {tools.choice.duplicates
              .filter((d) => d.enabled && d.handling !== 'one-wins')
              .map((d) => (
                <p
                  key={d.tool}
                  className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3"
                >
                  <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                  {t(d.handling === 'lists-both' ? 'tools.duplicateListsBoth' : 'tools.duplicateUnknown', {
                    tool: names.get(d.tool) ?? d.tool,
                  })}
                </p>
              ))}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('tools.customTitle')}</CardTitle>
          <CardDescription>{t('tools.customBody')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                const how = customHow === 'none' ? null : { method: customHow, path: customPath.trim() };
                await actions.addCustom(customName.trim(), how);
                setCustomName('');
                setCustomHow('none');
                setCustomPath('');
              });
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('tools.customName')}</span>
              <Input value={customName} onChange={(event) => setCustomName(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('tools.customInstructions')}</span>
              <select
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={customHow}
                onChange={(event) => setCustomHow(event.target.value as typeof customHow)}
              >
                <option value="none">{t('tools.customInstructionsNone')}</option>
                <option value="marked-block">{t('tools.customInstructionsBlock')}</option>
                <option value="owned-file">{t('tools.customInstructionsFolder')}</option>
              </select>
            </label>
            {customHow !== 'none' && (
              <label className="flex flex-col gap-1 text-sm">
                <span>{t('tools.customInstructionsPath')}</span>
                <Input value={customPath} onChange={(event) => setCustomPath(event.target.value)} />
              </label>
            )}
            <Button
              type="submit"
              disabled={busy || customName.trim() === '' || (customHow !== 'none' && customPath.trim() === '')}
            >
              <Plus aria-hidden="true" />
              {t('tools.addCustom')}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('tools.copyTitle')}</CardTitle>
          <CardDescription>{t('tools.copyBody')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                await actions.addCustom(copyName.trim(), null, true);
                setCopyName('');
              });
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('tools.copyName')}</span>
              <Input value={copyName} onChange={(event) => setCopyName(event.target.value)} />
            </label>
            <Button type="submit" disabled={busy || copyName.trim() === ''}>
              <Copy aria-hidden="true" />
              {t('tools.addCopy')}
            </Button>
          </form>
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('tools.copyHint')}
          </p>
        </CardContent>
      </Card>
      {plan && (
        <DialogShell
          open
          onOpenChange={(open) => !open && setPlan(null)}
          title={t('tools.confirm.title')}
          description={t('tools.confirm.body')}
          footer={
            <>
              <DialogClose asChild>
                <Button type="button" variant="ghost">
                  {t('links.cancel')}
                </Button>
              </DialogClose>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await actions.apply([...selected], plan);
                    setPlan(null);
                    setWanted(null);
                  })
                }
              >
                {t('tools.confirm.apply')}
              </Button>
            </>
          }
        >
          <PlanSummary plan={plan} home={home} />
        </DialogShell>
      )}
    </div>
  );
}

export function toolsActions(instanceId: string, settings: ToolSettingsView | undefined): ToolsActions {
  return {
    preview: (enabled) => queryInstance(instanceId, 'previewTools', { enabled: [...enabled] }),
    apply: async (enabled, plan) => {
      await callInstance(instanceId, 'setTools', { enabled: [...enabled], planHash: plan.hash });
    },
    changeFolder: async (tool) => {
      const { path } = await callDevice('chooseFolder', { purpose: 'tool-folder' });
      if (path !== null) await callDevice('setToolFolder', { toolId: tool.id, path });
    },
    resetFolder: async (tool) => {
      await callDevice('setToolFolder', { toolId: tool.id, path: null });
    },
    addCustom: async (name, instructions, copy = false) => {
      const { path } = await callDevice('chooseFolder', { purpose: 'tool-folder' });
      if (path !== null) await callDevice('addCustomTool', { name, skillDir: path, instructions, copy });
    },
    removeCustom: async (tool) => {
      if (settings?.customTools.some((custom) => custom.id === tool.id))
        await callDevice('removeCustomTool', { id: tool.id });
    },
  };
}

export function ToolsPage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId/tools' });
  const instances = useDeviceQuery('instances');
  const appInfo = useDeviceQuery('appInfo');
  const settings = useDeviceQuery('toolSettings');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const tools = useInstanceQuery(instance?.status === 'ready' ? instanceId : undefined, 'tools');
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  return (
    <ToolsPageView
      instance={instance}
      tools={tools.data}
      home={appInfo.data?.homePath}
      actions={toolsActions(instanceId, settings.data)}
    />
  );
}
