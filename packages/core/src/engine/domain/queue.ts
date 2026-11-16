// The queue policy of an instance's engine, as pure functions (IMPLEMENTATION.md §2.4, ADR 0007):
// - user commands run before background ones (fetch, health check), in the order they were sent
// - a background command already waiting isn't queued twice; one that arrives while the same kind runs waits for one
//   more run, since the running one may have read its inputs before the change that asked for it
// - a user command arriving while a background command runs makes it yield

export interface QueuedItem {
  readonly type: string;
  readonly background: boolean;
}

/** The index of the item to run next, or -1 when the queue is empty. */
export function nextIndex(queue: readonly QueuedItem[]): number {
  const user = queue.findIndex((item) => !item.background);
  if (user >= 0) return user;
  return queue.length > 0 ? 0 : -1;
}

/**
 * The waiting background item a new background command of this type joins, if any. A running one is never joined: it
 * may have read the settings or files before the change that asked for the new run.
 */
export function coalesceTarget<T extends QueuedItem>(type: string, queue: readonly T[]): T | undefined {
  return queue.find((item) => item.background && item.type === type);
}

/** Whether a newly queued command should make the running one yield. */
export function shouldPreempt(running: QueuedItem | undefined, incoming: QueuedItem): boolean {
  return running !== undefined && running.background && !incoming.background;
}
