// The window's small status view (PLAN.md §3.19 "Launch at login"): on a Linux desktop without a tray, the window
// stays open in this form instead of a tray icon. It shows what the tray menu would: every library with its status,
// its warnings and its sync counts, then [Open] and [Quit].
import { brand } from '@app/brand';
import type { InstanceView } from '@app/ipc';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { libraryLabel } from '../../../shared/library-label.ts';
import { callDevice, useDeviceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { StatusBadge } from '../../ui/status-badge.tsx';

export function StatusViewPanel({
  instances,
  onOpen,
  onQuit,
}: {
  instances: readonly InstanceView[];
  onOpen: () => void;
  onQuit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <main className="flex h-screen flex-col gap-4 bg-background p-4 text-foreground">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">{brand.displayName}</h1>
        <p className="text-sm text-muted-foreground">{t('statusView.why')}</p>
      </header>
      {instances.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('tray.noLibraries')}</p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" aria-label={t('statusView.libraries')}>
          {instances.map((instance) => (
            <li key={instance.id} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
              <span className="font-medium">{libraryLabel(instance)}</span>
              <StatusBadge status={instance.status} accessLost={instance.accessLost === true} />
              {(instance.incoming ?? 0) > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t('shell.incoming', { count: instance.incoming })}
                </span>
              )}
              {(instance.toPush ?? 0) > 0 && (
                <span className="text-xs text-muted-foreground">{t('shell.toPush', { count: instance.toPush })}</span>
              )}
              {instance.attention > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-danger">
                  <AlertTriangle aria-hidden="true" className="size-3.5" />
                  {t('statusView.attention', { count: instance.attention })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <footer className="mt-auto flex flex-wrap gap-2">
        <Button onClick={onOpen}>{t('tray.open')}</Button>
        <Button variant="outline" onClick={onQuit}>
          {t('tray.quit')}
        </Button>
      </footer>
    </main>
  );
}

export function StatusView() {
  const instances = useDeviceQuery('instances');
  return (
    <StatusViewPanel
      instances={instances.data ?? []}
      onOpen={() => void callDevice('openFullWindow', {}).catch(() => undefined)}
      onQuit={() => void callDevice('quitApp', {}).catch(() => undefined)}
    />
  );
}
