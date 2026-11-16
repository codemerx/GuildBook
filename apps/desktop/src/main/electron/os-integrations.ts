// The real OS integrations (IMPLEMENTATION.md §2.16). Test mode never uses these: it uses RecordingOs.
import { app, clipboard, dialog, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { NodeProcessRunner } from '@app/adapters';
import { OPENED_AT_LOGIN_ARG, type OsIntegrations, type TrayItem, type TrayMenu } from '../os/integrations.ts';

export function electronOs(options: {
  readonly trayIcon: string;
  /** An AppImage's own link handler (Step 15): set when the app runs from one. */
  readonly appImageLinks?: (scheme: string) => void;
}): OsIntegrations {
  let tray: Tray | undefined;
  return {
    dialogs: {
      async chooseFolder({ title }) {
        const result = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      async chooseFile({ title }) {
        const result = await dialog.showOpenDialog({ title, properties: ['openFile'] });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      async saveFile({ title, defaultName }) {
        const result = await dialog.showSaveDialog({ title, defaultPath: defaultName });
        return result.canceled ? null : (result.filePath ?? null);
      },
    },
    shell: {
      openExternal: (url) => shell.openExternal(url),
      trashItem: (path) => shell.trashItem(path),
    },
    notifications: {
      show({ title, body }) {
        if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
      },
    },
    tray: {
      available: () => (process.platform === 'linux' ? linuxHasTray() : Promise.resolve(true)),
      show(menu: TrayMenu, onAction: (action: NonNullable<TrayItem['action']>) => void) {
        if (!tray) {
          const icon = nativeImage.createFromPath(options.trayIcon);
          icon.setTemplateImage(true);
          tray = new Tray(icon);
        }
        tray.setToolTip(menu.tooltip);
        // macOS shows the count beside the icon; elsewhere the tooltip says it.
        if (process.platform === 'darwin') tray.setTitle(menu.count > 0 ? String(menu.count) : '');
        tray.setContextMenu(
          Menu.buildFromTemplate(
            menu.items.map((item) =>
              item.kind === 'separator'
                ? { type: 'separator' as const }
                : {
                    label: item.label,
                    enabled: item.enabled,
                    click: () => {
                      if (item.action) onAction(item.action);
                    },
                  },
            ),
          ),
        );
      },
      destroy() {
        tray?.destroy();
        tray = undefined;
      },
    },
    clipboard: { writeText: (text) => clipboard.writeText(text) },
    // Linux has no login items in Electron: composition adds the XDG autostart entry (desktop-entry.ts).
    loginItem: {
      set: (openAtLogin) => app.setLoginItemSettings({ openAtLogin, args: [OPENED_AT_LOGIN_ARG] }),
      openedAtLogin: () =>
        process.argv.includes(OPENED_AT_LOGIN_ARG) ||
        (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin),
    },
    protocol: {
      register: (scheme) => {
        if (options.appImageLinks) {
          options.appImageLinks(scheme);
          return true;
        }
        return app.setAsDefaultProtocolClient(scheme);
      },
    },
  };
}

/**
 * Whether a Linux desktop shows tray icons: Electron's tray is a StatusNotifierItem, which shows only where a
 * StatusNotifierWatcher runs on the session bus (KDE, and GNOME with the AppIndicator extension). Without `gdbus`, the
 * app can't tell, and keeps the tray.
 */
async function linuxHasTray(): Promise<boolean> {
  const result = await new NodeProcessRunner()
    .run(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.DBus',
        '--object-path',
        '/org/freedesktop/DBus',
        '--method',
        'org.freedesktop.DBus.NameHasOwner',
        'org.kde.StatusNotifierWatcher',
      ],
      { timeoutMs: 3000 },
    )
    .catch(() => undefined);
  return result?.code !== 0 || !result.stdout.includes('false');
}
