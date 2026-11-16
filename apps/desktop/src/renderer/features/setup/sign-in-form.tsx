// Signing in (PLAN.md §3.17 step 2): the browser and a short code on GitHub and GitLab (the device flow), an access
// token, or an SSH key. On Linux without a keychain, the page warns before anything is kept (A4.13). Used by the
// wizard and by the access-lost state's [Sign in again].
import { brand } from '@app/brand';
import type { ErrorView } from '@app/schemas';
import type { SignInInputView } from '@app/ipc';
import { AlertTriangle, ExternalLink, KeyRound, Loader2, LogIn } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { Input, Label } from '../../ui/input.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';

export type SignInMethodName = 'device' | 'token' | 'ssh-key' | 'ssh-agent';

export interface SignInFormProps {
  /** e.g. `github.com`, for the texts. */
  readonly host: string;
  readonly hostKind: 'github' | 'gitlab' | 'plain' | null;
  readonly methods: readonly SignInMethodName[];
  readonly clientIdNeeded: boolean;
  /** The client id an invite link carried: filled in (PLAN.md §3.17 step 2). */
  readonly clientId?: string | null;
  readonly weakStorage: boolean;
  /** Shown while a device-flow sign-in waits for the approval in the browser. */
  readonly deviceCode: { readonly userCode: string; readonly verificationUri: string } | null;
  /** Ask for the commit author with the sign-in: plain servers and keys don't say who the user is. */
  readonly askIdentity: boolean;
  readonly busy: boolean;
  readonly error: ErrorView | null;
  readonly onSignIn: (input: SignInInputView) => void;
  readonly onOpenPage: (url: string) => void;
}

