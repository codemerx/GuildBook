// The instruction reconciler's plan (IMPLEMENTATION.md §2.5, PLAN.md §3.12): the difference between the artifacts the
// strategies want and what's on disk, with the registry saying what the app wrote. Pure. A plan carries fingerprints,
// never the user's text: apply reads each file again under the device lock, checks the fingerprint the plan saw, and
// changes only the app's part.
//
// The rules:
// - What the app wrote and nobody changed follows the library: it's refreshed, and removed when it's no longer wanted.
// - A change inside a block or an owned file is the user's (an agent may have improved the text): it's never refreshed
//   or removed without the user's answer, "Bring this change into the library" or "Discard it" (A7.6).
// - A block whose markers are broken is left alone and reported: the app can't tell its text from the user's.
import {
  configEntryState,
  type InstructionArtifact,
  type InstructionRole,
  type InstructionRow,
  type InstructionStatus,
} from '@app/schemas';
import type { Conflict, PlanBody } from '../../engine/index.ts';
import type { DesiredInstruction } from './artifacts.ts';
import { textFingerprint } from './artifacts.ts';
import { blockInside, findBlock, lineBreakOf } from './blocks.ts';

/** What is at an artifact's path. A link there is followed: `written` is the file it points to (PLAN.md §3.12). */
export type ObservedFile =
  | { readonly kind: 'missing' }
  /** A folder, or a link that leads nowhere the app may follow. */
  | { readonly kind: 'other' }
  | { readonly kind: 'file'; readonly text: string };

export interface InstructionObserved {
  readonly key: string;
  /** The file reads and writes go to: the key itself, or the end of the links there. */
  readonly written: string;
  readonly file: ObservedFile;
  readonly row: InstructionRow | null;
}

/** The user's answer to an edited artifact (PLAN.md §3.12). */
export type InstructionDecision = 'bring-in' | 'discard';

/** The row a step leaves, without the fields only apply knows. */
export interface RowDraft {
  readonly artifact: InstructionArtifact;
  readonly role: InstructionRole;
  readonly tools: readonly string[];
  readonly source: string | null;
  /** A config entry's value. */
  readonly entry: string | null;
  readonly status: InstructionStatus;
}

interface Base {
  readonly key: string;
  readonly written: string;
}

export type InstructionAction =
  /** Creates or refreshes an owned file. `expect` is the fingerprint of the file now (null: it's not there). */
  | (Base & {
      readonly op: 'write-file';
      readonly content: string;
      readonly expect: string | null;
      readonly row: RowDraft;
    })
  /** Adds the block at the end of the file (`expect` null), or replaces the text inside it. */
  | (Base & {
      readonly op: 'put-block';
      readonly content: string;
      readonly expect: string | null;
      readonly prefix: string;
      readonly row: RowDraft;
    })
  | (Base & { readonly op: 'add-entry'; readonly content: string; readonly row: RowDraft })
  /** Removes an owned file; an edited one goes to the trash. */
  | (Base & { readonly op: 'remove-file'; readonly expect: string; readonly trash: boolean })
  /** Removes the block and the line break the app put before it; the file too, if the app made it and it's empty. */
  | (Base & {
      readonly op: 'remove-block';
      readonly expect: string;
      readonly lead: string;
      readonly createdFile: boolean;
    })
  | (Base & {
      readonly op: 'remove-entry';
      readonly content: string;
      readonly createdKey: boolean;
      readonly createdFile: boolean;
    })
  /** The edited text goes into the library's file; the artifact is the app's again. */
  | (Base & { readonly op: 'bring-in'; readonly expect: string; readonly libraryFile: string; readonly row: RowDraft })
  /** Only the registry changes: the artifact is there as wanted, or its state needs the user. */
  | (Base & { readonly op: 'adopt' | 'mark'; readonly row: RowDraft; readonly fingerprint: string | null })
  | (Base & { readonly op: 'forget' });

export interface InstructionPlanInputs {
  readonly instance: string;
  readonly prefix: string;
  readonly libraryFile: string | null;
  readonly decisions: Readonly<Record<string, InstructionDecision>>;
  /** Plan only these keys (a decision's preview), or all. */
  readonly only?: readonly string[];
}

