// An instance's status with an icon and text, never colour alone (PLAN.md §3.19 Accessibility).
import type { InstanceStatus } from '@app/ipc';
import { AlertCircle, CheckCircle2, Clock, Loader2, RotateCw, ShieldAlert, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from './cn.ts';

const look: Record<InstanceStatus, { icon: typeof CheckCircle2; className: string; spin?: boolean }> = {
  pending: { icon: Clock, className: 'text-muted-foreground' },
  'setting-up': { icon: Clock, className: 'text-muted-foreground' },
  starting: { icon: Loader2, className: 'text-muted-foreground', spin: true },
  ready: { icon: CheckCircle2, className: 'text-success' },
  restarting: { icon: RotateCw, className: 'text-warning', spin: true },
  error: { icon: AlertCircle, className: 'text-danger' },
  removing: { icon: Trash2, className: 'text-muted-foreground' },
};

export function StatusBadge({
  status,
  accessLost = false,
  className,
}: {
  status: InstanceStatus;
  /** The library runs, but its access to the host is lost: a green "Ready" would say the opposite of the warning. */
  accessLost?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const lost = accessLost && status === 'ready';
  const { icon: Icon, className: tone, spin } = lost ? { icon: ShieldAlert, className: 'text-danger' } : look[status];
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-xs font-medium', tone, className)}
      data-status={lost ? 'access-lost' : status}
    >
      <Icon aria-hidden="true" className={cn('size-3.5', spin && 'motion-safe:animate-spin')} />
      <span>{t(lost ? 'status.accessLost' : `status.${status}`)}</span>
    </span>
  );
}
