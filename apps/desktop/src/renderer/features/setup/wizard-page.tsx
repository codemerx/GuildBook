// The wizard after the download, while the instance is setting up (IMPLEMENTATION.md §2.1, PLAN.md §3.17): the
// worker keeps where the wizard is and every answer, so a restart reopens it there. Nothing outside the library folder
// changes before [Finish]. A library newer than this app stops here with PLAN.md's update message; the download is
// kept (A4.5).
import type { InstanceView, RpcError, SetupWizardView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useNavigate, useParams } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  callDevice,
  callInstance,
  keys,
  queryClient,
  queryInstance,
  useDeviceQuery,
  useInstanceQuery,
} from '../../rpc/queries.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { RemoveDialog } from '../library/remove-dialog.tsx';
import { pickFolder } from '../shell/folder-access.tsx';
import { WizardFrame } from './wizard-frame.tsx';
import {
  ImportStep,
  InstructionsStep,
  NamesStep,
  PublishStep,
  ReposStep,
  SummaryStep,
  TagsStep,
  ToolsStep,
  type WizardActions,
} from './wizard-pages.tsx';

function hostOf(url: string): { host: string; repo: string } | null {
  const ssh = /^(?:[^@/]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/.exec(url);
  try {
    const parsed = new URL(url);
    return { host: parsed.host, repo: parsed.pathname.replace(/^\/|\.git\/?$|\/$/g, '') };
  } catch {
    return ssh ? { host: ssh[1] ?? '', repo: ssh[2] ?? '' } : null;
  }
}

/** The library is newer than this app: the setup waits for an update (PLAN.md §3.17 step 4). */
function NeedsUpdateStep({
  instance,
  view,
  home,
}: {
  instance: InstanceView;
  view: SetupWizardView;
  home: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.finish.updateTitle')}</CardTitle>
        <CardDescription>
          {t(view.needsUpdate === 'formatTooNew' ? 'setup.finish.updateFormat' : 'setup.finish.updateApp')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('setup.finish.folder')}</dt>
          <dd>
            <PathText path={instance.libraryPath} home={home} />
          </dd>
        </dl>
        <p role="alert" className="flex items-center gap-2 text-sm">
          <AlertTriangle aria-hidden="true" className="size-4 text-warning" />
          {t('errors.setup.needsUpdate')}
        </p>
      </CardContent>
    </Card>
  );
}

export function SetupWizardScreen({
  instance,
  view,
  summary,
  home,
  platform,
  busy,
  error,
  outcome,
  copied,
  actions,
  cancel,
}: {
  instance: InstanceView;
  view: SetupWizardView;
  summary: Parameters<typeof SummaryStep>[0]['summary'];
  home: string | undefined;
  platform: string | undefined;
  busy: boolean;
  error: ErrorView | null;
  outcome: 'checks' | 'rejected' | null;
  copied: boolean;
  actions: WizardActions;
  /** The cancel button: removing the instance asks about the library folder (PLAN.md §3.8 S12). */
  cancel: React.ReactNode;
}) {
  const host = instance.gitUrl ? hostOf(instance.gitUrl) : null;
  const props = { view, home, busy, error, actions };
  const tags = [...new Set(view.library.skills.flatMap((skill) => skill.tags))].sort();
  return (
    <WizardFrame
      intent={view.intent}
      current={view.page === 'needsUpdate' ? 'download' : view.page}
      name={view.libraryName}
      host={host?.host ?? null}
      repo={host?.repo ?? null}
      localPrefix={(instance.localPrefix ?? null) !== null}
    >
      {view.page === 'needsUpdate' && <NeedsUpdateStep instance={instance} view={view} home={home} />}
      {view.page === 'import' && <ImportStep {...props} />}
      {view.page === 'instructions' && <InstructionsStep {...props} />}
      {view.page === 'tags' && <TagsStep {...props} />}
      {view.page === 'publish' && <PublishStep {...props} host={host?.host ?? ''} outcome={outcome} copied={copied} />}
      {view.page === 'tools' && <ToolsStep {...props} />}
      {view.page === 'repos' && <ReposStep {...props} platform={platform} tags={tags} />}
      {view.page === 'names' && <NamesStep {...props} />}
      {view.page === 'summary' && <SummaryStep {...props} summary={summary} />}
      <div>{cancel}</div>
    </WizardFrame>
  );
}

export function SetupWizardPage() {
  const { instanceId } = useParams({ from: '/library/$instanceId/setup' });
  const navigate = useNavigate();
  const instances = useDeviceQuery('instances');
  const appInfo = useDeviceQuery('appInfo');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const running = instance?.status === 'setting-up' ? instanceId : undefined;
  const wizard = useInstanceQuery(running, 'setupWizard');
  const onSummary = wizard.data?.page === 'summary';
  const summary = useInstanceQuery(onSummary ? running : undefined, 'setupSummary');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [outcome, setOutcome] = useState<'checks' | 'rejected' | null>(null);
  const [copied, setCopied] = useState(false);
  if (!instance || !wizard.data) return null;
  const run = (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    task()
      .catch((e: unknown) => {
        const rpc = e as RpcError;
        setError({ code: rpc.code, params: rpc.params });
      })
      .finally(() => setBusy(false));
  };
  const library = (to: '/library/$instanceId/edit/import' | '/library/$instanceId/edit/instructions') =>
    void navigate({ to, params: { instanceId } });
  const actions: WizardActions = {
    go: (page) => run(() => callInstance(instanceId, 'setupGo', { page })),
    openImport: () => library('/library/$instanceId/edit/import'),
    openInstructions: () => library('/library/$instanceId/edit/instructions'),
    openChanges: () => void navigate({ to: '/library/$instanceId/changes', params: { instanceId } }),
    setSkillTags: (skill, tags) => run(() => callInstance(instanceId, 'setupSetSkillTags', { skill, tags })),
    setLibraryTags: (suggest, repoOnlyTags) =>
      run(() => callInstance(instanceId, 'setupSetLibraryTags', { suggest, repoOnlyTags })),
    publish: () =>
      run(async () => {
        setOutcome(null);
        const changes = await queryInstance(instanceId, 'changes', {}).catch(() => null);
        const paths = changes?.groups.flatMap((group) => group.paths) ?? [];
        if (paths.length > 0) {
          const result = await callInstance(instanceId, 'commit', {
            paths,
            message: 'Add the first version',
            confirm: {},
            push: true,
          });
          if (result.kind === 'checks') setOutcome('checks');
          else if (result.push?.kind === 'rejected' || result.push?.kind === 'secrets') setOutcome('rejected');
          return;
        }
        const pushed = await callInstance(instanceId, 'push', { confirmSecrets: false });
        if (pushed.kind === 'rejected' || pushed.kind === 'secrets') setOutcome('rejected');
      }),
    copyInvite: (link) =>
      run(async () => {
        await callDevice('copyText', { text: link });
        setCopied(true);
      }),
    chooseTools: (enabled) => run(() => callInstance(instanceId, 'setupChooseTools', { enabled })),
    addCustomTool: (name) =>
      run(async () => {
        const { path } = await callDevice('chooseFolder', { purpose: 'tool-folder' });
        if (path === null) return;
        const { id } = await callDevice('addCustomTool', { name, skillDir: path, instructions: null });
        const chosen = wizard.data?.tools.filter((tool) => tool.chosen).map((tool) => tool.id) ?? [];
        await callInstance(instanceId, 'setupChooseTools', { enabled: [...chosen, id] });
      }),
    // While the instance is setting up, no link check announces the repos: the page asks again itself.
    addRepo: () =>
      run(async () => {
        const path = await pickFolder('repo');
        if (path !== null) await callInstance(instanceId, 'addRepo', { path });
        await queryClient.invalidateQueries({ queryKey: keys.instance(instanceId, 'setupWizard') });
      }),
    addRoot: () =>
      run(async () => {
        const path = await pickFolder('repo-root');
        if (path !== null) await callInstance(instanceId, 'addRepoRoot', { path });
        await queryClient.invalidateQueries({ queryKey: keys.instance(instanceId, 'setupWizard') });
      }),
    tickTag: (repo, tag, on) => run(() => callInstance(instanceId, 'setupTickTag', { repo, tag, on })),
    answerName: (dest, choice) => run(() => callInstance(instanceId, 'setupAnswerName', { dest, choice })),
    finish: (planHash) =>
      run(async () => {
        await callDevice('finishSetup', { instanceId, planHash });
        void navigate({ to: '/library/$instanceId', params: { instanceId } });
      }),
  };
  return (
    <SetupWizardScreen
      instance={instance}
      view={wizard.data}
      summary={summary.data}
      home={appInfo.data?.homePath}
      platform={appInfo.data?.platform}
      busy={busy}
      error={error}
      outcome={outcome}
      copied={copied}
      actions={actions}
      cancel={<RemoveDialog instance={instance} home={appInfo.data?.homePath} trigger="cancel" />}
    />
  );
}