const draft = (d: DesiredInstruction, status: InstructionStatus = 'linked'): RowDraft => ({
  artifact: d.artifact,
  role: d.role,
  tools: d.tools,
  source: d.source,
  entry: d.artifact === 'config-entry' ? d.content : null,
  status,
});

const keepDraft = (row: InstructionRow, status: InstructionStatus): RowDraft => ({
  artifact: row.artifact,
  role: row.role,
  tools: row.tools,
  source: row.source,
  entry: row.entry,
  status,
});

/** The text of the app's part of a file, and its fingerprint, for each kind of artifact. */
function ourPart(
  artifact: InstructionArtifact,
  text: string,
  instance: string,
  entry: string | null,
):
  | { kind: 'none' }
  | { kind: 'damaged' }
  | { kind: 'found'; text: string; fingerprint: string; prefix?: string | null } {
  if (artifact === 'owned-file') return { kind: 'found', text, fingerprint: textFingerprint(text) };
  if (artifact === 'config-entry') {
    if (entry === null) return { kind: 'none' };
    const state = configEntryState(text, entry);
    if (!state.readable) return { kind: 'damaged' };
    return state.present ? { kind: 'found', text: entry, fingerprint: textFingerprint(entry) } : { kind: 'none' };
  }
  const span = findBlock(text, instance);
  if (span.kind !== 'found') return span;
  return { kind: 'found', text: span.inside, fingerprint: textFingerprint(span.inside), prefix: span.prefix };
}

const sameRow = (row: InstructionRow | null, want: RowDraft, fingerprint: string | null) =>
  row !== null &&
  row.status === want.status &&
  row.role === want.role &&
  row.artifact === want.artifact &&
  row.source === want.source &&
  (fingerprint === null || row.fingerprint === fingerprint) &&
  row.tools.join(',') === [...want.tools].sort().join(',');

export function planInstructions(
  inputs: InstructionPlanInputs,
  desired: readonly DesiredInstruction[],
  observed: readonly InstructionObserved[],
): PlanBody<InstructionAction> {
  const actions: InstructionAction[] = [];
  const conflicts: Conflict[] = [];
  const byKey = new Map(observed.map((o) => [o.key, o]));
  const wanted = new Map(desired.map((d) => [d.key, d]));
  const keys = [...new Set([...wanted.keys(), ...byKey.keys()])].sort();
  for (const key of keys) {
    if (inputs.only && !inputs.only.includes(key)) continue;
    const o = byKey.get(key);
    if (!o) continue;
    const d = wanted.get(key);
    if (d) want(inputs, d, o, actions, conflicts);
    else removal(inputs, o, actions, conflicts);
  }
  // A file is there before anything points at it, and nothing points at it any more when it goes: copies are written
  // before the imports and entries that name them, and removed after them (A7.4).
  const roles = new Map<string, InstructionRole>([
    ...observed.flatMap((o) => (o.row ? [[o.key, o.row.role] as const] : [])),
    ...desired.map((d) => [d.key, d.role] as const),
  ]);
  const phase = (action: InstructionAction): number => {
    const removing = action.op === 'remove-file' || action.op === 'remove-block' || action.op === 'remove-entry';
    const copy = roles.get(action.key) === 'copy';
    if (removing) return copy ? 3 : 2;
    return copy ? 0 : 1;
  };
  const ordered = actions
    .map((action, index) => ({ action, index }))
    .sort((a, b) => phase(a.action) - phase(b.action) || a.index - b.index)
    .map(({ action }) => action);
  return { actions: ordered, conflicts };
}

function mark(
  o: InstructionObserved,
  row: RowDraft,
  status: InstructionStatus,
  actions: InstructionAction[],
  conflicts: Conflict[],
): void {
  conflicts.push({ key: o.key, reason: status });
  // The row keeps what the app last wrote from: only the state changes.
  const next = { ...row, source: o.row ? o.row.source : row.source, status };
  if (sameRow(o.row, next, null)) return;
  actions.push({ op: 'mark', key: o.key, written: o.written, row: next, fingerprint: o.row?.fingerprint ?? null });
}

