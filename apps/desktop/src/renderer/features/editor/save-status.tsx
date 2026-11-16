// What autosave is doing (A10.4), and the question when the file changed on disk while the editor had unsaved edits.
import { AlertTriangle, Check, Loader2, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { DialogShell } from '../../ui/dialog.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import type { AutosaveState } from './autosave.ts';

export function SaveStatus({ state }: { state: AutosaveState }) {
  const { t } = useTranslation();
  const icon = {
    saved: <Check aria-hidden="true" className="size-3.5 text-success" />,
    editing: <Pencil aria-hidden="true" className="size-3.5" />,
    saving: <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />,
    conflict: <AlertTriangle aria-hidden="true" className="size-3.5 text-warning" />,
    error: <AlertTriangle aria-hidden="true" className="size-3.5 text-danger" />,
  }[state.status];
  return (
    <div className="flex flex-col gap-2">
      <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {t(`editor.save.${state.status}`)}
      </p>
      {state.error && <ErrorMessage error={state.error} />}
    </div>
  );
}

export function ChangedOnDiskDialog({
  open,
  file,
  onKeepMine,
  onUseDisk,
}: {
  open: boolean;
  file: string;
  onKeepMine: () => void;
  onUseDisk: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogShell
      open={open}
      onOpenChange={() => undefined}
      title={t('editor.conflict.title', { file })}
      description={t('editor.conflict.body')}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onUseDisk}>
            {t('editor.conflict.useDisk')}
          </Button>
          <Button type="button" onClick={onKeepMine}>
            {t('editor.conflict.keepMine')}
          </Button>
        </>
      }
    />
  );
}