export function SignInForm(props: SignInFormProps) {
  const { t } = useTranslation();
  const api = props.methods.includes('device');
  const ssh = props.methods.includes('ssh-agent');
  const [useToken, setUseToken] = useState(!api && !ssh);
  const [clientId, setClientId] = useState(props.clientId ?? '');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [acceptWeak, setAcceptWeak] = useState(false);
  const blocked = props.busy || (props.weakStorage && !acceptWeak);
  const identity = props.askIdentity ? { name, email } : undefined;
  const identityMissing = props.askIdentity && (name.trim() === '' || !email.includes('@'));
  const submit = (method: SignInInputView['method']) =>
    props.onSignIn({
      method,
      ...(identity ? { identity } : {}),
      ...(props.weakStorage ? { acceptWeakStorage: acceptWeak } : {}),
    });

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        {t(
          ssh ? 'setup.signIn.descriptionSsh' : api ? 'setup.signIn.descriptionApi' : 'setup.signIn.descriptionPlain',
          {
            host: props.host,
          },
        )}
      </p>

      {props.weakStorage && (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle aria-hidden="true" className="size-4 text-warning" />
            {t('setup.signIn.weakTitle')}
          </p>
          <p>{t('setup.signIn.weakBody')}</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={acceptWeak} onChange={(event) => setAcceptWeak(event.target.checked)} />
            {t('setup.signIn.weakAccept')}
          </label>
        </div>
      )}

      {props.askIdentity && (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-semibold">{t('setup.signIn.identityTitle')}</legend>
          <p className="text-sm text-muted-foreground">{t('setup.signIn.identityHint')}</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="identity-name">{t('setup.signIn.name')}</Label>
            <Input id="identity-name" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="identity-email">{t('setup.signIn.email')}</Label>
            <Input
              id="identity-email"
              type="email"
              value={email}
              autoComplete="email"
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </fieldset>
      )}

      {props.deviceCode ? (
        <div className="flex flex-col gap-3 rounded-md border border-border p-4">
          <p className="text-sm font-semibold">{t('setup.signIn.codeTitle')}</p>
          <output aria-label={t('setup.signIn.codeLabel')} className="font-mono text-3xl font-semibold tracking-widest">
            {props.deviceCode.userCode}
          </output>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
            {t('setup.signIn.waiting')}
          </p>
          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => props.onOpenPage(props.deviceCode?.verificationUri ?? '')}
            >
              <ExternalLink aria-hidden="true" />
              {t('setup.signIn.openAgain')}
            </Button>
          </div>
        </div>
      ) : ssh ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Button type="button" disabled={blocked || identityMissing} onClick={() => submit({ kind: 'ssh-agent' })}>
              <KeyRound aria-hidden="true" />
              {t('setup.signIn.sshAgent')}
            </Button>
            <p className="text-sm text-muted-foreground">{t('setup.signIn.sshAgentHint')}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ssh-key">{t('setup.signIn.sshKey')}</Label>
            <textarea
              id="ssh-key"
              value={privateKey}
              rows={4}
              spellCheck={false}
              className="rounded-md border border-input bg-background p-2 font-mono text-xs"
              aria-describedby="ssh-key-hint"
              onChange={(e) => setPrivateKey(e.target.value)}
            />
            <p id="ssh-key-hint" className="text-sm text-muted-foreground">
              {t('setup.signIn.sshKeyHint')}
            </p>
            <div>
              <Button
                type="button"
                variant="secondary"
                disabled={blocked || identityMissing || privateKey.trim() === ''}
                onClick={() => submit({ kind: 'ssh-key', privateKey })}
              >
                {t('setup.signIn.useKey')}
              </Button>
            </div>
          </div>
        </div>
      ) : useToken ? (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked && token.trim() !== '') submit({ kind: 'token', token, username: username.trim() || null });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="access-token">{t('setup.signIn.token')}</Label>
            <Input
              id="access-token"
              type="password"
              value={token}
              autoComplete="off"
              aria-describedby="access-token-hint"
              onChange={(e) => setToken(e.target.value)}
            />
            <p id="access-token-hint" className="text-sm text-muted-foreground">
              {t('setup.signIn.tokenHint')}
            </p>
          </div>
          {props.hostKind === 'plain' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="token-user">{t('setup.signIn.username')}</Label>
              <Input
                id="token-user"
                value={username}
                autoComplete="off"
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={blocked || identityMissing || token.trim() === ''}>
              {t('setup.signIn.signInWithToken')}
            </Button>
            {api && (
              <Button type="button" variant="ghost" onClick={() => setUseToken(false)}>
                {t('setup.signIn.useBrowser')}
              </Button>
            )}
          </div>
        </form>
      ) : (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked) submit({ kind: 'device', clientId: clientId.trim() || null });
          }}
        >
          {props.clientIdNeeded && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="client-id">{t('setup.signIn.clientId')}</Label>
              <Input
                id="client-id"
                value={clientId}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="client-id-hint"
                onChange={(e) => setClientId(e.target.value)}
              />
              <p id="client-id-hint" className="text-sm text-muted-foreground">
                {t('setup.signIn.clientIdHint')}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <div>
              <Button type="submit" disabled={blocked || (props.clientIdNeeded && clientId.trim() === '')}>
                <LogIn aria-hidden="true" />
                {t('setup.signIn.browser')}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{t('setup.signIn.browserHint')}</p>
          </div>
          <div>
            <Button type="button" variant="ghost" onClick={() => setUseToken(true)}>
              {t('setup.signIn.useToken')}
            </Button>
          </div>
        </form>
      )}
      {props.error && <ErrorMessage error={props.error} />}
      {props.error?.code === 'host.appNotInstalled' && props.hostKind === 'github' && (
        <GitHubAppGuidance
          host={props.host}
          owner={String(props.error.params.owner ?? '')}
          repo={String(props.error.params.name ?? '')}
          onOpenPage={props.onOpenPage}
        />
      )}
    </div>
  );
}

/** Where an owner installs the app: github.com's page, or the same page on GitHub Enterprise Server. */
export function installPage(host: string): string {
  return host === 'github.com'
    ? `https://github.com/apps/${brand.githubAppSlug}/installations/new`
    : `https://${host}/github-apps/${brand.githubAppSlug}/installations/new`;
}

/**
 * The GitHub App isn't installed on the repo (PLAN.md §3.17 step 2, A15.7): what the app is, who installs it, and the
 * installation page. Signing in again checks once more.
 */
export function GitHubAppGuidance({
  host,
  owner,
  repo,
  onOpenPage,
}: {
  host: string;
  owner: string;
  repo: string;
  onOpenPage: (url: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby="github-app-title"
      className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3 text-sm"
    >
      <h3 id="github-app-title" className="font-semibold">
        {t('setup.githubApp.title', { repo })}
      </h3>
      <p>{t('setup.githubApp.body', { owner, repo })}</p>
      <div>
        <Button type="button" variant="secondary" onClick={() => onOpenPage(installPage(host))}>
          <ExternalLink aria-hidden="true" />
          {t('setup.githubApp.open')}
        </Button>
      </div>
    </section>
  );
}