function want(
  inputs: InstructionPlanInputs,
  d: DesiredInstruction,
  o: InstructionObserved,
  actions: InstructionAction[],
  conflicts: Conflict[],
): void {
  const { key, written, row } = o;
  const decision = inputs.decisions[key];
  const entry = d.artifact === 'config-entry' ? d.content : null;
  const base = { key, written };
  if (o.file.kind === 'other') return mark(o, draft(d), 'damaged', actions, conflicts);
  if (o.file.kind === 'missing') {
    if (d.artifact === 'owned-file')
      actions.push({ op: 'write-file', ...base, content: d.content, expect: null, row: draft(d) });
    else if (d.artifact === 'block')
      actions.push({
        op: 'put-block',
        ...base,
        content: d.content,
        expect: null,
        prefix: inputs.prefix,
        row: draft(d),
      });
    else actions.push({ op: 'add-entry', ...base, content: d.content, row: draft(d) });
    return;
  }
  const text = o.file.text;
  const part = ourPart(d.artifact, text, inputs.instance, entry);
  if (part.kind === 'damaged') return mark(o, draft(d), 'damaged', actions, conflicts);
  if (part.kind === 'none') {
    // Not there (any more): the block goes at the end, the entry into the list.
    if (d.artifact === 'block')
      actions.push({
        op: 'put-block',
        ...base,
        content: d.content,
        expect: null,
        prefix: inputs.prefix,
        row: draft(d),
      });
    else actions.push({ op: 'add-entry', ...base, content: d.content, row: draft(d) });
    return;
  }
  const expected = d.artifact === 'block' ? blockInside(d.content, lineBreakOf(text)) : d.content;
  if (part.text === expected) {
    // The local prefix changed (Step 8): the begin marker names the new effective prefix.
    if (d.artifact === 'block' && part.prefix !== inputs.prefix) {
      actions.push({
        op: 'put-block',
        ...base,
        content: d.content,
        expect: part.fingerprint,
        prefix: inputs.prefix,
        row: draft(d),
      });
      return;
    }
    if (!sameRow(row, draft(d), part.fingerprint))
      actions.push({ op: 'adopt', ...base, row: draft(d), fingerprint: part.fingerprint });
    return;
  }
  const untouched = row !== null && row.fingerprint === part.fingerprint;
  const refresh = (expect: string): InstructionAction =>
    d.artifact === 'block'
      ? { op: 'put-block', ...base, content: d.content, expect, prefix: inputs.prefix, row: draft(d) }
      : { op: 'write-file', ...base, content: d.content, expect, row: draft(d) };
  if (decision === 'discard' || (untouched && decision === undefined)) {
    actions.push(refresh(part.fingerprint));
    return;
  }
  if (decision === 'bring-in' && d.role === 'copy' && inputs.libraryFile !== null) {
    actions.push({ op: 'bring-in', ...base, expect: part.fingerprint, libraryFile: inputs.libraryFile, row: draft(d) });
    return;
  }
  // Edited: by the user or an agent. Nothing changes until the user answers.
  mark(o, draft(d), 'edited', actions, conflicts);
}

function removal(
  inputs: InstructionPlanInputs,
  o: InstructionObserved,
  actions: InstructionAction[],
  conflicts: Conflict[],
): void {
  const { key, written, row } = o;
  if (!row) return;
  const base = { key, written };
  if (o.file.kind !== 'file') {
    actions.push({ op: 'forget', ...base });
    return;
  }
  const entry = row.artifact === 'config-entry' ? row.entry : null;
  const part = ourPart(row.artifact, o.file.text, inputs.instance, entry);
  if (part.kind === 'none') {
    actions.push({ op: 'forget', ...base });
    return;
  }
  if (part.kind === 'damaged') return mark(o, keepDraft(row, 'damaged'), 'damaged', actions, conflicts);
  if (row.artifact === 'owned-file') {
    actions.push({ op: 'remove-file', ...base, expect: part.fingerprint, trash: part.fingerprint !== row.fingerprint });
  } else if (row.artifact === 'block') {
    actions.push({
      op: 'remove-block',
      ...base,
      expect: part.fingerprint,
      lead: row.lead,
      createdFile: row.createdFile,
    });
  } else {
    actions.push({
      op: 'remove-entry',
      ...base,
      content: part.text,
      createdKey: row.createdKey,
      createdFile: row.createdFile,
    });
  }
}
