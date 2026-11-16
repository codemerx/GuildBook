// A durable operation's journal as pure state transitions (IMPLEMENTATION.md §2.6, ADR 0009).
import type { ErrorCode, Journal, JsonValue } from '@app/schemas';
import type { OperationId } from '../../shared/brand.ts';

export type JsonRecord = Readonly<Record<string, JsonValue>>;

export function newJournal(args: {
  id: OperationId;
  kind: string;
  params: JsonRecord;
  state: JsonRecord;
  now: string;
}): Journal {
  return {
    schemaVersion: 1,
    id: args.id,
    kind: args.kind,
    status: 'running',
    nextStep: 0,
    params: { ...args.params },
    state: { ...args.state },
    startedAt: args.now,
    updatedAt: args.now,
    error: null,
  };
}

/** Records that step `index` finished, with the values it left for later steps. */
export function stepDone(journal: Journal, index: number, patch: JsonRecord, now: string): Journal {
  if (journal.status !== 'running') throw new Error(`journal ${journal.id} is ${journal.status}`);
  if (index !== journal.nextStep)
    throw new Error(`journal ${journal.id}: step ${index} isn't next (${journal.nextStep})`);
  return { ...journal, nextStep: index + 1, state: { ...journal.state, ...patch }, updatedAt: now };
}

export function finished(journal: Journal, now: string): Journal {
  return { ...journal, status: 'done', updatedAt: now };
}

export function failed(journal: Journal, error: { code: ErrorCode; message: string }, now: string): Journal {
  return { ...journal, status: 'failed', error, updatedAt: now };
}

/** A failed journal run again from the step that failed. */
export function retried(journal: Journal): Journal {
  return journal.status === 'failed' ? { ...journal, status: 'running', error: null } : journal;
}

/** Only operations that were running when the app stopped are resumed; a failed one waits for a decision. */
export function isResumable(journal: Journal): boolean {
  return journal.status === 'running';
}

/** Fault points around each step (TESTING.md §9.3): before it runs, and after it ran but before the journal knows. */
export function operationFaultPoints(kind: string, step: string) {
  return { before: `op:${kind}:${step}:before`, after: `op:${kind}:${step}:after` };
}
