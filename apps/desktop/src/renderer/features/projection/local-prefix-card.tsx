// A library's local prefix on this device (PLAN.md §3.3 "Lifecycle", Step 8): shown on the library's page while it has
// one. [Change] previews a new prefix as the user types and changes it; [Use acme again] drops it once the git prefix
// is free on the device. Both are durable operations in the worker; each answer sends the preview's hash back.
import type { LocalPrefixCheckView, LocalPrefixPreviewView, LocalPrefixView } from '@app/ipc';
import { PrefixSchema, type ErrorView } from '@app/schemas';
import { Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, queryInstance } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { LocalPrefixField, localPrefixMessage } from './local-prefix-field.tsx';

export interface LocalPrefixActions {
  preview(prefix: string | null): Promise<LocalPrefixPreviewView>;
  change(prefix: string | null, planHash: string): Promise<void>;
}

export function localPrefixActions(instanceId: string): LocalPrefixActions {
  return {
    preview: (prefix) => queryInstance(instanceId, 'previewLocalPrefix', { prefix }),
    async change(prefix, planHash) {
      await callInstance(instanceId, 'changeLocalPrefix', { prefix, planHash });
    },
  };
}

function asCheck(preview: LocalPrefixPreviewView): LocalPrefixCheckView | null {
  return preview.prefix === null
    ? null
    : { prefix: preview.prefix, problem: preview.problem, tooLong: preview.tooLong, shorter: preview.shorter };
}

function ChangeDialog({
  view,
  actions,
  onOpenChange,
}: {
  view: LocalPrefixView;
  actions: LocalPrefixActions;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [prefix, setPrefix] = useState('');
  const [preview, setPreview] = useState<LocalPrefixPreviewView | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  // The worker's suggestion fills the field once; each valid prefix typed is checked once the typing pauses.
  useEffect(() => {
    void actions.preview(null).then((first) => setPrefix((now) => (now === '' ? (first.suggestion ?? '') : now)));
  }, [actions]);
  useEffect(() => {
    if (!PrefixSchema.safeParse(prefix).success) return;
    const timer = setTimeout(() => void actions.preview(prefix).then(setPreview, () => undefined), 200);
    return () => clearTimeout(timer);
  }, [prefix, actions]);
  const check = preview ? asCheck(preview) : null;
  const ready =
    preview?.prefix === prefix && localPrefixMessage(t, prefix, check) === undefined && prefix !== view.localPrefix;
  return (
    <DialogShell
      open
      onOpenChange={onOpenChange}
      title={t('localPrefix.changeTitle')}
      description={t('localPrefix.changeBody')}
      footer={
        <>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {t('localPrefix.cancel')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={busy || !ready || !preview}
            onClick={() => {
              if (!preview) return;
              setBusy(true);
              setError(null);
              actions
                .change(prefix, preview.hash)
                .then(() => onOpenChange(false))
                .catch((e: unknown) => setError(e as ErrorView))
                .finally(() => setBusy(false));
            }}
          >
            {t('localPrefix.apply')}
          </Button>
        </>
      }
    >
      <LocalPrefixField id="change-local-prefix" value={prefix} check={check} busy={busy} onChange={setPrefix} />
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}

function DropDialog({
  git,
  local,
  offered,
  actions,
  onOpenChange,
}: {
  git: string;
  local: string;
  /** Offered after the library that used the git prefix was removed (S12). */
  offered: boolean;
  actions: LocalPrefixActions;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DialogShell
      open
      onOpenChange={onOpenChange}
      title={t(offered ? 'localPrefix.offerTitle' : 'localPrefix.dropTitle', { git })}
      description={offered ? t('localPrefix.offerBody', { git, local }) : t('localPrefix.dropBody')}
      footer={
        <>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {offered ? t('localPrefix.keep', { local }) : t('localPrefix.cancel')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              actions
                .preview(null)
                .then((preview) => actions.change(null, preview.hash))
                .then(() => onOpenChange(false))
                .catch((e: unknown) => setError(e as ErrorView))
                .finally(() => setBusy(false));
            }}
          >
            {t('localPrefix.dropConfirm', { git })}
          </Button>
        </>
      }
    >
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}

export function LocalPrefixCard({
  view,
  actions,
  offerDrop = false,
  onOfferDone,
}: {
  view: LocalPrefixView;
  actions: LocalPrefixActions;
  /** The library that used the git prefix was just removed: the card opens with the offer to use it again (S12). */
  offerDrop?: boolean;
  onOfferDone?: () => void;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<'change' | 'drop' | null>(null);
  const [answered, setAnswered] = useState(false);
  // The offer opens the drop dialog once the view says the git prefix is free: it may come in again without the clash.
  const offered = offerDrop && view.clash === null && !answered;
  const dialog = chosen ?? (offered ? 'drop' : null);
  const setDialog = setChosen;
  const local = view.localPrefix;
  const git = view.gitPrefix ?? '';
  if (local === null) return null;
  return (
    <Card role="region" aria-label={t('localPrefix.title')}>
      <CardHeader>
        <CardTitle className="flex items-baseline gap-2">
          {t('localPrefix.title')}
          <span className="font-mono text-base">{local}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p>{t('localPrefix.body', { local, git })}</p>
        <p className="flex items-start gap-2 text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {view.clash === null ? t('localPrefix.free', { git }) : t('localPrefix.why', { git })}
        </p>
        {view.skipped.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="font-medium">{t('localPrefix.skipped')}</p>
            <ul className="ml-5 list-disc">
              {view.skipped.map((skip) => (
                <li key={skip.skill}>
                  {t(skip.reason === 'too-long' ? 'localPrefix.skippedTooLong' : 'localPrefix.skippedWrongPrefix', {
                    skill: skip.skill,
                    git,
                  })}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => setDialog('change')}>
            {t('localPrefix.change')}
          </Button>
          {view.clash === null && (
            <Button type="button" size="sm" variant="secondary" onClick={() => setDialog('drop')}>
              {t('localPrefix.drop', { git })}
            </Button>
          )}
        </div>
      </CardContent>
      {dialog === 'change' && (
        <ChangeDialog view={view} actions={actions} onOpenChange={(open) => setDialog(open ? 'change' : null)} />
      )}
      {dialog === 'drop' && (
        <DropDialog
          git={git}
          local={local}
          offered={offered}
          actions={actions}
          onOpenChange={(open) => {
            setDialog(open ? 'drop' : null);
            if (!open && offered) {
              setAnswered(true);
              onOfferDone?.();
            }
          }}
        />
      )}
    </Card>
  );
}
