// The library's prefix (PLAN.md §3.2 "Locking", Step 14): the card on the library's page, its lock taken from the
// remote, and the dialog of the correction (before the lock) or the Admin's change (after it). The dialog is the
// warning of §3.2 step 1: the count of renamed skills with an example of the new commands, the mentions of skill
// names in the texts (never rewritten), the open change requests' branches, what blocks the change, and the local-prefix question when
// the new prefix clashes on this device. The change is one commit, pushed at once.
import type { PrefixChangePreviewView, PrefixStateView, PushResultView } from '@app/ipc';
import { type ErrorView, PrefixSchema } from '@app/schemas';
import { AlertTriangle, Info, Lock, LockOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, queryInstance } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { FieldError, Input, Label } from '../../ui/input.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { LocalPrefixField } from '../projection/local-prefix-field.tsx';
import { PushResultDialog } from '../sync/push-dialogs.tsx';

export interface PrefixActions {
  preview(prefix: string, localPrefix: string | null): Promise<PrefixChangePreviewView>;
  change(prefix: string, localPrefix: string | null, planHash: string): Promise<{ push: PushResultView }>;
}

export function prefixActions(instanceId: string): PrefixActions {
  return {
    preview: (prefix, localPrefix) => queryInstance(instanceId, 'previewPrefixChange', { prefix, localPrefix }),
    change: (prefix, localPrefix, planHash) =>
      callInstance(instanceId, 'changePrefix', { prefix, localPrefix, planHash }),
  };
}

/** The warning's parts that need a decision or a fix: each blocks the change until it's answered. */
function blocked(preview: PrefixChangePreviewView, localPrefix: string): boolean {
  if (preview.refusal || preview.problem || preview.blockers.length > 0 || preview.renameProblems.length > 0) {
    return true;
  }
  const device = preview.device;
  if (device && device.clash !== null && device.localPrefix === null) {
    return device.answer?.prefix !== localPrefix || device.answer.problem !== null;
  }
  return false;
}

