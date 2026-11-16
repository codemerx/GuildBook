// The access-lost state (IMPLEMENTATION.md Step 4, A4.7): a revoked sign-in, a repo that's gone or out of reach, or a
// renewal that was refused. The library folder stays; the user signs in again, changes the URL, or removes the
// library.
import type { AccessView, InstanceView, RpcError } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, callInstance, queryClient, keys } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { Input, Label } from '../../ui/input.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { SignInForm } from '../setup/sign-in-form.tsx';
import { RemoveDialog } from './remove-dialog.tsx';

export function AccessLostView({
  instance,
  access,
  host,
  mode,
  busy,
  error,
  removeButton,
  onMode,
  onSignIn,
  onOpenPage,
  onChangeUrl,
}: {
  instance: InstanceView;
  access: AccessView;
  host: string;
  mode: 'choose' | 'signIn' | 'changeUrl';
  busy: boolean;
  error: ErrorView | null;
  removeButton: React.ReactNode;
  onMode: (mode: 'choose' | 'signIn' | 'changeUrl') => void;
  onSignIn: Parameters<typeof SignInForm>[0]['onSignIn'];
  onOpenPage: (url: string) => void;
  onChangeUrl: (url: string) => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(instance.gitUrl ?? '');
  const ssh = access.method === 'ssh-agent' || access.method === 'ssh-key';
  const methods: Array<'device' | 'token' | 'ssh-key' | 'ssh-agent'> = ssh
    ? ['ssh-agent', 'ssh-key']
    : access.host === 'plain'
      ? ['token']
      : ['device', 'token'];
  return (
    <Card className="border-danger/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert aria-hidden="true" className="size-5 text-danger" />
          {t('access.lostTitle')}
        </CardTitle>
        <CardDescription>{t(`access.${access.reason ?? 'notFound'}`, { host })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {mode === 'choose' && (
          <>
            <p className="text-sm">{t('access.options')}</p>
            <div className="flex flex-wrap gap-3">
              <Button type="button" onClick={() => onMode('signIn')}>
                {t('access.signInAgainButton')}
              </Button>
              <Button type="button" variant="secondary" onClick={() => onMode('changeUrl')}>
                {t('access.changeUrlButton')}
              </Button>
              {removeButton}
            </div>
          </>
        )}
        {mode === 'signIn' && (
          <SignInForm
            host={host}
            hostKind={access.host}
            methods={methods}
            clientIdNeeded={access.clientIdNeeded}
            weakStorage={false}
            deviceCode={access.deviceCode}
            askIdentity={false}
            busy={busy}
            error={error}
            onSignIn={onSignIn}
            onOpenPage={onOpenPage}
          />
        )}
        {mode === 'changeUrl' && (
          <form
            className="flex flex-col gap-3"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              onChangeUrl(url);
            }}
          >
            <p className="text-sm text-muted-foreground">{t('access.changeUrlHint')}</p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-url">{t('access.newUrl')}</Label>
              <Input id="new-url" value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
            </div>
            {error && <ErrorMessage error={error} />}
            <div className="flex gap-3">
              <Button type="submit" disabled={busy || url.trim() === ''}>
                {t('access.saveUrl')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => onMode('choose')}>
                {t('setup.back')}
              </Button>
            </div>
          </form>
        )}
        {mode === 'signIn' && (
          <div>
            <Button type="button" variant="ghost" onClick={() => onMode('choose')}>
              {t('setup.back')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function AccessLostPanel({
  instance,
  access,
  home,
}: {
  instance: InstanceView;
  access: AccessView;
  home: string | undefined;
}) {
  const [mode, setMode] = useState<'choose' | 'signIn' | 'changeUrl'>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  // The browser opens on the sign-in page once, when the code is shown (PLAN.md §3.17 step 2).
  const opened = useRef<string | null>(null);
  const code = access.deviceCode;
  useEffect(() => {
    if (code && opened.current !== code.userCode) {
      opened.current = code.userCode;
      void callDevice('openExternal', { url: code.verificationUri }).catch(() => undefined);
    }
  }, [code]);
  const host = (() => {
    try {
      return new URL(instance.gitUrl ?? '').host;
    } catch {
      return /@([^:]+):/.exec(instance.gitUrl ?? '')?.[1] ?? '';
    }
  })();
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action()
      .then(() => setMode('choose'))
      .catch((e: unknown) => setError({ code: (e as RpcError).code, params: (e as RpcError).params }))
      .finally(() => setBusy(false));
  };
  return (
    <AccessLostView
      instance={instance}
      access={access}
      host={host}
      mode={mode}
      busy={busy}
      error={error}
      removeButton={<RemoveDialog instance={instance} home={home} trigger="remove" />}
      onMode={(next) => {
        setError(null);
        setMode(next);
      }}
      onSignIn={(input) => run(() => callInstance(instance.id, 'signInAgain', input))}
      onOpenPage={(url) => void callDevice('openExternal', { url }).catch(() => undefined)}
      onChangeUrl={(url) =>
        run(async () => {
          await callDevice('changeUrl', { instanceId: instance.id, url });
          await queryClient.invalidateQueries({ queryKey: keys.instance(instance.id, 'access') });
        })
      }
    />
  );
}
