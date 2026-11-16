// Removing an instance (IMPLEMENTATION.md §2.6, PLAN.md §3.8 S12): a device operation, recorded in device.json before
// its first step, so it resumes at the next start whichever process crashed (A4.15).
//   1. main:   the instance's status becomes `removing`
//   2. worker: everything the app made outside the library goes, through each reconciler (a reconcile to an empty
//              desired state); the steps that add such files (5–8) add their reconcilers to it
//   3. main:   the worker stops
//   4. main:   what's left in the instance's trash goes to the system's trash, and the library folder too if the user
//              chose to delete it (it's kept by default)
//   5. main:   the data folder, the instance's secrets and its device.json entry go
import type { DataLayout, DeviceOperationDef, DeviceStepContext, FileSystem, Logger } from '@app/core';
import type { OsIntegrations } from './os/integrations.ts';
import type { SecretsService } from './secrets.ts';
import type { WorkerSupervisor } from './supervisor.ts';

export const REMOVE_INSTANCE = 'remove-instance';
/** The worker's step: a reconcile of everything outside the library to an empty desired state. */
export const REMOVE_FILES_STEP = 'remove-files';

export function removeInstanceOperation(deps: {
  readonly fs: FileSystem;
  readonly layout: DataLayout;
  readonly supervisor: WorkerSupervisor;
  readonly secrets: SecretsService;
  readonly os: OsIntegrations;
  readonly logger: Logger;
}): DeviceOperationDef {
  const instance = (context: DeviceStepContext) => {
    const id = context.operation.instanceId ?? '';
    return { id, record: context.registry.file.instances.find((i) => i.id === id) };
  };
  return {
    kind: REMOVE_INSTANCE,
    needsInstance: true,
    steps: [
      {
        name: 'mark-removing',
        where: 'main',
        run: async (context) => {
          const { id } = instance(context);
          await context.registry.update((file) => {
            const target = file.instances.find((i) => i.id === id);
            if (target) target.status = 'removing';
          });
        },
      },
      { name: REMOVE_FILES_STEP, where: 'worker' },
      {
        name: 'stop-worker',
        where: 'main',
        run: async (context) => deps.supervisor.stop(instance(context).id),
      },
      {
        name: 'trash',
        where: 'main',
        run: async (context) => {
          const { id, record } = instance(context);
          const trash = deps.layout.instance(id).trash;
          if ((await deps.fs.lstat(trash)) && (await deps.fs.list(trash)).length > 0)
            await deps.os.shell.trashItem(trash);
          // Main doesn't read libraries (IMPLEMENTATION.md §2.1): a folder that's gone already, after a crash in this step,
          // fails to move and is logged.
          if (context.operation.params.deleteFolder === true && record) {
            await deps.os.shell
              .trashItem(record.libraryPath)
              .catch((error: unknown) =>
                deps.logger.warn('the library folder could not be moved to the trash', { error: String(error) }),
              );
          }
        },
      },
      {
        name: 'forget',
        where: 'main',
        run: async (context) => {
          const { id } = instance(context);
          const data = deps.layout.instance(id).root;
          if (await deps.fs.lstat(data)) await deps.fs.removeTree(data);
          await deps.secrets.deletePrefix(`${id}/`);
          await context.registry.update((file) => {
            file.instances = file.instances.filter((i) => i.id !== id);
          });
        },
      },
    ],
    async result({ operation }) {
      return { instanceId: operation.instanceId, deletedFolder: operation.params.deleteFolder === true };
    },
  };
}