/** The warning of a prefix change: what it does, and what the Admin should know first (PLAN.md §3.2 step 1). */
export function PrefixWarning({ preview }: { preview: PrefixChangePreviewView }) {
  const { t } = useTranslation();
  const [first] = preview.renames;
  return (
    <div className="flex flex-col gap-3 text-sm">
      {preview.action === 'change' && first && (
        <p role="note" className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            {t('prefix.dialog.count', {
              count: preview.renames.length,
              from: preview.from,
              to: preview.prefix,
              example: first.from,
              renamed: first.to,
            })}
          </span>
        </p>
      )}
      {preview.untouched.length > 0 && (
        <div className="flex flex-col gap-1">
          <p>{t('prefix.dialog.untouched', { from: preview.from })}</p>
          <ul className="ml-5 list-disc font-mono text-xs">
            {preview.untouched.map((skill) => (
              <li key={skill}>{skill}</li>
            ))}
          </ul>
        </div>
      )}
      {preview.renameProblems.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 text-danger">
          {preview.renameProblems.map((problem) => (
            <li key={problem.skill}>{t(`prefix.dialog.renameProblem.${problem.code}`, problem)}</li>
          ))}
        </ul>
      )}
      {preview.mentions.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t('prefix.dialog.mentions', { count: preview.mentions.length })}</p>
          <ul aria-label={t('prefix.dialog.mentionsLabel')} className="flex flex-col gap-1 text-xs">
            {preview.mentions.map((mention) => (
              <li key={`${mention.path}:${mention.line}:${mention.name}`} className="flex flex-col">
                <span className="font-mono">{t('prefix.dialog.mentionAt', mention)}</span>
                <span className="text-muted-foreground">{mention.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.requests.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t('prefix.dialog.requests', { count: preview.requests.length })}</p>
          <ul aria-label={t('prefix.dialog.requestsLabel')} className="ml-5 list-disc">
            {preview.requests.map((request) => (
              <li key={request.branch}>{t('prefix.dialog.request', request)}</li>
            ))}
          </ul>
        </div>
      )}
      {preview.blockers.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1">
          {preview.blockers.map((blocker) => (
            <li key={blocker} className="flex items-start gap-2">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {t(`prefix.dialog.blockers.${blocker}`)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChangeDialog({
  state,
  actions,
  library,
  onOpenChange,
}: {
  state: PrefixStateView;
  actions: PrefixActions;
  library: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [prefix, setPrefix] = useState('');
  const [localPrefix, setLocalPrefix] = useState('');
  const [preview, setPreview] = useState<PrefixChangePreviewView | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const [push, setPush] = useState<PushResultView | null>(null);
  const parsed = PrefixSchema.safeParse(prefix);
  const message =
    prefix !== '' && !parsed.success ? t(parsed.error.issues[0]?.message ?? 'issues.prefix.tooShort') : undefined;
  // The worker's warning for each valid prefix, once the typing pauses; the local prefix's question comes with it.
  useEffect(() => {
    if (!PrefixSchema.safeParse(prefix).success) return;
    const typed = localPrefix === '' ? null : localPrefix;
    const timer = setTimeout(
      () =>
        void actions.preview(prefix, typed).then(
          (next) => {
            setPreview(next);
            // The suggestion fills the local prefix's field once.
            if (typed === null && next.device?.clash && next.device.localPrefix === null && next.device.suggestion) {
              setLocalPrefix(next.device.suggestion);
            }
          },
          (e: unknown) => setError(e as ErrorView),
        ),
      200,
    );
    return () => clearTimeout(timer);
  }, [prefix, localPrefix, actions]);
  const current = preview?.prefix === prefix ? preview : null;
  const clash = current?.device?.clash && current.device.localPrefix === null ? current.device : null;
  const ready = current !== null && !blocked(current, localPrefix);
  const correct = state.action === 'correct';
  if (push && push.kind !== 'pushed' && push.kind !== 'upToDate') {
    return (
      <PushResultDialog
        result={push}
        library={library}
        onClose={() => onOpenChange(false)}
        onConfirmSecrets={() => {}}
      />
    );
  }
  return (
    <DialogShell
      open
      onOpenChange={onOpenChange}
      title={t(correct ? 'prefix.dialog.correctTitle' : 'prefix.dialog.changeTitle')}
      description={t(correct ? 'prefix.dialog.correctBody' : 'prefix.dialog.changeBody', {
        prefix: state.prefix ?? '',
      })}
      footer={
        <>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {t('prefix.dialog.cancel')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={busy || !ready}
            onClick={() => {
              if (!current) return;
              setBusy(true);
              setError(null);
              actions
                .change(prefix, clash ? localPrefix : null, current.hash)
                .then((result) => {
                  if (result.push.kind === 'pushed' || result.push.kind === 'upToDate') onOpenChange(false);
                  else setPush(result.push);
                })
                .catch((e: unknown) => setError(e as ErrorView))
                .finally(() => setBusy(false));
            }}
          >
            {t(correct ? 'prefix.dialog.applyCorrect' : 'prefix.dialog.applyChange')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-prefix">{t('prefix.dialog.label')}</Label>
        <Input
          id="new-prefix"
          value={prefix}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={message ? true : undefined}
          aria-describedby="new-prefix-help new-prefix-problem"
          onChange={(event) => setPrefix(event.target.value)}
          className="max-w-56 font-mono"
        />
        <FieldError
          id="new-prefix-problem"
          message={message ?? (current?.problem?.code === 'same' ? t('prefix.dialog.same', { prefix }) : undefined)}
        />
        <p id="new-prefix-help" className="text-sm text-muted-foreground">
          {/* A generic prefix is the one warning (PLAN.md §3.2). */}
          {current && current.warnings.length > 0
            ? t('issues.prefix.generic')
            : t('prefix.dialog.help', { example: `${prefix === '' ? '…' : prefix}-…` })}
        </p>
      </div>
      {current && <PrefixWarning preview={current} />}
      {clash && (
        <div className="flex flex-col gap-2 text-sm">
          <p role="note" className="flex items-start gap-2">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            {clash.clash?.kind === 'instance'
              ? t('prefix.clash.instance', { prefix, name: clash.clash.name })
              : t('prefix.clash.folders', { prefix })}
          </p>
          <LocalPrefixField
            id="prefix-change-local"
            value={localPrefix}
            check={clash.answer}
            busy={busy}
            onChange={setLocalPrefix}
          />
        </div>
      )}
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}

export function PrefixCard({
  state,
  actions,
  library,
}: {
  state: PrefixStateView;
  actions: PrefixActions;
  library: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (state.prefix === null) return null;
  return (
    <Card role="region" aria-label={t('prefix.title')}>
      <CardHeader>
        <CardTitle className="flex items-baseline gap-2">
          {t('prefix.title')}
          <span className="font-mono text-base">{state.prefix}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="flex items-start gap-2">
          {state.locked ? (
            <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          ) : (
            <LockOpen aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          )}
          {t(state.locked ? 'prefix.locked' : 'prefix.unlocked')}
        </p>
        {state.waiting && (
          <p role="alert" className="flex items-start gap-2">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            {t('prefix.waiting', state.waiting)}
          </p>
        )}
        {/* The locked line says already that only an Admin changes it; before the lock, the role needs saying. */}
        {state.refusal ? (
          state.refusal === 'push-needed' && <p className="text-muted-foreground">{t('prefix.refusal.push-needed')}</p>
        ) : (
          <div>
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
              {t(state.action === 'correct' ? 'prefix.correct' : 'prefix.change')}
            </Button>
          </div>
        )}
      </CardContent>
      {open && <ChangeDialog state={state} actions={actions} library={library} onOpenChange={setOpen} />}
    </Card>
  );
}
