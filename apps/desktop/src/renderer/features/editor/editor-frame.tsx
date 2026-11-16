// The editor's frame (PLAN.md §3.14): the list grouped as Instructions / Skills with friendly titles, [New skill],
// and the page beside it. A skill with problems shows its count, with an icon and text, not colour alone.
import type { InstanceView, LibrarySnapshotView } from '@app/ipc';
import { friendlyTitle } from '@app/schemas';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, Download, FileText, Plus, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '../../ui/button.tsx';
import { cn } from '../../ui/cn.ts';
import { LibraryNav } from '../links/library-nav.tsx';

const item = 'flex flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground';
const current = { 'aria-current': 'page' as const, className: 'bg-accent text-accent-foreground' };

export function EditorList({
  instanceId,
  snapshot,
  localPrefix,
}: {
  instanceId: string;
  snapshot: LibrarySnapshotView | undefined;
  /** The local prefix: the names on this device (PLAN.md §3.3). */
  localPrefix: string | null;
}) {
  const { t } = useTranslation();
  const prefix = snapshot?.config.prefix ?? null;
  const shown = (name: string) =>
    localPrefix !== null && prefix !== null && name.startsWith(`${prefix}-`)
      ? `${localPrefix}-${name.slice(prefix.length + 1)}`
      : name;
  return (
    <nav aria-label={t('editor.list.label')} className="flex w-56 shrink-0 flex-col gap-4">
      <Link
        to="/library/$instanceId/edit/new"
        params={{ instanceId }}
        className={cn(buttonVariants({ size: 'sm' }), 'justify-start')}
      >
        <Plus aria-hidden="true" />
        {t('editor.list.newSkill')}
      </Link>
      <Link
        to="/library/$instanceId/edit/import"
        params={{ instanceId }}
        className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), '-mt-2 justify-start')}
      >
        <Download aria-hidden="true" />
        {t('editor.list.import')}
      </Link>
      <div className="flex flex-col gap-1">
        <h2 className="px-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('editor.list.instructions')}
        </h2>
        <Link
          to="/library/$instanceId/edit/instructions"
          params={{ instanceId }}
          className={item}
          activeProps={current}
        >
          <span className="flex items-center gap-1.5">
            <FileText aria-hidden="true" className="size-3.5" />
            {t('editor.list.instructionsTitle')}
          </span>
        </Link>
      </div>
      <div className="flex min-h-0 flex-col gap-1">
        <h2 className="px-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('editor.list.skills')}
        </h2>
        {snapshot?.skills.length === 0 && (
          <p className="px-2.5 text-sm text-muted-foreground">{t('editor.list.empty')}</p>
        )}
        <ul className="flex flex-col gap-0.5">
          {snapshot?.skills.map((skill) => (
            <li key={skill.folder}>
              <Link
                to="/library/$instanceId/edit/skill/$skill"
                params={{ instanceId, skill: skill.folder }}
                className={item}
                activeProps={current}
              >
                <span className="truncate font-medium">{friendlyTitle(skill.folder, prefix)}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{shown(skill.folder)}</span>
                {(skill.errors > 0 || skill.warnings > 0) && (
                  <span className="flex items-center gap-2 text-xs">
                    {skill.errors > 0 && (
                      <span className="flex items-center gap-1">
                        <XCircle aria-hidden="true" className="size-3 text-danger" />
                        {t('editor.list.errors', { count: skill.errors })}
                      </span>
                    )}
                    {skill.warnings > 0 && (
                      <span className="flex items-center gap-1">
                        <AlertTriangle aria-hidden="true" className="size-3 text-warning" />
                        {t('editor.list.warnings', { count: skill.warnings })}
                      </span>
                    )}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

export function EditorFrame({
  instance,
  snapshot,
  localPrefix,
  children,
}: {
  instance: InstanceView;
  snapshot: LibrarySnapshotView | undefined;
  localPrefix: string | null;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">{t('editor.title', { name: instance.name })}</h1>
        {instance.status === 'setting-up' ? (
          // An Admin's new library gets its skills and instructions during the setup (PLAN.md §3.17 steps 4–5).
          <Link
            to="/library/$instanceId/setup"
            params={{ instanceId: instance.id }}
            className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'self-start')}
          >
            <ArrowLeft aria-hidden="true" />
            {t('editor.backToSetup')}
          </Link>
        ) : (
          <LibraryNav instanceId={instance.id} attention={instance.attention} />
        )}
      </header>
      <div className="flex gap-6">
        <EditorList instanceId={instance.id} snapshot={snapshot} localPrefix={localPrefix} />
        <div className="flex min-w-0 flex-1 flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}
