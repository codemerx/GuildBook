// macOS hands the app's links to the running app as `open-url` events, also before the app is ready (Step 15). The
// listener is installed at once; links that come before main's start is ready wait here for it.
import { app } from 'electron';

const early: string[] = [];
let deliver: ((url: string) => void) | undefined;

export function listenForOpenUrl(): void {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (deliver) deliver(url);
    else early.push(url);
  });
}

/** Main's start is ready for links: the ones that came early first. */
export function onOpenUrl(handler: (url: string) => void): void {
  deliver = handler;
  for (const url of early.splice(0)) handler(url);
}
