// The renderer's security baseline (ADR 0021, IMPLEMENTATION.md §2.12): navigation and new windows are blocked,
// permission requests denied, webviews refused. Links open in the browser only if they're http(s) URLs.
import { app, session, type WebContents } from 'electron';
import { isWebUrl } from '../device-api.ts';

export function hardenWebContents(options: {
  readonly allowedOrigin: string;
  readonly openExternal: (url: string) => void;
}): void {
  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(options.allowedOrigin)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!url.startsWith(options.allowedOrigin)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) options.openExternal(url);
      return { action: 'deny' };
    });
  });
}

/** Port 9 (discard) on the loopback address: a dictionary download fails at once, and leaves the computer never. */
export const NO_DICTIONARIES = 'http://127.0.0.1:9/';

/** The default session, before anything else uses it: no spellchecker, and every permission denied. */
export function hardenSession(): void {
  const ses = session.defaultSession;
  // Electron's spellchecker downloads its dictionaries from Google on Windows and Linux as soon as the session
  // exists, and the app talks to nothing but the user's hosts (PLAN.md §3.19). On macOS it uses the system's.
  // Switching it off can come after a download started: the Step 18 packaging run saw one request to Google's
  // dictionary host from the production build (A18.5). So a download goes to a loopback port where nothing answers.
  ses.setSpellCheckerDictionaryDownloadURL(NO_DICTIONARIES);
  ses.setSpellCheckerLanguages([]);
  ses.setSpellCheckerEnabled(false);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
}

/** Test mode: all traffic goes through the recording proxy, loopback included (TESTING.md §3). */
export async function routeThroughProxy(proxy: string): Promise<void> {
  await session.defaultSession.setProxy({ proxyRules: proxy, proxyBypassRules: '<-loopback>' });
}
