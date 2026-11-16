// Fault points that test builds arm through the test API (TESTING.md §6, §9.3): a point can crash the process, throw,
// hang or wait. Production builds use `noFaults` instead and contain none of this.
import type { FaultPoints } from '../ports/faults.ts';

export type FaultAction = 'crash' | 'throw' | 'hang' | 'delay';

export class InjectedFault extends Error {
  constructor(point: string) {
    super(`fault injected at ${point}`);
    this.name = 'InjectedFault';
  }
}

interface Armed {
  action: FaultAction;
  skip: number;
  delayMs: number;
}

export class ArmedFaults implements FaultPoints {
  readonly hits: string[] = [];
  readonly #armed = new Map<string, Armed>();
  readonly #crash: (point: string) => void;
  readonly #wait: (ms: number) => Promise<void>;

  /** `crash` ends the process at once; `wait` waits on the process's timers. */
  constructor(deps: { crash: (point: string) => void; wait: (ms: number) => Promise<void> }) {
    this.#crash = deps.crash;
    this.#wait = deps.wait;
  }

  arm(point: string, action: FaultAction, options: { skip?: number; delayMs?: number } = {}): void {
    this.#armed.set(point, { action, skip: options.skip ?? 0, delayMs: options.delayMs ?? 0 });
  }

  async hit(point: string): Promise<void> {
    this.hits.push(point);
    const armed = this.#armed.get(point);
    if (!armed) return;
    if (armed.skip > 0) {
      armed.skip -= 1;
      return;
    }
    this.#armed.delete(point);
    switch (armed.action) {
      case 'crash':
        this.#crash(point);
        // If the process is still here, behave like a hang: nothing after the point may run.
        return new Promise(() => {});
      case 'throw':
        throw new InjectedFault(point);
      case 'hang':
        return new Promise(() => {});
      case 'delay':
        return this.#wait(armed.delayMs);
    }
  }
}
