// Timers become commands (IMPLEMENTATION.md §2.4): e.g. the fetch and the health check every 3 minutes. The timers run
// on the Clock port, so a test that moves the clock fires them (TESTING.md §6).
import type { Clock, Timer } from '../../ports/clock.ts';

export class Scheduler {
  readonly #clock: Clock;
  readonly #active = new Set<() => void>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Runs `task` every `intervalMs`, first after one interval. Returns a function that stops it. */
  every(intervalMs: number, task: () => void): () => void {
    // A cancelled timer never fires, so stopping only cancels the one that's armed.
    let timer: Timer;
    const arm = () => {
      timer = this.#clock.setTimer(intervalMs, () => {
        arm();
        task();
      });
    };
    arm();
    const stop = () => {
      timer.cancel();
      this.#active.delete(stop);
    };
    this.#active.add(stop);
    return stop;
  }

  stopAll(): void {
    for (const stop of [...this.#active]) stop();
  }
}
