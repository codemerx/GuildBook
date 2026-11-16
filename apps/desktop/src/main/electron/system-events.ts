// Network and power events for the workers (IMPLEMENTATION.md §2.4): the fetch runs when the network comes back and
// after wake. Electron has no online/offline event in main, so main checks every 30 seconds.
import { net, powerMonitor } from 'electron';

export function watchSystem(options: {
  readonly onPower: (state: 'suspend' | 'resume') => void;
  readonly onOnline: (online: boolean) => void;
  readonly every: (ms: number, task: () => void) => () => void;
}): () => void {
  powerMonitor.on('suspend', () => options.onPower('suspend'));
  powerMonitor.on('resume', () => options.onPower('resume'));
  let online = net.isOnline();
  options.onOnline(online);
  return options.every(30_000, () => {
    const now = net.isOnline();
    if (now !== online) {
      online = now;
      options.onOnline(now);
    }
  });
}
