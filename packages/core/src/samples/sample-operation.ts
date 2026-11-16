// A sample durable operation: three steps that each write a file whose content depends on the earlier steps' state.
// Killed at any fault point, it must resume to exactly the same end state (A1.11).
import type { OperationDef } from '../operations/index.ts';
import type { FileSystem } from '../ports/fs.ts';
import type { AbsPath } from '../shared/brand.ts';
import type { PathFlavour } from '../shared/paths.ts';

export const SAMPLE_OPERATION = 'sample.operation';
export const sampleOperationSteps = ['write-a', 'write-b', 'write-c'] as const;

export interface SampleOperationParams {
  readonly dir: string;
  readonly [key: string]: string;
}

export interface SampleOperationState {
  readonly written: string[];
  readonly [key: string]: string[];
}

/** The content each step writes, given the steps finished before it. */
export function sampleContent(step: string, before: readonly string[]): string {
  return `${step}:${before.join(',')}`;
}

export function sampleOperation(
  fs: FileSystem,
  paths: PathFlavour,
): OperationDef<SampleOperationParams, SampleOperationState> {
  return {
    kind: SAMPLE_OPERATION,
    initialState: () => ({ written: [] }),
    steps: sampleOperationSteps.map((name) => ({
      name,
      async run({ params, state }) {
        const file = paths.join(params.dir, `${name}.txt`) as AbsPath;
        const content = sampleContent(name, state.written);
        // Idempotent: a crash after the write and before the journal update runs this again with the same state.
        const current = (await fs.lstat(file)) ? await fs.readText(file) : undefined;
        if (current !== content) await fs.writeTextAtomic(file, content);
        return { written: [...state.written, name] };
      },
    })),
  };
}
