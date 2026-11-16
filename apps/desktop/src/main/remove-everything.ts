// Settings → Remove everything this app set up, and the Windows uninstaller's "Remove all connections the app created"
// (PLAN.md §3.8 S12, IMPLEMENTATION.md §2.6): a device operation that removes every instance the way [Remove] does,
// keeping the library folders. Each instance's removal is a device operation of its own, recorded in device.json, so
// a crash at any point resumes at the next start: this operation goes on with the instances that are left, and a
// removal that was under way resumes as itself. Setups that never finished are cancelled first.
import { AppError, type DeviceOperationDef, type DeviceOperationRunner, type Logger } from '@app/core';
import { REMOVE_INSTANCE } from './remove-instance.ts';

export const REMOVE_EVERYTHING = 'remove-everything';

export function removeEverythingOperation(deps: {
  /** The runner this operation is registered with: each instance's removal runs on it. */
  readonly runner: () => DeviceOperationRunner;
  /** Cancels every setup in progress: what it downloaded goes (A4.11). */
  readonly cancelSetups: () => Promise<void>;
  readonly logger: Logger;
}): DeviceOperationDef {
  return {
    kind: REMOVE_EVERYTHING,
    needsInstance: false,
    steps: [
      { name: 'cancel-setups', where: 'main', run: () => deps.cancelSetups() },
      {
        name: 'remove-instances',
        where: 'main',
        run: async (context) => {
          for (const record of [...context.registry.file.instances]) {
            // A removal under way when the app stopped resumes as itself (DeviceOperationRunner.resumeAll).
            if (record.status === 'removing') continue;
            const outcome = await deps
              .runner()
              .start(REMOVE_INSTANCE, { instanceId: record.id, params: { deleteFolder: false } });
            if (outcome.status === 'failed') {
              throw new AppError('operation.failed', { kind: REMOVE_INSTANCE, code: outcome.error.code });
            }
            deps.logger.info('removed with everything else', { instance: record.id });
          }
        },
      },
    ],
    async result({ registry }) {
      return { left: registry.file.instances.length };
    },
  };
}
