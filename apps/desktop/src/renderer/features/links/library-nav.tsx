// A library's pages (Steps 5–11): its skills, the editor (Step 10), the git screens (Step 11), the placement overview,
// its repos, "Needs attention" with its count, the activity log, the tools page and the Doctor. A pull that stopped on
// conflicts shows its banner under them, on every page (PLAN.md §3.10 step 3).
import { Link } from '@tanstack/react-router';
import {
  Activity,
  AlertTriangle,
  Boxes,
  FolderGit2,
  GitCommitVertical,
  PenLine,
  Stethoscope,
  Table2,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '../../ui/button.tsx';
import { cn } from '../../ui/cn.ts';
import { ConflictBanner } from '../sync/conflict-banner.tsx';

// Nine pages fit on one line of a 768 px page (Step 10 added the editor's tab, Step 11 the git screens').
const tab = cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'gap-1.5 px-1');
const active = { 'aria-current': 'page' as const, className: 'bg-accent text-accent-foreground' };

export function LibraryNav({ instanceId, attention }: { instanceId: string; attention: number }) {
  const { t } = useTranslation();
  return (
    <>
      <nav aria-label={t('links.nav.label')} className="flex flex-wrap gap-0 border-b border-border pb-2">
        <Link
          to="/library/$instanceId"
          params={{ instanceId }}
          className={tab}
          activeOptions={{ exact: true }}
          activeProps={active}
        >
          <Boxes aria-hidden="true" />
          {t('links.nav.skills')}
        </Link>
        <Link to="/library/$instanceId/edit" params={{ instanceId }} className={tab} activeProps={active}>
          <PenLine aria-hidden="true" />
          {t('links.nav.edit')}
        </Link>
        <Link to="/library/$instanceId/changes" params={{ instanceId }} className={tab} activeProps={active}>
          <GitCommitVertical aria-hidden="true" />
          {t('links.nav.changes')}
        </Link>
        <Link to="/library/$instanceId/overview" params={{ instanceId }} className={tab} activeProps={active}>
          <Table2 aria-hidden="true" />
          {t('links.nav.overview')}
        </Link>
        <Link to="/library/$instanceId/repos" params={{ instanceId }} className={tab} activeProps={active}>
          <FolderGit2 aria-hidden="true" />
          {t('links.nav.repos')}
        </Link>
        <Link to="/library/$instanceId/attention" params={{ instanceId }} className={tab} activeProps={active}>
          <AlertTriangle aria-hidden="true" className={attention > 0 ? 'text-danger' : undefined} />
          {t('links.nav.attention')}
          {attention > 0 && (
            <span className="rounded-full bg-danger px-1.5 text-xs font-semibold text-danger-foreground">
              {t('links.nav.count', { count: attention })}
            </span>
          )}
        </Link>
        <Link to="/library/$instanceId/activity" params={{ instanceId }} className={tab} activeProps={active}>
          <Activity aria-hidden="true" />
          {t('links.nav.activity')}
        </Link>
        <Link to="/library/$instanceId/tools" params={{ instanceId }} className={tab} activeProps={active}>
          <Wrench aria-hidden="true" />
          {t('links.nav.tools')}
        </Link>
        <Link to="/library/$instanceId/doctor" params={{ instanceId }} className={tab} activeProps={active}>
          <Stethoscope aria-hidden="true" />
          {t('links.nav.doctor')}
        </Link>
      </nav>
      <ConflictBanner instanceId={instanceId} />
    </>
  );
}
