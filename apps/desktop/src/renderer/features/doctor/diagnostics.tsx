// Export diagnostics (PLAN.md §3.13, §3.19 "Telemetry", Step 16): main gathers the logs and the Doctor reports,
// redacted, and the user reviews exactly the text the file gets before saving it. Nothing leaves the device: the user
// sends the file to support themselves, or not at all.
import type { DiagnosticsView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { CheckCircle2, FileText, LifeBuoy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';

export interface DiagnosticsActions {
  prepare(): Promise<DiagnosticsView>;
  /** The saved file's path; null when the user cancelled the save dialog. */
  save(id: string): Promise<string | null>;
}

export const diagnosticsActions: DiagnosticsActions = {
  prepare: () => callDevice('prepareDiagnostics', {}),
  save: async (id) => (await callDevice('saveDiagnostics', { id })).path,
};

/** The review: what the file holds, and its whole text. [Save…] writes exactly this text. */
export function DiagnosticsReview({
  view,
  home,
  actions,
  onClose,
}: {
  view: DiagnosticsView;
  home: string | undefined;
  actions: DiagnosticsActions;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const logs = view.parts.filter((part) => part.kind === 'log');
  const reports = view.parts.filter((part) => part.kind === 'doctor');
  return (
    <DialogShell
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('diagnostics.reviewTitle')}
      description={t('diagnostics.reviewBody')}
      footer={
        saved === null ? (
          <>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                {t('links.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                actions
                  .save(view.id)
                  .then((path) => {
                    if (path !== null) setSaved(path);
                  })
                  .catch((e: unknown) => setError(e as ErrorView))
                  .finally(() => setBusy(false));
              }}
            >
              {t('diagnostics.save')}
            </Button>
          </>
        ) : (
          <DialogClose asChild>
            <Button type="button">{t('diagnostics.close')}</Button>
          </DialogClose>
        )
      }
    >
      {saved !== null ? (
        <p className="flex flex-wrap items-baseline gap-2 text-sm">
          <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 self-center text-success" />
          {t('diagnostics.saved')}
          <PathText path={saved} home={home} />
        </p>
      ) : (
        <>
          <ul aria-label={t('diagnostics.contents')} className="flex flex-col gap-1 text-sm">
            <li>{t('diagnostics.summaryPart')}</li>
            <li>{t('diagnostics.reportsPart', { count: reports.length })}</li>
            <li>{t('diagnostics.logsPart', { count: logs.length })}</li>
            {logs.some((part) => part.truncated) && (
              <li className="text-muted-foreground">{t('diagnostics.truncated')}</li>
            )}
            <li className="text-muted-foreground">{t('diagnostics.notIncluded')}</li>
          </ul>
          {/* The text holds times and paths of this run: the tour masks it. */}
          <pre
            aria-label={t('diagnostics.text')}
            data-volatile
            tabIndex={0}
            className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-xs"
          >
            {view.text}
          </pre>
        </>
      )}
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}

/** [Export diagnostics…]: prepares the text, then shows the review. */
export function ExportDiagnostics({
  home,
  actions = diagnosticsActions,
  variant = 'secondary',
}: {
  home: string | undefined;
  actions?: DiagnosticsActions;
  variant?: 'secondary' | 'default';
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<DiagnosticsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          variant={variant}
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            actions
              .prepare()
              .then(setView)
              .catch((e: unknown) => setError(e as ErrorView))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <FileText aria-hidden="true" /> : <LifeBuoy aria-hidden="true" />}
          {busy ? t('diagnostics.preparing') : t('diagnostics.export')}
        </Button>
      </div>
      {error && <ErrorMessage error={error} />}
      {view && <DiagnosticsReview view={view} home={home} actions={actions} onClose={() => setView(null)} />}
    </div>
  );
}
