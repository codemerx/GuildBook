// The tray menu (PLAN.md §3.1): every instance with its status, then "Open" and "Quit". Built as data, so tests read
// it through the test API (A1.1) and the real tray only renders it.
import type { InstanceView } from '@app/ipc';
import { translate } from '../shared/i18n.ts';
import { libraryLabel } from '../shared/library-label.ts';
import type { TrayMenu } from './os/integrations.ts';

/** ↓ incoming and ↑ to push after a library's name (Step 11, PLAN.md §3.10), when there are any. */
function syncCounts(instance: InstanceView): string {
  const parts = [
    ...((instance.incoming ?? 0) > 0 ? [`↓${instance.incoming}`] : []),
    ...((instance.toPush ?? 0) > 0 ? [`↑${instance.toPush}`] : []),
  ];
  return parts.length > 0 ? ` · ${parts.join(' ')}` : '';
}

export function trayMenu(instances: readonly InstanceView[]): TrayMenu {
  const items: TrayMenu['items'][number][] = instances.length
    ? instances.map((instance) => ({
        kind: 'instance' as const,
        label:
          translate(instance.attention > 0 ? 'tray.instanceAttention' : 'tray.instance', {
            name: libraryLabel(instance),
            // A worker that runs but cannot sync (its access is lost) is not "Ready".
            status: translate(
              instance.accessLost && instance.status === 'ready' ? 'status.accessLost' : `status.${instance.status}`,
            ),
            count: instance.attention,
          }) + syncCounts(instance),
        enabled: true,
        action: { type: 'open-instance' as const, instanceId: instance.id },
      }))
    : [{ kind: 'normal' as const, label: translate('tray.noLibraries'), enabled: false }];
  // The count on the tray icon (PLAN.md §3.8 S2): every library's red warnings together.
  const attention = instances.reduce((sum, instance) => sum + instance.attention, 0);
  return {
    tooltip: attention > 0 ? translate('tray.tooltipAttention', { count: attention }) : translate('tray.tooltip'),
    count: attention,
    items: [
      ...items,
      { kind: 'separator', label: '', enabled: false },
      { kind: 'normal', label: translate('tray.open'), enabled: true, action: { type: 'open' } },
      { kind: 'normal', label: translate('tray.quit'), enabled: true, action: { type: 'quit' } },
    ],
  };
}
