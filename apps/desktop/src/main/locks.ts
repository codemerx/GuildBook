// Device-wide locks (IMPLEMENTATION.md §2.13 rule 8): files shared by instances (a repo's exclude file, an instruction
// file with several blocks) are changed only while holding a lock. Waiters get it in order; a worker that exits
// releases everything it held, so a crash never leaves a lock behind (A1.12).
import { AppError, randomToken, type Random } from '@app/core';

interface Waiter {
  readonly holder: string;
  readonly token: string;
  readonly grant: () => void;
}

interface LockState {
  owner: { holder: string; token: string };
  queue: Waiter[];
}

export interface LockView {
  readonly name: string;
  readonly holder: string;
  readonly waiting: readonly string[];
}

export class LockService {
  readonly #locks = new Map<string, LockState>();
  readonly #random: Random;

  constructor(random: Random) {
    this.#random = random;
  }

  /** Waits for the lock; resolves with a token that releases it. */
  acquire(name: string, holder: string, signal?: AbortSignal): Promise<string> {
    const token = randomToken(this.#random, 16);
    const state = this.#locks.get(name);
    if (!state) {
      this.#locks.set(name, { owner: { holder, token }, queue: [] });
      return Promise.resolve(token);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { holder, token, grant: () => resolve(token) };
      state.queue.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          const current = this.#locks.get(name);
          if (!current) return;
          const index = current.queue.indexOf(waiter);
          if (index < 0) return;
          current.queue.splice(index, 1);
          reject(new AppError('lock.cancelled', { name }));
        },
        { once: true },
      );
    });
  }

  /** Releases the lock if `token` holds it; a stale token does nothing. */
  release(name: string, token: string): void {
    const state = this.#locks.get(name);
    if (!state || state.owner.token !== token) return;
    this.#handOver(name, state);
  }

  /** Releases every lock a holder has and drops its waiting requests: its worker exited. */
  releaseAll(holder: string): void {
    for (const [name, state] of [...this.#locks]) {
      state.queue = state.queue.filter((waiter) => waiter.holder !== holder);
      if (state.owner.holder === holder) this.#handOver(name, state);
    }
  }

  view(): LockView[] {
    return [...this.#locks].map(([name, state]) => ({
      name,
      holder: state.owner.holder,
      waiting: state.queue.map((waiter) => waiter.holder),
    }));
  }

  #handOver(name: string, state: LockState): void {
    const next = state.queue.shift();
    if (!next) {
      this.#locks.delete(name);
      return;
    }
    state.owner = { holder: next.holder, token: next.token };
    next.grant();
  }
}
