// Reconciliation: plan → preview → apply (IMPLEMENTATION.md §2.5, ADR 0008). Everything the app creates outside the
// library goes through a reconciler: the desired state is a pure function of its inputs, the actual state is the
// registry plus an inspection of each exact path, and the plan is the difference. A plan is plain data with a hash;
// apply recomputes it and refuses if the hash changed, so what the user confirmed is what happens. Each step commits
// its registry change on its own, so after a crash the registry matches the disk up to the last finished step.
import type { Clock } from '../../ports/clock.ts';
import type { FaultPoints } from '../../ports/faults.ts';
import type { Logger } from '../../ports/logger.ts';
import type { RegistryReader, RegistryRecord, RegistryWriter, Store } from '../../ports/store.ts';
import { AppError } from '../../shared/errors.ts';
import { hashValue } from '../../shared/hash.ts';

/** Something that needs the user's decision, e.g. a taken name (PLAN.md §3.8 S2). */
export interface Conflict {
  readonly key: string;
  readonly reason: string;
}

export interface PlanBody<A> {
  readonly actions: readonly A[];
  readonly conflicts: readonly Conflict[];
}

export interface Plan<A> extends PlanBody<A> {
  readonly kind: string;
  readonly hash: string;
}

export interface Reconciler<I, D, O, A> {
  /** The registry kind its records live under, e.g. "skill-link". */
  readonly kind: string;
  /** Pure: what should exist for these inputs. */
  desired(inputs: I): readonly D[];
  /** The actual state of every path the desired state or the registry names, and nothing else (PLAN.md §3.8). */
  observe(desired: readonly D[], registry: readonly RegistryRecord[]): Promise<readonly O[]>;
  /** Pure: the actions that turn the observed state into the desired one, and the conflicts. */
  plan(desired: readonly D[], observed: readonly O[]): PlanBody<A>;
  /** One idempotent step on disk, through the guarded file system. */
  apply(action: A, context: { readonly signal: AbortSignal | undefined }): Promise<void>;
  /** The registry change for the same step, committed right after it. */
  record(action: A, registry: RegistryReader & RegistryWriter, now: number): void;
  /**
   * A step failed in a way that blocks only its own path (no permission, a read-only or full folder). Returns the action
   * to record for that path instead, so the other steps still run and the path is reported; or null to stop the apply
   * with the error, as for every other failure.
   */
  failed?(action: A, error: unknown): A | null;
}

export function makePlan<A>(kind: string, body: PlanBody<A>): Plan<A> {
  return {
    kind,
    actions: body.actions,
    conflicts: body.conflicts,
    hash: hashValue({ kind, actions: body.actions, conflicts: body.conflicts }),
  };
}

/** Several reconcilers' plans shown and confirmed as one, with one hash (IMPLEMENTATION.md §2.5). */
export interface CombinedPlan {
  readonly plans: readonly Plan<unknown>[];
  readonly hash: string;
}

export function combinePlans(plans: readonly Plan<unknown>[]): CombinedPlan {
  return { plans, hash: hashValue(plans.map((plan) => [plan.kind, plan.hash])) };
}

export interface ApplyReport {
  readonly kind: string;
  readonly hash: string;
  readonly applied: number;
  readonly conflicts: readonly Conflict[];
}

export interface ApplyOptions {
  /** The hash of the plan the user confirmed. When it no longer matches, nothing is applied. */
  readonly expectedHash?: string;
  readonly signal?: AbortSignal;
  readonly onStep?: (done: number, total: number) => void;
}

/** Fault points inside apply (TESTING.md §9.3): before a step, after its disk change, after its commit. */
export function reconcileFaultPoints(kind: string, index: number) {
  return {
    before: `reconcile:${kind}:${index}:before`,
    applied: `reconcile:${kind}:${index}:applied`,
    after: `reconcile:${kind}:${index}:after`,
  };
}

export class ReconcileRunner {
  readonly #store: Store;
  readonly #faults: FaultPoints;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(deps: { store: Store; faults: FaultPoints; clock: Clock; logger: Logger }) {
    this.#store = deps.store;
    this.#faults = deps.faults;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
  }

  /** The plan for these inputs: what a preview shows. */
  async plan<I, D, O, A>(reconciler: Reconciler<I, D, O, A>, inputs: I): Promise<Plan<A>> {
    const desired = reconciler.desired(inputs);
    const registry = this.#store.read((tx) => tx.registry.list(reconciler.kind));
    const observed = await reconciler.observe(desired, registry);
    return makePlan(reconciler.kind, reconciler.plan(desired, observed));
  }

  /** Recomputes the plan, checks its hash, and applies it step by step. An apply step is never cancelled halfway. */
  async apply<I, D, O, A>(
    reconciler: Reconciler<I, D, O, A>,
    inputs: I,
    options: ApplyOptions = {},
  ): Promise<ApplyReport> {
    const plan = await this.plan(reconciler, inputs);
    if (options.expectedHash !== undefined && options.expectedHash !== plan.hash) {
      throw new AppError('plan.changed', { kind: plan.kind });
    }
    const total = plan.actions.length;
    for (const [index, action] of plan.actions.entries()) {
      if (options.signal?.aborted) {
        this.#logger.info('apply stopped between steps', { kind: plan.kind, done: index, total });
        throw new AppError('command.cancelled', { kind: plan.kind, done: index });
      }
      const points = reconcileFaultPoints(plan.kind, index);
      await this.#faults.hit(points.before);
      let recorded = action;
      try {
        await reconciler.apply(action, { signal: options.signal });
      } catch (error) {
        const instead = reconciler.failed?.(action, error) ?? null;
        if (instead === null) throw error;
        this.#logger.warn('a step could not be applied, its path is reported and the others go on', {
          kind: plan.kind,
          step: index,
          error: String(error).slice(0, 300),
        });
        recorded = instead;
      }
      await this.#faults.hit(points.applied);
      this.#store.write((tx) => reconciler.record(recorded, tx.registry, this.#clock.now()));
      options.onStep?.(index + 1, total);
      await this.#faults.hit(points.after);
    }
    return { kind: plan.kind, hash: plan.hash, applied: total, conflicts: plan.conflicts };
  }
}
