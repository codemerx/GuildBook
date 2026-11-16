// Forks one worker per instance as an Electron utility process (ADR 0003). The first message carries the worker's
// settings and its port to main.
import { brand } from '@app/brand';
import { electronPort } from '@app/ipc';
import { MessageChannelMain, type MessagePortMain, utilityProcess } from 'electron';
import type { LaunchedWorker, WorkerLauncher } from '../supervisor.ts';

export function utilityProcessLauncher(options: {
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly onOutput: (instanceId: string, line: string) => void;
}): WorkerLauncher {
  return {
    launch(init): LaunchedWorker {
      const child = utilityProcess.fork(options.entry, [], {
        serviceName: `${brand.displayName} worker`,
        stdio: 'pipe',
        env: { ...options.env },
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding('utf8');
        stream?.on('data', (chunk: string) => {
          for (const line of chunk.split('\n')) if (line.trim()) options.onOutput(init.instanceId, line);
        });
      }
      const { port1, port2 } = new MessageChannelMain();
      child.postMessage({ type: 'init', init }, [port1]);
      return {
        get pid() {
          return child.pid;
        },
        port: electronPort(port2),
        post: (message, transfer) => child.postMessage(message, (transfer ?? []) as MessagePortMain[]),
        kill: () => {
          // A crash, not a shutdown: the worker gets no chance to clean up.
          if (child.pid !== undefined) process.kill(child.pid, 'SIGKILL');
          else child.kill();
        },
        onExit: (listener) => child.on('exit', (code) => listener(code)),
      };
    },
  };
}

export function messageChannel() {
  const { port1, port2 } = new MessageChannelMain();
  return { mine: electronPort(port1), theirs: port2, raw: [port1, port2] as const };
}
