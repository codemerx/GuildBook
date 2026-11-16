// Device-wide settings (PLAN.md §3.1): the theme and the language in Step 1; Step 9 adds Remove everything (§3.8 S12),
// Step 15 launch at login (§3.19), Step 16 Export diagnostics (§3.13), Step 17 the notifications (§3.19), and Step 18
// the app's updates (§3.19).
import { brand } from '@app/brand';
import type { CertificateView } from '@app/ipc';
import type { NotificationSettings, NotificationType, Theme } from '@app/schemas';
import { RadioGroup } from 'radix-ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, useDeviceCommand, useDeviceQuery } from '../../rpc/queries.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { type DiagnosticsActions, ExportDiagnostics } from '../doctor/diagnostics.tsx';
import { type CertificateActions, CertificatesCard } from './certificates.tsx';
import { RemoveEverythingCard } from './remove-everything.tsx';
import { UpdatesCard } from './updates.tsx';

const themes: readonly Theme[] = ['system', 'light', 'dark'];
const themeLabel = {
  system: 'settings.themeSystem',
  light: 'settings.themeLight',
  dark: 'settings.themeDark',
} as const;

const notificationTypes: readonly NotificationType[] = ['incoming', 'linksChanged', 'warning'];

/** Each type of notification can be switched off, and Do not disturb holds back every one (PLAN.md §3.19). */
export function NotificationsCard({
  settings,
  onChange,
}: {
  settings: NotificationSettings;
  onChange: (settings: NotificationSettings) => void;
}) {
  const { t } = useTranslation();
  // The switches show at once; main's settings follow.
  const [local, setLocal] = useState<{ from: NotificationSettings; to: NotificationSettings } | null>(null);
  const shown = local !== null && local.from === settings ? local.to : settings;
  const change = (to: NotificationSettings) => {
    setLocal({ from: settings, to });
    onChange(to);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle id="notifications-title">{t('settings.notifications.title')}</CardTitle>
        <CardDescription>{t('settings.notifications.body', { appName: brand.displayName })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-2" aria-labelledby="notifications-title" disabled={shown.doNotDisturb}>
          {notificationTypes.map((type) => (
            <label key={type} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!shown.off.includes(type)}
                onChange={(e) =>
                  change({
                    ...shown,
                    off: e.target.checked ? shown.off.filter((o) => o !== type) : [...shown.off, type],
                  })
                }
              />
              {t(`settings.notifications.${type}`)}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={shown.doNotDisturb}
              aria-describedby="do-not-disturb-hint"
              onChange={(e) => change({ ...shown, doNotDisturb: e.target.checked })}
            />
            {t('settings.notifications.doNotDisturb')}
          </label>
          <p id="do-not-disturb-hint" className="ml-6 text-sm text-muted-foreground">
            {t('settings.notifications.doNotDisturbHint', { appName: brand.displayName })}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function SettingsPageView({
  theme,
  version,
  certificates,
  onTheme,
  libraries = 0,
  onRemoveEverything,
  launchAtLogin,
  onLaunchAtLogin,
  notifications,
  onNotifications,
  diagnostics,
  updates,
  certificateList,
  certificateActions,
}: {
  theme: Theme;
  version: string;
  certificates: number;
  onTheme: (theme: Theme) => void;
  libraries?: number;
  onRemoveEverything?: () => Promise<{ removed: number }>;
  launchAtLogin?: boolean;
  onLaunchAtLogin?: (on: boolean) => void;
  notifications?: NotificationSettings;
  onNotifications?: (settings: NotificationSettings) => void;
  /** Export diagnostics (Step 16); left out, the card isn't shown. */
  diagnostics?: { readonly home: string | undefined; readonly actions?: DiagnosticsActions };
  /** The Updates card (Step 18); left out, the About card shows the version instead. */
  updates?: React.ReactNode;
  /** The extra certificates themselves, and their actions (Step 18). */
  certificateList?: readonly CertificateView[] | undefined;
  certificateActions?: CertificateActions;
}) {
  const { t } = useTranslation();
  // The switch shows at once; main's settings follow.
  const [login, setLogin] = useState<{ from: boolean | undefined; on: boolean } | null>(null);
  const loginOn = login !== null && login.from === launchAtLogin ? login.on : launchAtLogin;
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>
      <Card>
        <CardHeader>
          <CardTitle id="appearance">{t('settings.appearance')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <span id="theme-label" className="text-sm font-medium">
            {t('settings.theme')}
          </span>
          <RadioGroup.Root
            aria-labelledby="theme-label"
            value={theme}
            onValueChange={(value) => onTheme(value as Theme)}
            className="flex flex-col gap-2"
          >
            {themes.map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <RadioGroup.Item
                  value={value}
                  className="flex size-4 items-center justify-center rounded-full border border-input data-[state=checked]:border-primary"
                >
                  <RadioGroup.Indicator className="size-2 rounded-full bg-primary" />
                </RadioGroup.Item>
                {t(themeLabel[value])}
              </label>
            ))}
          </RadioGroup.Root>
        </CardContent>
      </Card>
      {launchAtLogin !== undefined && onLaunchAtLogin && (
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.startup')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={loginOn ?? true}
                aria-describedby="launch-at-login-hint"
                onChange={(e) => {
                  setLogin({ from: launchAtLogin, on: e.target.checked });
                  onLaunchAtLogin(e.target.checked);
                }}
              />
              {t('settings.launchAtLogin', { appName: brand.displayName })}
            </label>
            <p id="launch-at-login-hint" className="ml-6 text-sm text-muted-foreground">
              {t('settings.launchAtLoginHint')}
            </p>
          </CardContent>
        </Card>
      )}
      {notifications && onNotifications && <NotificationsCard settings={notifications} onChange={onNotifications} />}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.language')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{t('settings.languageEnglish')}</p>
        </CardContent>
      </Card>
      <CertificatesCard
        count={certificates}
        certificates={certificateList}
        {...(certificateActions ? { actions: certificateActions } : {})}
      />
      {diagnostics && (
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.support')}</CardTitle>
            <CardDescription>{t('settings.supportBody')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ExportDiagnostics
              home={diagnostics.home}
              {...(diagnostics.actions ? { actions: diagnostics.actions } : {})}
            />
          </CardContent>
        </Card>
      )}
      {onRemoveEverything && <RemoveEverythingCard libraries={libraries} onRemove={onRemoveEverything} />}
      {updates ?? (
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.about')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t('settings.version', { appName: brand.displayName, version })}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function SettingsPage() {
  const settings = useDeviceQuery('settings');
  const appInfo = useDeviceQuery('appInfo');
  const setTheme = useDeviceCommand('setTheme');
  const instances = useDeviceQuery('instances');
  if (!settings.data || !appInfo.data) return null;
  return (
    <SettingsPageView
      theme={settings.data.theme}
      version={appInfo.data.version}
      certificates={settings.data.extraCertificateCount}
      certificateList={settings.data.extraCertificates}
      onTheme={(theme) => setTheme.mutate({ theme })}
      libraries={instances.data?.length ?? 0}
      onRemoveEverything={() => callDevice('removeEverything', {})}
      launchAtLogin={settings.data.launchAtLogin}
      onLaunchAtLogin={(on) => void callDevice('setLaunchAtLogin', { on }).catch(() => undefined)}
      notifications={settings.data.notifications}
      onNotifications={(next) => void callDevice('setNotifications', next).catch(() => undefined)}
      diagnostics={{ home: appInfo.data.homePath }}
      updates={<UpdatesCard />}
    />
  );
}
