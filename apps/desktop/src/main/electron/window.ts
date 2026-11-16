// The app's single window (ADR 0004): sandboxed, context isolation, no Node (ADR 0003, 0021).
import { BrowserWindow } from 'electron';
import { brand } from '@app/brand';

export function createWindow(options: {
  readonly preload: string;
  readonly testMode: boolean;
  readonly devTools: boolean;
  readonly show: boolean;
  /**
   * Test runs on macOS (TESTING.md §3): shown without taking the focus, fully transparent, and clicks go through it,
   * so the person at the computer neither sees it nor loses the keyboard.
   */
  readonly inactive: boolean;
  /** The full app, or the small status view on a desktop without a tray (PLAN.md §3.19). */
  readonly mode?: 'full' | 'status';
}): BrowserWindow {
  const size = windowSizes(options.mode ?? 'full', options.testMode);
  const window = new BrowserWindow({
    ...size.content,
    minWidth: size.min.width,
    minHeight: size.min.height,
    show: false,
    title: brand.displayName,
    // Test mode always uses the same size, so screenshots compare (TESTING.md §3).
    resizable: !options.testMode,
    useContentSize: true,
    webPreferences: {
      preload: options.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: options.devTools,
    },
  });
  if (options.inactive) hideFromScreen(window);
  if (options.show) window.once('ready-to-show', () => (options.inactive ? window.showInactive() : window.show()));
  return window;
}

/** The full window, and the status view: as small as its list of libraries needs. */
function windowSizes(mode: 'full' | 'status', testMode: boolean) {
  return mode === 'status'
    ? { content: { width: 400, height: 480 }, min: { width: 320, height: 360 } }
    : { content: { width: testMode ? 1280 : 1200, height: 800 }, min: { width: 900, height: 600 } };
}

/** Turns the window into the full app or the status view. */
export function sizeWindow(window: BrowserWindow, mode: 'full' | 'status', testMode: boolean): void {
  const size = windowSizes(mode, testMode);
  window.setMinimumSize(size.min.width, size.min.height);
  window.setContentSize(size.content.width, size.content.height);
}

/**
 * A test window the person at the computer never sees (TESTING.md §3). It's still shown, so Chromium paints it and
 * animation frames run as usual; Playwright reads the page itself, so screenshots don't depend on the window's opacity.
 * It never comes forward: no focus, no shadow, not in the window cycle, and the mouse goes to the window below.
 */
export function hideFromScreen(window: BrowserWindow): void {
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  window.setHasShadow(false);
  window.setFocusable(false);
  window.setSkipTaskbar(true);
  window.excludedFromShownWindowsMenu = true;
}
