// The wizard's pages while the instance is pending (PLAN.md §3.17): the folder with its checks, the download's
// progress, and for a new library the prefix. Offers come up where they apply: Change URL for the same library under
// another URL (A4.4), and joining a repo someone else set up first (A4.6).
import type { LocationCheckView, SetupView } from '@app/ipc';
import { PrefixSchema, prefixWarnings } from '@app/schemas';
import { AlertTriangle, CheckCircle2, FolderOpen, Info, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { FieldError, Input, Label } from '../../ui/input.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';

/** Bytes as people read them: 1.2 GB, 340 MB. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function problemParams(params: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) out[key] = String(value);
  if (typeof params.neededBytes === 'number') out.needed = formatBytes(params.neededBytes);
  if (typeof params.freeBytes === 'number') out.free = formatBytes(params.freeBytes);
  return out;
}

export function LocationResult({
  check,
  message,
}: {
  check: LocationCheckView;
  /** Another page's own texts for some codes, e.g. relocation's (Step 9); undefined falls back to the folder page's. */
  message?: (code: string, params: Record<string, string>) => string | undefined;
}) {
  const { t } = useTranslation();
  const text = (code: string, params: Readonly<Record<string, unknown>>) =>
    message?.(code, problemParams(params)) ?? t(`setup.folder.problems.${code}`, problemParams(params));
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      {check.problems.map((problem) => (
        <p key={problem.code} role="alert" className="flex items-start gap-2 text-sm text-danger">
          <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {text(problem.code, problem.params)}
        </p>
      ))}
      {check.warnings.map((warning) => (
        <p
          key={warning.code}
          className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-sm"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          {text(warning.code, warning.params)}
        </p>
      ))}
      {check.problems.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 aria-hidden="true" className="size-4" />
          {t('setup.folder.ok')}
        </p>
      )}
    </div>
  );
}

export function FolderStep({
  view,
  home,
  busy,
  onChoose,
  onDownload,
  onChangeUrl,
}: {
  view: SetupView;
  home: string | undefined;
  busy: boolean;
  onChoose: () => void;
  onDownload: () => void;
  onChangeUrl: (instanceId: string) => void;
}) {
  const { t } = useTranslation();
  const check = view.folder;
  const offer = view.offer?.kind === 'sameLibrary' ? view.offer : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.folder.title')}</CardTitle>
        <CardDescription>{t('setup.folder.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SignedIn view={view} />
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t('setup.folder.folderLabel')}</span>
          <span className="break-all text-sm">
            <PathText path={check?.path ?? view.defaultFolder} home={home} />
          </span>
          <div>
            <Button type="button" variant="secondary" disabled={busy} onClick={onChoose}>
              <FolderOpen aria-hidden="true" />
              {t('setup.folder.choose')}
            </Button>
          </div>
        </div>
        {check ? (
          <LocationResult check={check} />
        ) : (
          <p className="text-sm text-muted-foreground">{t('setup.folder.checking')}</p>
        )}
        {offer && (
          <div role="alert" className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3 text-sm">
            <p className="flex items-center gap-2 font-semibold">
              <Info aria-hidden="true" className="size-4" />
              {t('setup.offers.sameLibraryTitle')}
            </p>
            <p>{t('setup.offers.sameLibrary', { name: offer.name })}</p>
            <div>
              <Button type="button" onClick={() => onChangeUrl(offer.instanceId)}>
                {t('setup.offers.changeUrl', { name: offer.name })}
              </Button>
            </div>
          </div>
        )}
        {view.error && <ErrorMessage error={view.error} />}
        {!offer && (
          <div>
            <Button type="button" disabled={busy || !check || check.problems.length > 0} onClick={onDownload}>
              {t('setup.folder.download')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SignedIn({ view }: { view: SetupView }) {
  const { t } = useTranslation();
  if (!view.signedIn) return null;
  const { login, role } = view.signedIn;
  return (
    <p className="flex items-center gap-2 text-sm">
      <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
      <span>
        {login ? t('setup.signIn.signedIn', { login }) : t('setup.signIn.signedInKey')}
        {role && ` · ${t(`roles.${role}`)}`}
      </span>
    </p>
  );
}

export function DownloadStep({ view }: { view: SetupView }) {
  const { t } = useTranslation();
  const percent = view.download?.percent ?? null;
  const phase = view.download?.phase ?? '';
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.download.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <progress
          aria-label={t('setup.download.progress')}
          className="h-2 w-full"
          max={100}
          {...(percent === null ? {} : { value: percent })}
        />
        <p className="text-sm text-muted-foreground">
          {phase ? t('setup.download.phase', { phase }) : t('setup.download.starting', { host: view.host })}
        </p>
      </CardContent>
    </Card>
  );
}

export function PrefixStep({
  view,
  busy,
  onCreate,
  onJoinInstead,
}: {
  view: SetupView;
  busy: boolean;
  onCreate: (prefix: string) => void;
  onJoinInstead: () => void;
}) {
  const { t } = useTranslation();
  const [prefix, setPrefix] = useState('');
  const parsed = PrefixSchema.safeParse(prefix);
  const problem = prefix !== '' && !parsed.success ? parsed.error.issues[0]?.message : undefined;
  const warning = parsed.success ? prefixWarnings(prefix)[0] : undefined;
  const raced = view.offer?.kind === 'alreadySetUp';
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.prefix.title')}</CardTitle>
        <CardDescription>{t('setup.prefix.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {raced ? (
          <div role="alert" className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3 text-sm">
            <p className="flex items-center gap-2 font-semibold">
              <Info aria-hidden="true" className="size-4" />
              {t('setup.offers.alreadySetUpTitle')}
            </p>
            <p>{t('setup.offers.alreadySetUp')}</p>
            <div>
              <Button type="button" disabled={busy} onClick={onJoinInstead}>
                {t('setup.offers.join')}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (parsed.success) onCreate(prefix);
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prefix">{t('setup.prefix.label')}</Label>
              <Input
                id="prefix"
                value={prefix}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('setup.prefix.placeholder')}
                aria-invalid={problem ? true : undefined}
                aria-describedby="prefix-help prefix-problem"
                onChange={(e) => setPrefix(e.target.value)}
                className="max-w-56"
              />
              <FieldError id="prefix-problem" message={problem && t(problem)} />
              <p id="prefix-help" className="text-sm text-muted-foreground">
                {warning
                  ? t(`issues.${warning}`)
                  : t('setup.prefix.example', { prefix: parsed.success ? prefix : 'acme' })}
              </p>
            </div>
            {view.error && <ErrorMessage error={view.error} />}
            <div>
              <Button type="submit" disabled={busy || !parsed.success}>
                {t('setup.prefix.create')}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
