// The library switcher (ADR 0004): every library, by its name and prefix, with its status. Choosing one shows its pages.
import type { InstanceView } from '@app/ipc';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { libraryLabel } from '../../../shared/library-label.ts';
import { cn } from '../../ui/cn.ts';
import { StatusBadge } from '../../ui/status-badge.tsx';

export function LibrarySwitcher({
  instances,
  currentId,
}: {
  instances: readonly InstanceView[];
  currentId: string | undefined;
}) {
  const { t } = useTranslation();
  if (instances.length === 0) {
    return <p className="px-3 py-2 text-sm text-muted-foreground">{t('shell.noLibraries')}</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5" aria-label={t('shell.switcherLabel')}>
      {instances.map((instance) => {
        const current = instance.id === currentId;
        return (
          <li key={instance.id}>
            <Link
              to="/library/$instanceId"
              params={{ instanceId: instance.id }}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground',
                current && 'bg-accent text-accent-foreground',
              )}
            >
              <span className="truncate font-medium">{libraryLabel(instance)}</span>
              <StatusBadge status={instance.status} accessLost={instance.accessLost === true} />
              {((instance.incoming ?? 0) > 0 || (instance.toPush ?? 0) > 0) && (
                <span
                  className="inline-flex items-center gap-2 text-xs text-muted-foreground"
                  data-testid="sync-counts"
                >
                  {(instance.incoming ?? 0) > 0 && (
                    <span
                      className="inline-flex items-center gap-0.5"
                      aria-label={t('shell.incoming', { count: instance.incoming })}
                    >
                      <ArrowDownToLine aria-hidden="true" className="size-3.5" />
                      {instance.incoming}
                    </span>
                  )}
                  {(instance.toPush ?? 0) > 0 && (
                    <span
                      className="inline-flex items-center gap-0.5"
                      aria-label={t('shell.toPush', { count: instance.toPush })}
                    >
                      <ArrowUpFromLine aria-hidden="true" className="size-3.5" />
                      {instance.toPush}
                    </span>
                  )}
                </span>
              )}
              {instance.attention > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-danger">
                  <AlertTriangle aria-hidden="true" className="size-3.5" />
                  {t('shell.needsAttention', { count: instance.attention })}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
