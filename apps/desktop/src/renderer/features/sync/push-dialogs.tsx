// What a push can come back with (PLAN.md §3.10 "Push", §3.15): secrets found in the commits it would send, which the
// user confirms as a false alarm or stops for, and the two rejections, explained so none is a dead end. Nothing is lost:
// the commits wait to be pushed. Moving rejected commits into a change request comes with roles (Step 12).
import type { PushResultView, SecretFindingView } from '@app/ipc';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { DialogShell } from '../../ui/dialog.tsx';

/** The secrets found, each with its file and line, never the secret itself. */
export function SecretList({ findings }: { findings: readonly SecretFindingView[] }) {
  const { t } = useTranslation();
  return (
    <ul aria-label={t('sync.secrets.listLabel')} className="flex flex-col gap-1 text-sm">
      {findings.map((finding) => (
        <li key={`${finding.commit ?? ''}:${finding.path}:${finding.line}:${finding.rule}`}>
          <span className="font-mono">{finding.path}</span>
          {t('sync.secrets.line', { line: finding.line, kind: t(`sync.secrets.rules.${finding.rule}`) })}
        </li>
      ))}
    </ul>
  );
}

export function PushResultDialog({
  result,
  library,
  onClose,
  onConfirmSecrets,
  onMove,
  onSign,
}: {
  result: PushResultView | null;
  library: string;
  onClose: () => void;
  onConfirmSecrets: () => void;
  /** [Move my commits to a new branch and open a change request], where the role may open one. */
  onMove?: (() => void) | undefined;
  /** [Sign my unpushed commits and push again]. */
  onSign?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  if (result?.kind === 'secrets') {
    return (
      <DialogShell
        open
        onOpenChange={(open) => !open && onClose()}
        title={t('sync.secrets.pushTitle')}
        description={t('sync.secrets.pushBody')}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('sync.secrets.stop')}
            </Button>
            <Button type="button" onClick={onConfirmSecrets}>
              {t('sync.secrets.pushAnyway')}
            </Button>
          </>
        }
      >
        <SecretList findings={result.findings} />
      </DialogShell>
    );
  }
  if (result?.kind === 'rejected') {
    const reason =
      result.reason === 'nonFastForward'
        ? 'movedOn'
        : result.reason === 'protected'
          ? 'notAllowed'
          : result.reason === 'unsigned'
            ? 'unsigned'
            : 'other';
    const next = reason === 'notAllowed' ? onMove : reason === 'unsigned' ? onSign : undefined;
    return (
      <DialogShell
        open
        onOpenChange={(open) => !open && onClose()}
        title={t(`sync.rejected.${reason}.title`, { library, branch: result.branch })}
        description={t(`sync.rejected.${reason}.body`, { library, branch: result.branch })}
        footer={
          <>
            {/* The way on first: a long label wraps above [Close], not under it. */}
            {next && (
              <Button
                type="button"
                onClick={() => {
                  onClose();
                  next();
                }}
              >
                {t(reason === 'notAllowed' ? 'review.move' : 'review.signing.signAndPush')}
              </Button>
            )}
            <Button type="button" variant={next ? 'secondary' : 'default'} onClick={onClose}>
              {t('sync.close')}
            </Button>
          </>
        }
      >
        {result.remoteMessage !== '' && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{t('sync.rejected.serverSaid')}</summary>
            <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs">
              {result.remoteMessage}
            </pre>
          </details>
        )}
      </DialogShell>
    );
  }
  return null;
}
