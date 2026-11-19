// App updates (PLAN.md §3.19 "App updates", Step 18; ADR 0031): Settings → Updates shows the version, the last check
// and [Check now], and the tool catalog in use. A newer version is only shown: [Download] opens its release page, and
// the user installs it. The banner at the top of every page tells about it once, with [Download] and [Later].
import { brand } from '@app/brand';
import type { UpdateView } from '@app/ipc';
import { CheckCircle2, Download, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { callDevice, useDeviceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { EventTime } from '../links/activity-page.tsx';

export interface UpdateActions {
  check(): void;
  download(): void;
  later(): void;
}

const deviceActions: UpdateActions = {
  check: () => void callDevice('checkForUpdates', {}).catch(() => undefined),
  download: () => void callDevice('openUpdateDownload', {}).catch(() => undefined),
  later: () => void callDevice('dismissUpdate', {}).catch(() => undefined),
};

/** The sentence for the app's own update. */
function AppStatus({ view }: { view: UpdateView }) {
  const { t } = useTranslation();
  const appName = brand.displayName;
  if (!view.supported) return <p className="text-sm text-muted-foreground">{t('updates.unsupported', { appName })}</p>;
  switch (view.phase) {
    case 'checking':
      return <p className="text-sm">{t('updates.checking')}</p>;
    case 'available':
      return (
        <p className="text-sm font-medium">{t('updates.available', { version: view.available ?? '', appName })}</p>
      );
    case 'failed':
      return (
        <p role="alert" className="text-sm text-destructive">
          {t(view.error?.code === 'update.offline' ? 'errors.update.offline' : 'errors.update.failed')}
        </p>
      );
    case 'idle':
    case 'up-to-date':
      return (
        <p className="inline-flex items-center gap-1.5 text-sm">
          {view.phase === 'up-to-date' && <CheckCircle2 aria-hidden="true" className="size-4 text-success" />}
          {view.phase === 'up-to-date' ? t('updates.upToDate', { appName }) : t('updates.notChecked')}
        </p>
      );
  }
}

export function UpdatesCardView({ view, actions = deviceActions }: { view: UpdateView; actions?: UpdateActions }) {
  const { t } = useTranslation();
  return (
    <Card aria-labelledby="updates-title">
      <CardHeader>
        <CardTitle id="updates-title">{t('updates.title')}</CardTitle>
        <CardDescription>{t('updates.body', { appName: brand.displayName })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {t('settings.version', { appName: brand.displayName, version: view.version })}
        </p>
        <AppStatus view={view} />
        {view.lastCheckedAt !== null && (
          <p className="text-sm text-muted-foreground">
            {t('updates.lastChecked')} <EventTime ms={Date.parse(view.lastCheckedAt)} />
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={view.phase === 'checking'} onClick={() => actions.check()}>
            <RefreshCw aria-hidden="true" />
            {t('updates.checkNow')}
          </Button>
          {view.phase === 'available' && <DownloadButton actions={actions} />}
        </div>
      </CardContent>
    </Card>
  );
}

function DownloadButton({ actions }: { actions: UpdateActions }) {
  const { t } = useTranslation();
  return (
    <Button size="sm" onClick={() => actions.download()}>
      <Download aria-hidden="true" />
      {t('updates.download')}
    </Button>
  );
}

export function UpdatesCard() {
  const updates = useDeviceQuery('updates');
  if (!updates.data) return null;
  return <UpdatesCardView view={updates.data} />;
}

/** A newer version is out: the banner at the top of every page, until [Download] or [Later]. */
export function UpdateAvailableBannerView({
  view,
  actions = deviceActions,
}: {
  view: UpdateView;
  actions?: UpdateActions;
}) {
  const { t } = useTranslation();
  if (view.phase !== 'available' || view.dismissed) return null;
  return (
    <section
      aria-labelledby="update-available-title"
      className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-accent px-4 py-3"
    >
      <Download aria-hidden="true" className="size-5 shrink-0 text-primary" />
      <p id="update-available-title" className="min-w-0 flex-1 text-sm font-medium">
        {t('updates.available', { version: view.available ?? '', appName: brand.displayName })}
      </p>
      <div className="flex flex-wrap gap-2">
        <DownloadButton
          actions={{
            ...actions,
            download: () => {
              actions.download();
              actions.later();
            },
          }}
        />
        <Button variant="outline" size="sm" onClick={() => actions.later()}>
          {t('updates.later')}
        </Button>
      </div>
    </section>
  );
}

export function UpdateAvailableBanner() {
  const updates = useDeviceQuery('updates');
  if (!updates.data) return null;
  return <UpdateAvailableBannerView view={updates.data} />;
}
