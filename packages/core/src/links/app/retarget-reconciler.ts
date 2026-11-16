// The retarget reconciler (PLAN.md §3.9 step 5): its I/O parts. `observe` reads each registered link's target, and
// nothing else; `apply` checks the link still points at the old place before it swaps it, so a step repeated after a
// crash does no harm, and a link that changed since the plan stops the apply (`plan.changed`).
import { SKILL_LINK_KIND } from '@app/schemas';
import type { Reconciler } from '../../engine/index.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import {
  desiredRetargets,
  planRetargets,
  type RetargetAction,
  type RetargetDesired,
  type RetargetInputs,
  type RetargetObserved,
} from '../domain/retarget.ts';
import type { LinkStrategy } from './link-strategy.ts';
import { readRow } from './skill-link-reconciler.ts';

export function retargetReconciler(deps: {
  readonly fs: FileSystem;
  readonly strategy: LinkStrategy;
  readonly paths: PathFlavour;
}): Reconciler<RetargetInputs, RetargetDesired, RetargetObserved, RetargetAction> {
  const { fs, strategy, paths } = deps;
  const target = async (dest: string): Promise<string | null> => {
    const entry = await fs.lstat(dest as AbsPath);
    if (entry?.kind !== 'link') return null;
    return (await strategy.readTarget(dest as AbsPath)) ?? null;
  };
  return {
    kind: SKILL_LINK_KIND,
    desired: (inputs) => desiredRetargets(inputs, paths),
    async observe(desired) {
      const observed: RetargetObserved[] = [];
      for (const d of desired) observed.push({ dest: d.dest, target: await target(d.dest) });
      return observed;
    },
    plan: (desired, observed) => planRetargets(desired, observed, paths),
    async apply(action) {
      const now = await target(action.dest);
      if (now !== null && paths.same(paths.normalize(now), action.to)) return;
      if (now === null || !paths.same(paths.normalize(now), action.from)) {
        throw new AppError('plan.changed', { path: action.dest });
      }
      await strategy.retarget(action.dest as AbsPath, action.to as AbsPath);
    },
    record(action, registry, now) {
      // The row keeps the library item, not the target (PLAN.md §3.5): only its check time changes.
      const row = readRow(registry.get(SKILL_LINK_KIND, action.dest));
      if (row) registry.put(SKILL_LINK_KIND, action.dest, { ...row, lastVerifiedAt: now }, now);
    },
  };
}
