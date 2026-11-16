// Recording OS integrations for test mode (TESTING.md §3): dialogs answer from a queue the test fills, and everything
// else is recorded for the test API's `recorded()` (TESTING.md §6).
import type { NotificationRequest, OsIntegrations, TrayItem, TrayMenu } from './integrations.ts';

export interface RecordedOs {
  readonly openedLinks: string[];
  readonly notifications: NotificationRequest[];
  tray: TrayMenu;
  readonly clipboard: string[];
  loginItem: { openAtLogin: boolean } | null;
  readonly trashed: string[];
  readonly protocolRegistrations: string[];
  readonly dialogs: Array<{ kind: string; purpose: string; answer: string | null }>;
}

export class RecordingOs implements OsIntegrations {
  /**
   * `openedAtLogin`: the test started the app as the login item would (A15.8). `trayAvailable: false`: the desktop has
   * no tray (Step 17).
   */
  constructor(options: { readonly openedAtLogin?: boolean; readonly trayAvailable?: boolean } = {}) {
    this.#openedAtLogin = options.openedAtLogin ?? false;
    this.#trayAvailable = options.trayAvailable ?? true;
  }

  readonly recorded: RecordedOs = {
    openedLinks: [],
    notifications: [],
    tray: { tooltip: '', count: 0, items: [] },
    clipboard: [],
    loginItem: null,
    trashed: [],
    protocolRegistrations: [],
    dialogs: [],
  };
  readonly #answers: Array<string | null> = [];
  readonly #openedAtLogin: boolean;
  readonly #trayAvailable: boolean;
  #trayAction: ((action: NonNullable<TrayItem['action']>) => void) | undefined;

  /** Queues answers for the next dialogs (TESTING.md §6 dialogs.answer). */
  answer(...answers: Array<string | null>): void {
    this.#answers.push(...answers);
  }

  /** Clicks a tray item, as a test would. */
  clickTray(label: string): boolean {
    const item = this.recorded.tray.items.find((i) => i.label === label);
    if (!item?.action || !item.enabled || !this.#trayAction) return false;
    this.#trayAction(item.action);
    return true;
  }

  readonly dialogs = {
    chooseFolder: async (options: { purpose: string; title: string }) => {
      // An unanswered dialog is cancelled, as a person closing it would.
      const answer = this.#answers.shift() ?? null;
      this.recorded.dialogs.push({ kind: 'chooseFolder', purpose: options.purpose, answer });
      return answer;
    },
    chooseFile: async (options: { purpose: string; title: string }) => {
      const answer = this.#answers.shift() ?? null;
      this.recorded.dialogs.push({ kind: 'chooseFile', purpose: options.purpose, answer });
      return answer;
    },
    saveFile: async (options: { purpose: string; title: string; defaultName: string }) => {
      const answer = this.#answers.shift() ?? null;
      this.recorded.dialogs.push({ kind: 'saveFile', purpose: options.purpose, answer });
      return answer;
    },
  };

  readonly shell = {
    openExternal: async (url: string) => void this.recorded.openedLinks.push(url),
    trashItem: async (path: string) => void this.recorded.trashed.push(path),
  };

  readonly notifications = { show: (n: NotificationRequest) => void this.recorded.notifications.push(n) };

  readonly tray = {
    available: async () => this.#trayAvailable,
    show: (menu: TrayMenu, onAction: (action: NonNullable<TrayItem['action']>) => void) => {
      this.recorded.tray = menu;
      this.#trayAction = onAction;
    },
    destroy: () => {
      this.recorded.tray = { tooltip: '', count: 0, items: [] };
      this.#trayAction = undefined;
    },
  };

  readonly clipboard = { writeText: async (text: string) => void this.recorded.clipboard.push(text) };
  readonly loginItem = {
    set: (openAtLogin: boolean) => void (this.recorded.loginItem = { openAtLogin }),
    // A test starts the app as the login item would, with the same argument.
    openedAtLogin: () => this.#openedAtLogin,
  };
  readonly protocol = {
    register: (scheme: string) => {
      this.recorded.protocolRegistrations.push(scheme);
      return true;
    },
  };
}
