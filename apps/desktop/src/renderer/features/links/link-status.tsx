// A link's state with an icon and a word, never colour alone (PLAN.md §3.19 Accessibility).
import type { SkillLinkView } from '@app/ipc';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Copy,
  FilePen,
  Link2Off,
  Trash2,
  Unlink,
  UserRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../ui/cn.ts';

type Status = SkillLinkView['status'];

const look: Record<Status, { icon: typeof CheckCircle2; className: string }> = {
  linked: { icon: CheckCircle2, className: 'text-success' },
  pending: { icon: Clock, className: 'text-muted-foreground' },
  skipped: { icon: AlertTriangle, className: 'text-danger' },
  missing: { icon: Link2Off, className: 'text-danger' },
  diverged: { icon: AlertTriangle, className: 'text-danger' },
  'taken-over': { icon: Unlink, className: 'text-danger' },
  deleted: { icon: Trash2, className: 'text-danger' },
  suppressed: { icon: Ban, className: 'text-muted-foreground' },
  'detached-by-user': { icon: UserRound, className: 'text-muted-foreground' },
  duplicate: { icon: Copy, className: 'text-danger' },
  'copy-changed': { icon: FilePen, className: 'text-danger' },
};

/** A copy in a copy-mode folder (Step 16) says "Copied" where a link says "Linked". */
export function LinkStatus({
  status,
  method = 'link',
  className,
}: {
  status: Status;
  method?: SkillLinkView['method'];
  className?: string;
}) {
  const { t } = useTranslation();
  const { icon: Icon, className: tone } = look[status];
  const word = status === 'linked' && method === 'copy' ? 'copied' : status;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', tone, className)} data-link={status}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{t(`links.status.${word}`)}</span>
    </span>
  );
}
