// Domain events report what happened; they feed the renderer's cache, the activity log, the tray and notifications
// (IMPLEMENTATION.md §2.4). Events are named in the past tense (§3.2).

export interface DomainEvent {
  readonly type: string;
  /** Epoch milliseconds from the Clock port. */
  readonly at: number;
  readonly correlationId?: string;
}

/** Synchronous publish/subscribe. A failing subscriber is reported and never stops the others. */
export class EventBus<E> {
  readonly #listeners = new Set<(event: E) => void>();
  readonly #onListenerError: (error: unknown) => void;

  constructor(onListenerError: (error: unknown) => void = () => {}) {
    this.#onListenerError = onListenerError;
  }

  subscribe(listener: (event: E) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: E): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.#onListenerError(error);
      }
    }
  }

  get size(): number {
    return this.#listeners.size;
  }
}
