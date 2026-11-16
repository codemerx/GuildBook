// The answers "Needs attention" gives for projected copies (PLAN.md §3.3, Step 8):
// - both sides changed: [Show the differences and decide], then keep the library's version or the changes on this
//   device; the other side goes to the trash
// - a name too long under the local prefix: [Change the local prefix], on the library's page
// A skill whose name doesn't start with the git prefix has no answer here: its name in git has to change.
import type { AttentionItemView, CopyConflictView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { Link } from '@tanstack/react-router';
import { FileDiff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, queryInstance } from '../../rpc/queries.ts';
import { Button, buttonVariants } from '../../ui/button.tsx';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { lineDiff } from './line-diff.ts';

export interface CopyActions {
  differences(key: string): Promise<CopyConflictView>;
  keep(key: string, keep: 'library' | 'copy'): Promise<void>;
}

export function copyActions(instanceId: string): CopyActions {
  return {
    differences: (key) => queryInstance(instanceId, 'copyDifferences', { key, keep: 'copy' }),
    async keep(key, keep) {
      // Each answer is its own plan: previewed for that side, applied with its hash.
      const plan = await queryInstance(instanceId, 'copyDifferences', { key, keep });
      await callInstance(instanceId, 'resolveCopy', { key, keep, planHash: plan.hash });
    },
  };
}

function FileComparison({ file }: { file: CopyConflictView['files'][number] }) {
  const { t } = useTranslation();
  const both = file.library !== null && file.copy !== null ? lineDiff(file.library, file.copy) : null;
  return (
    <li className="flex flex-col gap-1">
      <p className="flex flex-wrap gap-2">
        <span className="font-mono text-xs">{file.path}</span>
        <span className="text-xs text-muted-foreground">{t(`projection.change.${file.change}`)}</span>
      </p>
      {both ? (
        <pre
          // It scrolls: the keyboard reaches it too.
          tabIndex={0}
          aria-label={file.path}
          className="max-h-64 overflow-auto rounded-md border border-border bg-muted p-2 font-mono text-xs"
        >
          {both.map((line, index) => (
            <div
              key={index}
              className={line.kind === 'library' ? 'text-danger' : line.kind === 'copy' ? 'text-success' : undefined}
            >
              <span aria-hidden="true">{line.kind === 'library' ? '− ' : line.kind === 'copy' ? '+ ' : '  '}</span>
              <span className="sr-only">
                {line.kind === 'library' ? t('projection.library') : line.kind === 'copy' ? t('projection.copy') : ''}
              </span>
              {line.text}
            </div>
          ))}
        </pre>
      ) : (
        <p className="text-xs text-muted-foreground">
          {file.library === null && file.copy === null ? t('projection.noText') : null}
        </p>
      )}
    </li>
  );
}

function BothChangedDialog({
  item,
  actions,
  onOpenChange,
}: {
  item: AttentionItemView;
  actions: CopyActions;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<CopyConflictView | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void actions.differences(item.id).then(setView, (e: unknown) => setError(e as ErrorView));
  }, [actions, item.id]);
  const keep = (side: 'library' | 'copy') => {
    setBusy(true);
    setError(null);
    actions
      .keep(item.id, side)
      .then(() => onOpenChange(false))
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(false));
  };
  return (
    <DialogShell
      open
      onOpenChange={onOpenChange}
      title={t('projection.title', { skill: item.skill })}
      description={t('projection.body')}
      footer={
        <>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {t('links.cancel')}
            </Button>
          </DialogClose>
          <Button type="button" variant="secondary" disabled={busy || !view} onClick={() => keep('library')}>
            {t('projection.keepLibrary')}
          </Button>
          <Button type="button" disabled={busy || !view} onClick={() => keep('copy')}>
            {t('projection.keepCopy')}
          </Button>
        </>
      }
    >
      {view && (
        <section aria-label={t('projection.differences')} className="flex flex-col gap-2">
          <p className="flex gap-4 text-xs">
            <span className="text-danger">− {t('projection.library')}</span>
            <span className="text-success">+ {t('projection.copy')}</span>
          </p>
          <ul className="flex flex-col gap-3">
            {view.files.map((file) => (
              <FileComparison key={file.path} file={file} />
            ))}
          </ul>
        </section>
      )}
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}

export function CopyAnswers({
  item,
  instanceId,
  actions,
}: {
  item: AttentionItemView;
  instanceId: string;
  actions: CopyActions;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (item.kind === 'copy-conflict') {
    return (
      <div>
        <Button type="button" size="sm" onClick={() => setOpen(true)}>
          <FileDiff aria-hidden="true" />
          {t('projection.showDifferences')}
        </Button>
        {open && <BothChangedDialog item={item} actions={actions} onOpenChange={setOpen} />}
      </div>
    );
  }
  if (item.kind === 'name-too-long') {
    return (
      <div>
        <Link to="/library/$instanceId" params={{ instanceId }} className={buttonVariants({ size: 'sm' })}>
          {t('projection.fixPrefix')}
        </Link>
      </div>
    );
  }
  return null;
}
