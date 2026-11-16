// The app shell (IMPLEMENTATION.md Step 1): a sidebar with the library switcher, the device-wide pages, and the page.
import type { InstanceView, SetupView } from '@app/ipc';
import { Link, Outlet, useParams } from '@tanstack/react-router';
import { RelocationSummaryHost } from '../relocation/summary-host.tsx';
import { Clock, FileText, FolderPlus, LogIn, Plus, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDeviceQuery } from '../../rpc/queries.ts';
import { buttonVariants } from '../../ui/button.tsx';
import { cn } from '../../ui/cn.ts';
import { UpdateAvailableBanner } from '../settings/updates.tsx';
import { FolderAccessNotice } from './folder-access.tsx';
import { LibrarySwitcher } from './library-switcher.tsx';

export function AppShellView({
  instances,
  setups = [],
  currentId,
  testLibraries,
  banner,
  children,
}: {
  instances: readonly InstanceView[];
  /** Setups whose instance is still pending (Step 4). */
  setups?: readonly SetupView[];
  currentId: string | undefined;
  testLibraries: boolean;
  /** Above every page: the notice once a newer version is out (Step 18). */
  banner?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
      >
        {t('shell.skipToContent')}
      </a>
      <nav
        aria-label={t('shell.libraries')}
        className="flex w-64 shrink-0 flex-col gap-4 border-r border-border bg-sidebar p-3"
      >
        <div className="flex flex-col gap-1">
          <h2 className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('shell.libraries')}
          </h2>
          <LibrarySwitcher instances={instances} currentId={currentId} />
          {setups.length > 0 && (
            <ul aria-label={t('shell.setupsInProgress')} className="flex flex-col gap-0.5">
              {setups.map((setup) => (
                <li key={setup.id}>
                  <Link
                    to="/setup/$setupId"
                    params={{ setupId: setup.id }}
                    title={t('shell.settingUp', { repo: setup.repo })}
                    className="flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
                  >
                    <span className="truncate font-medium">{setup.repo}</span>
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock aria-hidden="true" className="size-3.5 shrink-0" />
                      {t('shell.settingUpStatus')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link
            to="/connect"
            search={{ intent: 'join' }}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'justify-start')}
          >
            <LogIn aria-hidden="true" />
            {t('shell.joinLibrary')}
          </Link>
          <Link
            to="/connect"
            search={{ intent: 'create' }}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'justify-start')}
          >
            <FolderPlus aria-hidden="true" />
            {t('shell.createLibrary')}
          </Link>
          {testLibraries && (
            <Link
              to="/add-test-library"
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'justify-start')}
            >
              <Plus aria-hidden="true" />
              {t('shell.addTestLibrary')}
            </Link>
          )}
        </div>
        <div className="mt-auto flex flex-col gap-1">
          <h2 className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('shell.devicePages')}
          </h2>
          <Link
            to="/instructions"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'justify-start')}
            activeProps={{ 'aria-current': 'page', className: 'bg-accent text-accent-foreground' }}
          >
            <FileText aria-hidden="true" />
            {t('shell.instructions')}
          </Link>
          <Link
            to="/settings"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'justify-start')}
            activeProps={{ 'aria-current': 'page', className: 'bg-accent text-accent-foreground' }}
          >
            <Settings aria-hidden="true" />
            {t('shell.settings')}
          </Link>
        </div>
      </nav>
      {/* Focusable, so a keyboard can scroll a long page (axe: scrollable-region-focusable), with a visible ring. */}
      <main
        id="main"
        tabIndex={0}
        className="min-w-0 flex-1 overflow-y-auto p-8 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {banner}
        {children}
      </main>
    </div>
  );
}

export function AppShell() {
  const instances = useDeviceQuery('instances');
  const setups = useDeviceQuery('setups');
  const appInfo = useDeviceQuery('appInfo');
  const params = useParams({ strict: false });
  return (
    <AppShellView
      instances={instances.data ?? []}
      setups={setups.data ?? []}
      currentId={params.instanceId}
      testLibraries={appInfo.data?.features.testLibraries ?? false}
      banner={<UpdateAvailableBanner />}
    >
      <Outlet />
      <RelocationSummaryHost />
      <FolderAccessNotice />
    </AppShellView>
  );
}
