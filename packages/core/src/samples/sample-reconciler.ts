// A sample reconciler: it keeps one file per wanted name in a folder, and registers each file it created. It only
// ever changes files it registered; a file it didn't create is a conflict, never overwritten (PLAN.md §3.8).
import type { PlanBody, Reconciler } from '../engine/index.ts';
import type { FileSystem } from '../ports/fs.ts';
import type { RegistryRecord } from '../ports/store.ts';
import type { AbsPath } from '../shared/brand.ts';
import type { PathFlavour } from '../shared/paths.ts';

export const SAMPLE_RECONCILER = 'sample';

export interface SampleInputs {
  readonly dir: string;
  readonly names: readonly string[];
}

export interface SampleDesired {
  readonly path: string;
  readonly content: string;
}

export interface SampleObserved {
  readonly path: string;
  readonly content: string | null;
  readonly registered: boolean;
}

export type SampleAction =
  | { readonly op: 'create' | 'rewrite' | 'adopt'; readonly path: string; readonly content: string }
  | { readonly op: 'remove' | 'forget'; readonly path: string };

export function sampleFileContent(name: string): string {
  return `sample:${name}`;
}

export function sampleReconciler(
  fs: FileSystem,
  paths: PathFlavour,
): Reconciler<SampleInputs, SampleDesired, SampleObserved, SampleAction> {
  return {
    kind: SAMPLE_RECONCILER,

    desired(inputs) {
      return [...new Set(inputs.names)]
        .sort()
        .map((name) => ({ path: paths.join(inputs.dir, `${name}.txt`), content: sampleFileContent(name) }));
    },

    async observe(desired, registry: readonly RegistryRecord[]) {
      const registered = new Set(registry.map((record) => record.key));
      const wanted = [...new Set([...desired.map((d) => d.path), ...registered])].sort();
      const observed: SampleObserved[] = [];
      for (const path of wanted) {
        const entry = await fs.lstat(path as AbsPath);
        const content = entry?.kind === 'file' ? await fs.readText(path as AbsPath) : entry ? '' : null;
        observed.push({ path, content, registered: registered.has(path) });
      }
      return observed;
    },

    plan(desired, observed): PlanBody<SampleAction> {
      const byPath = new Map(observed.map((o) => [o.path, o]));
      const actions: SampleAction[] = [];
      const conflicts: Array<{ key: string; reason: string }> = [];
      for (const want of desired) {
        const seen = byPath.get(want.path);
        if (!seen || seen.content === null) actions.push({ op: 'create', path: want.path, content: want.content });
        else if (seen.content !== want.content) {
          if (seen.registered) actions.push({ op: 'rewrite', path: want.path, content: want.content });
          else conflicts.push({ key: want.path, reason: 'taken' });
        } else if (!seen.registered) actions.push({ op: 'adopt', path: want.path, content: want.content });
      }
      const wanted = new Set(desired.map((d) => d.path));
      for (const seen of observed) {
        if (!seen.registered || wanted.has(seen.path)) continue;
        actions.push({ op: seen.content === null ? 'forget' : 'remove', path: seen.path });
      }
      return { actions, conflicts };
    },

    async apply(action) {
      const path = action.path as AbsPath;
      switch (action.op) {
        case 'create':
        case 'rewrite':
          await fs.writeTextAtomic(path, action.content);
          return;
        case 'remove':
          if (await fs.lstat(path)) await fs.remove(path);
          return;
        case 'adopt':
        case 'forget':
          return;
      }
    },

    record(action, registry, now) {
      switch (action.op) {
        case 'remove':
        case 'forget':
          registry.delete(SAMPLE_RECONCILER, action.path);
          return;
        case 'create':
        case 'rewrite':
        case 'adopt':
          registry.put(SAMPLE_RECONCILER, action.path, { content: action.content }, now);
          return;
      }
    },
  };
}
