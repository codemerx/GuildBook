// The wizard while the instance is pending (IMPLEMENTATION.md §2.1): sign-in, the folder, the download and, for a new
// library, the prefix. Each action goes to the setup's own worker through main. Once the download is complete the
// setup continues as its instance, on the finish page.
import type { RpcError, SetupView } from '@app/ipc';
import type { ErrorView, SetupFolderChoice } from '@app/schemas';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, useDeviceQuery } from '../../rpc/queries.ts';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { SignInForm } from './sign-in-form.tsx';
import { LocalPrefixStep } from './local-prefix-step.tsx';
import { DownloadStep, FolderStep, PrefixStep } from './steps.tsx';
import { type WizardStep, WizardFrame } from './wizard-frame.tsx';

const stepOf: Record<SetupView['step'], WizardStep> = {
  signIn: 'signIn',
  folder: 'folder',
  download: 'download',
  prefix: 'prefix',
  localPrefix: 'localPrefix',
  done: 'download',
};

export interface SetupActions {
  readonly signIn: Parameters<typeof SignInForm>[0]['onSignIn'];
  readonly openPage: (url: string) => void;
  readonly chooseFolder: () => void;
  readonly download: () => void;
  readonly create: (prefix: string) => void;
  readonly joinInstead: () => void;
  /** The local-prefix page (Step 8): a prefix checked as the user types, then chosen. */
  readonly checkLocalPrefix: (prefix: string) => void;
  readonly chooseLocalPrefix: (prefix: string) => void;
  /** The prefix check's answers for the user's own folders (Step 15). */
  readonly chooseFolders?: (choices: SetupFolderChoice[]) => void;
  readonly changeUrl: (instanceId: string) => void;
  readonly cancel: () => void;
}

export function SetupWizardView({
  view,
  home,
  busy,
  error,
  actions,
}: {
  view: SetupView;
  home: string | undefined;
  busy: boolean;
  /** A failure of the last action that the view doesn't carry, e.g. a lost connection. */
  error: ErrorView | null;
  actions: SetupActions;
}) {
  const { t } = useTranslation();
  const shown = view.error ?? error;
  return (
    <WizardFrame
      intent={view.intent}
      current={stepOf[view.step]}
      name={view.name}
      host={view.host}
      repo={view.repo}
      localPrefix={view.localPrefix !== null}
      onCancel={actions.cancel}
    >
      {view.step === 'signIn' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('setup.signIn.title', { host: view.host })}</CardTitle>
          </CardHeader>
          <CardContent>
            <SignInForm
              host={view.host}
              hostKind={view.hostKind}
              methods={view.methods}
              clientIdNeeded={view.clientIdNeeded}
              clientId={view.clientId}
              weakStorage={view.weakStorage}
              deviceCode={view.deviceCode}
              askIdentity={
                view.hostKind === 'plain' ||
                view.methods.includes('ssh-agent') ||
                (view.signedIn !== null && view.signedIn.identity === null)
              }
              busy={busy}
              error={shown}
              onSignIn={actions.signIn}
              onOpenPage={actions.openPage}
            />
          </CardContent>
        </Card>
      )}
      {view.step === 'folder' && (
        <FolderStep
          view={{ ...view, error: shown }}
          home={home}
          busy={busy}
          onChoose={actions.chooseFolder}
          onDownload={actions.download}
          onChangeUrl={actions.changeUrl}
        />
      )}
      {view.step === 'download' && <DownloadStep view={view} />}
      {view.step === 'prefix' && (
        <PrefixStep
          view={{ ...view, error: shown }}
          busy={busy}
          onCreate={actions.create}
          onJoinInstead={actions.joinInstead}
        />
      )}
      {view.step === 'localPrefix' && (
        <LocalPrefixStep
          view={{ ...view, error: shown }}
          home={home}
          busy={busy}
          onCheck={actions.checkLocalPrefix}
          onChoose={actions.chooseLocalPrefix}
          {...(actions.chooseFolders ? { onChooseFolders: actions.chooseFolders } : {})}
        />
      )}
    </WizardFrame>
  );
}

export function SetupPage() {
  const { t } = useTranslation();
  const { setupId } = useParams({ from: '/setup/$setupId' });
  const navigate = useNavigate();
  const setups = useDeviceQuery('setups');
  const appInfo = useDeviceQuery('appInfo');
  const [latest, setLatest] = useState<SetupView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const opened = useRef<string | null>(null);
  const view = setups.data?.find((s) => s.id === setupId) ?? latest;

  // The browser opens on the sign-in page once, when the code is shown (PLAN.md §3.17 step 2).
  const code = view?.deviceCode ?? null;
  useEffect(() => {
    if (code && opened.current !== code.userCode) {
      opened.current = code.userCode;
      void callDevice('openExternal', { url: code.verificationUri }).catch(() => undefined);
    }
  }, [code]);

  // The folder page checks the default folder as soon as it's shown.
  const step = view?.step;
  const checked = view?.folder !== null && view?.folder !== undefined;
  useEffect(() => {
    if (step === 'folder' && !checked && view) {
      void callDevice('setupCheckFolder', { setupId, path: view.defaultFolder }).then(setLatest, () => undefined);
    }
  }, [step, checked, setupId, view]);

  if (!view) return setups.isLoading ? null : <p>{t('errors.setup.notFound')}</p>;
  const run = (action: () => Promise<SetupView | void>) => {
    setBusy(true);
    setError(null);
    action()
      .then((next) => {
        if (!next) return;
        setLatest(next);
        if (next.instanceId)
          void navigate({ to: '/library/$instanceId/setup', params: { instanceId: next.instanceId } });
      })
      .catch((e: unknown) => {
        const rpc = e as RpcError;
        setError({ code: rpc.code, params: rpc.params });
      })
      .finally(() => setBusy(false));
  };
  return (
    <SetupWizardView
      view={view}
      home={appInfo.data?.homePath}
      busy={busy}
      error={error}
      actions={{
        signIn: (input) => run(() => callDevice('setupSignIn', { setupId, ...input })),
        openPage: (url) => void callDevice('openExternal', { url }).catch(() => undefined),
        chooseFolder: () =>
          run(async () => {
            const { path } = await callDevice('chooseFolder', { purpose: 'library' });
            return path ? callDevice('setupCheckFolder', { setupId, path }) : undefined;
          }),
        download: () => run(() => callDevice('setupDownload', { setupId })),
        create: (prefix) => run(() => callDevice('setupCreate', { setupId, prefix })),
        joinInstead: () => run(() => callDevice('setupJoinInstead', { setupId })),
        // Checking doesn't make the page busy: the user keeps typing.
        checkLocalPrefix: (prefix) =>
          void callDevice('setupCheckLocalPrefix', { setupId, prefix }).then(setLatest, () => undefined),
        chooseLocalPrefix: (prefix) => run(() => callDevice('setupChooseLocalPrefix', { setupId, prefix })),
        chooseFolders: (choices) => run(() => callDevice('setupChooseFolders', { setupId, choices })),
        changeUrl: (instanceId) =>
          run(async () => {
            await callDevice('changeUrl', { instanceId, url: view.url });
            await callDevice('cancelSetup', { setupId });
            void navigate({ to: '/library/$instanceId', params: { instanceId } });
          }),
        cancel: () =>
          run(async () => {
            await callDevice('cancelSetup', { setupId });
            void navigate({ to: '/' });
          }),
      }}
    />
  );
}
