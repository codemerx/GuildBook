// The change request's dialog (PLAN.md §3.11 "Change requests"): the new branch's name, for [Commit to a new branch] and
// [Move my commits to a new branch]. And the signing key (PLAN.md §3.10 "Signing"): choose one of the user's keys or
// create one, then register it on the host.
import type { SigningView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { BadgeCheck, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { DialogShell } from '../../ui/dialog.tsx';
import { Input } from '../../ui/input.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';

const textarea =
  'min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm font-normal focus-visible:outline-2 focus-visible:outline-ring';

/** A branch name: the suggestion (`requests/john/acme-code-review`), which the user may change. */
export function BranchDialog({
  open,
  title,
  description,
  suggestion,
  confirm,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  suggestion: string;
  confirm: string;
  onCancel: () => void;
  onConfirm: (branch: string) => void;
}) {
  const { t } = useTranslation();
  const [branch, setBranch] = useState<string | null>(null);
  const shown = branch ?? suggestion;
  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setBranch(null);
          onCancel();
        }
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('sync.cancel')}
          </Button>
          <Button
            type="button"
            disabled={shown.trim() === ''}
            onClick={() => {
              setBranch(null);
              onConfirm(shown.trim());
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1 text-sm">
        {t('review.branchDialog.name')}
        <Input className="font-mono" value={shown} spellCheck={false} onChange={(e) => setBranch(e.target.value)} />
      </label>
    </DialogShell>
  );
}

export interface SigningActions {
  /** One of the user's own keys: the file dialog for its public key file. */
  readonly choose: () => Promise<void>;
  readonly create: () => Promise<void>;
  readonly register: () => Promise<void>;
}

/**
 * The signing key (PLAN.md §3.10 "Signing"), asked once: one of the user's own keys, or a new one the app keeps. Then
 * the key goes to the host as a signing key: through the API on GitHub and GitLab, by hand elsewhere.
 */
export function SigningDialog({
  open,
  view,
  library,
  host,
  actions,
  onClose,
  onDone,
}: {
  open: boolean;
  view: SigningView | undefined;
  library: string;
  /** The host's name, e.g. GitHub. */
  host: string;
  actions: SigningActions;
  onClose: () => void;
  /** The key is chosen (and registered where the host takes it): the action that needed it goes on. */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(false));
  };
  const key = view?.key ?? null;
  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={key ? t('review.signing.registerTitle', { host }) : t('review.signing.title')}
      description={
        key
          ? view?.canRegister
            ? t('review.signing.registerBody', { host })
            : t('review.signing.manual')
          : t('review.signing.body', { library })
      }
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('sync.cancel')}
          </Button>
          {key && (view?.registered === true || !view?.canRegister) && (
            <Button type="button" disabled={busy} onClick={onDone}>
              {t('review.signing.done')}
            </Button>
          )}
        </>
      }
    >
      {error && <ErrorMessage error={error} />}
      {!key && view && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => run(actions.choose)}>
                <KeyRound aria-hidden="true" />
                {t('review.signing.chooseFile')}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{t('review.signing.chooseFileHelp')}</p>
          </div>
          <div className="flex flex-col gap-1">
            <div>
              <Button type="button" disabled={busy} onClick={() => run(actions.create)}>
                {t('review.signing.create')}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{t('review.signing.createHelp')}</p>
          </div>
        </div>
      )}
      {key && (
        <div className="flex flex-col gap-3 text-sm">
          <p>{t('review.signing.current', { key: key.label })}</p>
          <label className="flex flex-col gap-1">
            {t('review.signing.publicKey')}
            <textarea readOnly className={`${textarea} font-mono text-xs`} value={key.publicKey} />
          </label>
          {view?.canRegister && view.registered !== true && (
            <div>
              <Button type="button" disabled={busy} onClick={() => run(actions.register)}>
                {t('review.signing.register')}
              </Button>
            </div>
          )}
          {view?.registered === true && (
            <p className="flex items-center gap-2" role="status">
              <BadgeCheck aria-hidden="true" className="size-4 text-success" />
              {t('review.signing.registered', { host })}
            </p>
          )}
        </div>
      )}
    </DialogShell>
  );
}
