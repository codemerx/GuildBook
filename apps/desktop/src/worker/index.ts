// The worker's entry point in the app: an Electron utility process whose parent is main (ADR 0003).
import { electronPort } from '@app/ipc';
import { startWorker } from './worker.ts';

const parent = process.parentPort;

startWorker(
  {
    onMessage: (listener) =>
      parent.on('message', (event) =>
        listener({ data: event.data, ports: event.ports.map((port) => electronPort(port)) }),
      ),
    exit: (code) => process.exit(code),
  },
  { testHooks: __TEST_HOOKS__ },
).catch((error: unknown) => {
  process.stderr.write(
    `worker failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
