// Settings → Remove everything this app set up (PLAN.md §3.8 S12): every library's links, marked blocks, exclude
// entries, owned files and copies go, and the libraries are removed from this device. The library folders stay. The
// documentation points here before an uninstall; on Windows the uninstaller runs the same operation.
import type { ErrorView } from '@app/schemas';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';

export function RemoveEverythingCard({
  libraries,
  onRemove,
}: {
  /** How many libraries are on this device. */
  libraries: number;
  onRemove: () => Promise<{ removed: number }>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [done, setDone] = useState<number | null>(null);
  return (
    <Card role="region" aria-label={t('settings.removeEverything.title')}>
      <CardHeader>
        <CardTitle>{t('settings.removeEverything.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">{t('settings.removeEverything.body')}</p>
        {done !== null && (
          <p role="status" className="flex items-center gap-2">
            <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
            {t('settings.removeEverything.done', { count: done })}
          </p>
        )}
        <div>
          <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
            {t('settings.removeEverything.button')}
          </Button>
        </div>
      </CardContent>
      {open && (
        <DialogShell
          open
          onOpenChange={(next) => !busy && setOpen(next)}
          title={t('settings.removeEverything.confirmTitle')}
          footer={
            <>
              <DialogClose asChild>
                <Button type="button" variant="ghost" disabled={busy}>
                  {t('remove.cancel')}
                </Button>
              </DialogClose>
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  onRemove()
                    .then(({ removed }) => {
                      setDone(removed);
                      setOpen(false);
                    })
                    .catch((e: unknown) => setError(e as ErrorView))
                    .finally(() => setBusy(false));
                }}
              >
                {t('settings.removeEverything.confirm')}
              </Button>
            </>
          }
        >
          <p className="text-sm">{t('settings.removeEverything.confirmBody', { count: libraries })}</p>
          <p className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            {t('settings.removeEverything.kept')}
          </p>
          {error && <ErrorMessage error={error} />}
        </DialogShell>
      )}
    </Card>
  );
}
