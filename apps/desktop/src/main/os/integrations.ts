// OS integrations behind interfaces (IMPLEMENTATION.md §2.16, TESTING.md §3): main uses these, and test mode swaps in
// recording versions, so tests answer dialogs and see what would have reached the OS, and nothing real happens.

export interface TrayItem {
  readonly label: string;
  readonly enabled: boolean;
  readonly kind: 'normal' | 'separator' | 'instance';
  /** What a click does. */
  readonly action?:
    | { readonly type: 'open-instance'; readonly instanceId: string }
    | { readonly type: 'open' }
    | { readonly type: 'quit' };
}

export interface TrayMenu {
  readonly tooltip: string;
  /** The count on the icon: every library's red warnings (PLAN.md §3.8 S2); 0 shows none. */
  readonly count: number;
  readonly items: readonly TrayItem[];
}

export interface NotificationRequest {
  readonly kind: string;
  readonly title: string;
  readonly body: string;
}

export interface OsIntegrations {
  readonly dialogs: {
    /** A folder picker; null when the user cancels. */
    chooseFolder(options: { readonly purpose: string; readonly title: string }): Promise<string | null>;
    /** A file picker; null when the user cancels. */
    chooseFile(options: { readonly purpose: string; readonly title: string }): Promise<string | null>;
    /** Where to save a new file (Export diagnostics, Step 16); null when the user cancels. */
    saveFile(options: {
      readonly purpose: string;
      readonly title: string;
      readonly defaultName: string;
    }): Promise<string | null>;
  };
  readonly shell: {
    /** Opens a web page in the browser. Callers allow only http(s) (IMPLEMENTATION.md §2.12). */
    openExternal(url: string): Promise<void>;
    /** Moves a file or folder to the system's trash. */
    trashItem(path: string): Promise<void>;
  };
  readonly notifications: { show(notification: NotificationRequest): void };
  readonly tray: {
    /**
     * Whether the desktop shows tray icons. Linux desktops without a tray (GNOME without the AppIndicator extension)
     * get the window's small status view instead (PLAN.md §3.19).
     */
    available(): Promise<boolean>;
    show(menu: TrayMenu, onAction: (action: NonNullable<TrayItem['action']>) => void): void;
    destroy(): void;
  };
  readonly clipboard: { writeText(text: string): Promise<void> };
  readonly loginItem: {
    set(openAtLogin: boolean): void;
    /** This start came from the login item: the app opens only in the tray (PLAN.md §3.19). */
    openedAtLogin(): boolean;
  };
  /**
   * Registers the app for invite links in its own scheme (brand.protocolScheme, Step 15). From an AppImage it also
   * writes the `.desktop` file that makes the desktop open the links with it.
   */
  readonly protocol: { register(scheme: string): boolean };
}

/** The argument the login item starts the app with, where the OS can't say so itself (Windows). */
export const OPENED_AT_LOGIN_ARG = '--opened-at-login';
