// A sample device operation: a step in main, a step in the instance's worker, and a step in main again, each leaving
// a marker file. Killed at any of its points, the app finishes it at the next start (A1.19).
import type { DeviceOperationDef } from '../device/index.ts';
import type { FileSystem } from '../ports/fs.ts';
import type { AbsPath } from '../shared/brand.ts';
import type { PathFlavour } from '../shared/paths.ts';

export const SAMPLE_DEVICE_OPERATION = 'sample.device-operation';
export const SAMPLE_DEVICE_FOLDER = 'sample-device-operation';

async function mark(fs: FileSystem, paths: PathFlavour, dir: string, name: string, content: string): Promise<void> {
  await fs.mkdirp(dir as AbsPath);
  const file = paths.join(dir, name) as AbsPath;
  if ((await fs.lstat(file)) && (await fs.readText(file)) === content) return;
  await fs.writeTextAtomic(file, content);
}

/** The main-side definition. `dataRoot` is the app's data folder. */
export function sampleDeviceOperation(deps: {
  fs: FileSystem;
  paths: PathFlavour;
  dataRoot: string;
}): DeviceOperationDef {
  const dir = deps.paths.join(deps.dataRoot, SAMPLE_DEVICE_FOLDER);
  return {
    kind: SAMPLE_DEVICE_OPERATION,
    needsInstance: true,
    steps: [
      {
        name: 'main-before',
        where: 'main',
        run: ({ operation }) => mark(deps.fs, deps.paths, dir, 'main-before', operation.id),
      },
      { name: 'worker-part', where: 'worker' },
      {
        name: 'main-after',
        where: 'main',
        run: ({ operation }) => mark(deps.fs, deps.paths, dir, 'main-after', operation.id),
      },
    ],
    async result({ operation }) {
      const present = (await deps.fs.lstat(dir as AbsPath)) ? await deps.fs.list(dir as AbsPath) : [];
      return { operationId: operation.id, instanceId: operation.instanceId, mainMarkers: present };
    },
  };
}

/** The worker's part: a marker in the instance's data folder. */
export async function runSampleWorkerStep(
  deps: { fs: FileSystem; paths: PathFlavour; instanceDataFolder: string },
  operationId: string,
): Promise<void> {
  await mark(
    deps.fs,
    deps.paths,
    deps.paths.join(deps.instanceDataFolder, SAMPLE_DEVICE_FOLDER),
    'worker-part',
    operationId,
  );
}
