// Ends a program together with the programs it started. A child that leads its own process group (`detached` on macOS
// and Linux) can be signalled as a group; Windows has no groups, and `taskkill /T` ends the tree.
import { type ChildProcess, spawn } from 'node:child_process';

/** Spawn option: the child leads its own process group, so `signalTree` reaches everything it starts. */
export const ownProcessGroup = process.platform !== 'win32';

/**
 * Signals a child and everything it started. A git fetch runs `git`, which starts `git remote-http` (or `ssh`) to talk to
 * the server; a login shell starts the programs of a shell profile. Signalling only the first leaves the others
 * running, holding the connection and the output pipes.
 */
export function signalTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () =>
      child.kill(),
    );
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}
