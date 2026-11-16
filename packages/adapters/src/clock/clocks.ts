// Clocks. Production uses the system clock. The test clock runs at normal speed but can jump ahead, firing every timer
// that falls due, and it starts at the same fixed time in every test (TESTING.md §6). Main, the workers and the fake
// hosts share it by sharing its offset.
import type { Clock, Random, Timer } from '@app/core';
import { randomBytes } from 'node:crypto';

interface Pending {
  readonly id: number;
  due: number;
  readonly fn: () => void;
  handle: ReturnType<typeof setTimeout> | undefined;
}

export class OffsetClock implements Clock {
  #offset: number;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;

  constructor(offsetMs = 0) {
    this.#offset = offsetMs;
  }

  /** A clock that reads `startTime` now and then runs normally. */
  static startingAt(startTime: number): OffsetClock {
    return new OffsetClock(startTime - Date.now());
  }

  get offsetMs(): number {
    return this.#offset;
  }

  now(): number {
    return Date.now() + this.#offset;
  }

  setTimer(ms: number, fn: () => void): Timer {
    const timer: Pending = { id: this.#nextId++, due: this.now() + Math.max(0, ms), fn, handle: undefined };
    this.#pending.set(timer.id, timer);
    this.#arm(timer);
    return { cancel: () => this.#cancel(timer.id) };
  }

  /** Jumps ahead: every timer that falls due fires now, in order. */
  advance(ms: number): number {
    if (ms < 0) throw new Error('the clock only moves forward');
    this.#offset += ms;
    this.#reschedule();
    return this.now();
  }

  /** Jumps to a time, forwards or back, and reschedules the timers. */
  setTime(time: number): number {
    this.setOffset(time - Date.now());
    return this.now();
  }

  /** Sets the offset, e.g. from main's clock, and reschedules the timers. */
  setOffset(offsetMs: number): void {
    this.#offset = offsetMs;
    this.#reschedule();
  }

  #arm(timer: Pending): void {
    const delay = Math.max(0, timer.due - this.now());
    timer.handle = setTimeout(() => {
      if (!this.#pending.delete(timer.id)) return;
      timer.fn();
    }, delay);
    timer.handle.unref?.();
  }

  #cancel(id: number): void {
    const timer = this.#pending.get(id);
    if (!timer) return;
    clearTimeout(timer.handle);
    this.#pending.delete(id);
  }

  #reschedule(): void {
    const now = this.now();
    const due = [...this.#pending.values()].filter((t) => t.due <= now).sort((a, b) => a.due - b.due || a.id - b.id);
    for (const timer of this.#pending.values()) {
      clearTimeout(timer.handle);
      if (timer.due > now) this.#arm(timer);
    }
    for (const timer of due) {
      if (!this.#pending.delete(timer.id)) continue;
      timer.fn();
    }
  }
}

export const nodeRandom: Random = {
  bytes: (count) => new Uint8Array(randomBytes(count)),
};
