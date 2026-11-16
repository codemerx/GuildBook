// The wizard's first page (PLAN.md §3.17 step 1, §3.15): the git URL, checked as it's typed. The host and the repo path
// are shown before anything is cloned (A4.12), and another form of a URL already connected says so (A4.4).
import type { RpcError, UrlCheckView } from '@app/ipc';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, useDeviceQueryWith } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader } from '../../ui/card.tsx';
import { FieldError, Input, Label } from '../../ui/input.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { WizardFrame } from './wizard-frame.tsx';

export function ConnectView({
  intent,
  url,
  check,
  busy,
  error,
  invite = 'none',
  onUrl,
  onContinue,
  onCancel,
}: {
  intent: 'join' | 'create';
  url: string;
  /** Where the URL came from: an invite link (Step 15), or a refused one. */
  invite?: 'none' | 'link' | 'invalid';
  check: UrlCheckView | undefined;
  busy: boolean;
  error: RpcError | null;
  onUrl: (url: string) => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const problem = check && !check.ok && url.trim() !== '' ? check : null;
  return (
    <WizardFrame
      intent={intent}
      current="url"
      name={check?.ok ? check.name : null}
      host={check?.ok ? check.host : null}
      repo={check?.ok ? check.repo : null}
    >
      <Card>
        <CardHeader>
          <CardDescription>
            {invite === 'link'
              ? t('setup.invite.fromLink')
              : t(intent === 'join' ? 'setup.joinDescription' : 'setup.createDescription')}
          </CardDescription>
          {invite === 'invalid' && (
            <p role="alert" className="text-sm text-danger">
              {t('setup.invite.invalid')}
            </p>
          )}
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (check?.ok) onContinue();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="git-url">{t('setup.urlLabel')}</Label>
              <Input
                id="git-url"
                value={url}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('setup.urlPlaceholder')}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? 'git-url-problem' : undefined}
                onChange={(event) => onUrl(event.target.value)}
              />
              <FieldError
                id="git-url-problem"
                message={problem ? t(`setup.url.${problem.problem}`, { name: problem.name ?? '' }) : undefined}
              />
              {problem?.instanceId && (
                <Link
                  to="/library/$instanceId"
                  params={{ instanceId: problem.instanceId }}
                  className="text-sm underline"
                >
                  {t('setup.openLibrary', { name: problem.name ?? '' })}
                </Link>
              )}
            </div>
            {error && <ErrorMessage error={{ code: error.code, params: error.params }} />}
            <div className="flex gap-3">
              <Button type="submit" disabled={!check?.ok || busy}>
                {t('setup.continue')}
              </Button>
              <Button type="button" variant="ghost" onClick={onCancel}>
                {t('setup.cancel')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </WizardFrame>
  );
}

/** The URL being typed, checked after a short pause. */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function ConnectPage() {
  const search = useSearch({ from: '/connect' });
  const { intent } = search;
  const navigate = useNavigate();
  const [url, setUrl] = useState(search.url ?? '');
  // The URL page showed the invite: main forgets it, and a new link replaces this page's URL.
  const seq = search.invite;
  const [shown, setShown] = useState(seq);
  if (shown !== seq) {
    setShown(seq);
    setUrl(search.url ?? '');
  }
  useEffect(() => {
    if (seq !== undefined) void callDevice('takeInvite', { seq }).catch(() => undefined);
  }, [seq]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RpcError | null>(null);
  const settled = useDebounced(url, 150);
  const check = useDeviceQueryWith('checkUrl', { url: settled }, settled.trim() !== '');
  return (
    <ConnectView
      intent={intent}
      url={url}
      check={settled === url ? check.data : undefined}
      busy={busy}
      error={error}
      invite={search.invalid ? 'invalid' : search.url !== undefined && url === search.url ? 'link' : 'none'}
      onUrl={(next) => {
        setUrl(next);
        setError(null);
      }}
      onCancel={() => void navigate({ to: '/' })}
      onContinue={() => {
        setBusy(true);
        callDevice('startSetup', {
          url,
          intent,
          clientId: search.url !== undefined && url === search.url ? (search.clientId ?? null) : null,
        })
          .then(({ setupId }) => navigate({ to: '/setup/$setupId', params: { setupId } }))
          .catch((e: unknown) => setError(e as RpcError))
          .finally(() => setBusy(false));
      }}
    />
  );
}
