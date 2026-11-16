// The summary of a move (PLAN.md §3.9 "What the user sees"), shown above every page: the worker starts again at the
// library's new place right after the move, and the page that started it shows "starting" meanwhile. So the summary
// can't live in that page's dialog; it waits here until the user closes it.
import type { RelocationSummaryView } from '@app/ipc';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeviceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { RelocationSummary } from './relocation-summary.tsx';

interface Shown {
  readonly name: string;
  readonly summary: RelocationSummaryView;
}

let shown: Shown | null = null;
const listeners = new Set<() => void>();

/** Shows a move's summary; it stays until the user closes it. */
export function announceRelocation(name: string, summary: RelocationSummaryView): void {
  shown = { name, summary };
  for (const listener of listeners) listener();
}

function close(): void {
  shown = null;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function RelocationSummaryHost() {
  const { t } = useTranslation();
  const current = useSyncExternalStore(subscribe, () => shown);
  const appInfo = useDeviceQuery('appInfo');
  if (!current) return null;
  return (
    <DialogShell
      open
      onOpenChange={(open) => !open && close()}
      title={t(
        current.summary.method === 'locate' ? 'relocation.summary.foundTitle' : 'relocation.summary.movedTitle',
        { name: current.name },
      )}
      footer={
        <DialogClose asChild>
          <Button type="button">{t('relocation.close')}</Button>
        </DialogClose>
      }
    >
      <RelocationSummary summary={current.summary} home={appInfo.data?.homePath} />
    </DialogShell>
  );
}
