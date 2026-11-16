// Deterministic randomness for test mode (TESTING.md §1 "Deterministic"): the same seed gives the same ids. Each app
// launch and each worker start gets its own seed, so a restarted worker never repeats an id it already used.
import type { Random } from '../ports/random.ts';

/** A 32-bit seed from any text (FNV-1a). */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0 || 1;
}

export class SeededRandom implements Random {
  #state: number;

  constructor(seed = 1) {
    this.#state = seed >>> 0 || 1;
  }

  bytes(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      // xorshift32
      let x = this.#state;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this.#state = x >>> 0;
      out[i] = this.#state >>> 24;
    }
    return out;
  }
}
