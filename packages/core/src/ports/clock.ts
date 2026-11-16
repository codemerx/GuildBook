// Time (IMPLEMENTATION.md §2.12): main, the workers and the fake hosts share one clock, which tests can move
// (TESTING.md §6). Timers follow it, so the 3-minute fetch runs when a test jumps 3 minutes ahead.
export interface Timer {
  cancel(): void;
}

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Calls `fn` once, `ms` from now on this clock. */
  setTimer(ms: number, fn: () => void): Timer;
}
