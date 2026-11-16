// How the worker supervisor restarts a crashed or hung worker (IMPLEMENTATION.md §2.1): with growing delays, and it
// gives up (the instance shows an error) when a worker keeps failing within a short time.

export interface RestartPolicy {
  /** Delay before each restart attempt; the last one repeats. */
  readonly delaysMs: readonly number[];
  /** Restarts within `windowMs` after which the supervisor gives up. */
  readonly maxRestarts: number;
  readonly windowMs: number;
  /** How often the supervisor pings a running worker, and how long it waits for the answer. */
  readonly pingIntervalMs: number;
  readonly pingTimeoutMs: number;
}

export const defaultRestartPolicy: RestartPolicy = {
  delaysMs: [1000, 2000, 5000, 10_000, 30_000],
  maxRestarts: 5,
  windowMs: 5 * 60_000,
  pingIntervalMs: 10_000,
  pingTimeoutMs: 10_000,
};

/** The delay before restart number `attempt` (0-based) among the recent ones. */
export function restartDelay(policy: RestartPolicy, attempt: number): number {
  const delays = policy.delaysMs;
  return delays[Math.min(Math.max(attempt, 0), delays.length - 1)] ?? 0;
}

/** The restarts that still count: those within the window before `now`. */
export function recentRestarts(policy: RestartPolicy, restartTimes: readonly number[], now: number): number[] {
  return restartTimes.filter((time) => now - time < policy.windowMs);
}

export function shouldGiveUp(policy: RestartPolicy, restartTimes: readonly number[], now: number): boolean {
  return recentRestarts(policy, restartTimes, now).length >= policy.maxRestarts;
}
