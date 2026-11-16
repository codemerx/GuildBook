// A prefix change that waits in "Needs attention" (PLAN.md §3.2 step 3, Step 14): another git tool pulled a new git
// prefix that this device already uses, so the links keep their old names until the user chooses a local prefix for
// the library. [Choose a local prefix…] opens the question with a suggestion; the worker checks each prefix typed.
import type { PrefixAdoptView } from '@app/ipc';
import { type ErrorView, PrefixSchema } from '@app/schemas';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, queryInstance } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { LocalPrefixField, localPrefixMessage } from '../projection/local-prefix-field.tsx';

export interface AdoptActions {
  preview(localPrefix: string | null): Promise<PrefixAdoptView>;
  adopt(localPrefix: string, planHash: string): Promise<void>;
}

export function adoptActions(instanceId: string): AdoptActions {
  return {
    preview: (localPrefix) => queryInstance(instanceId, 'previewAdoptPrefix', { localPrefix }),
    async adopt(localPrefix, planHash) {
      await callInstance(instanceId, 'adoptPrefix', { localPrefix, planHash });
    },
  };
}

function AdoptDialog({
  to,
  actions,
  onOpenChange,
}: {
  to: string;
  actions: AdoptActions;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [prefix, setPrefix] = useState('');
  const [preview, setPreview] = useState<PrefixAdoptView | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void actions.preview(null).then(
      (first) => setPrefix((now) => (now === '' ? (first.suggestion ?? '') : now)),
      (e: unknown) => setError(e as ErrorView),
    );
  }, [actions]);
  useEffect(() => {
    if (!PrefixSchema.safeParse(prefix).success) return;
    const timer = setTimeout(() => void actions.preview(prefix).then(setPreview, () => undefined), 200);
    return () => clearTimeout(timer);
  }, [prefix, actions]);
  const check = preview?.answer ?? null;
  const ready = check?.prefix === prefix && localPrefixMessage(t, prefix, check) === undefined;
  return (
    <DialogShell
      open
      onOpenChange={onOpenChange}
      title={t('prefix.adopt.title')}
      description={t('prefix.adopt.body', { to })}
      footer={
        <>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {t('prefix.dialog.cancel')}
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
                .adopt(prefix, preview.hash)
                .then(() => onOpenChange(false))
                .catch((e: unknown) => setError(e as ErrorView))
                .finally(() => setBusy(false));
            }}
          >
            {t('prefix.adopt.apply')}
          </Button>
        </>
      }
    >
      <LocalPrefixField id="adopt-local-prefix" value={prefix} check={check} busy={busy} onChange={setPrefix} />
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}

export function AdoptPrefixAnswer({
  to,
  instanceId,
  actions,
}: {
  to: string;
  instanceId: string;
  /** Stand-ins for stories and tests; the instance's calls otherwise. */
  actions?: AdoptActions | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // One object per instance: the dialog asks again whenever its actions change.
  const calls = useMemo(() => actions ?? adoptActions(instanceId), [actions, instanceId]);
  return (
    <div>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        {t('prefix.adopt.choose')}
      </Button>
      {open && <AdoptDialog to={to} actions={calls} onOpenChange={setOpen} />}
    </div>
  );
}
