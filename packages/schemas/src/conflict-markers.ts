// Conflict markers as git leaves them in a file (PLAN.md §3.10 "Conflicts", IMPLEMENTATION.md §2.9): every marker
// style git writes (`merge`, `diff3`, `zdiff3`), because a conflict can also come from a merge made in a terminal with
// the user's own `merge.conflictStyle`. The core refuses [Mark as resolved] while a file has markers; the editor's
// conflict view shows each conflict with [Accept current], [Accept incoming] and [Accept both].
//
// zdiff3 writes the same markers as diff3; it only moves the lines both sides share out of the conflict. So one
// parser reads all three. Each part keeps its own line endings, and text outside the conflicts is never touched.

/** git's default marker size (`conflict-marker-size`). */
const SIZE = 7;

/** A marker line: `<<<<<<<`, `|||||||`, `=======` or `>>>>>>>`, then the end of the line or a space and a label. */
function marker(line: string, char: string): { label: string } | null {
  const body = line.replace(/\r?\n$/, '');
  if (!body.startsWith(char.repeat(SIZE))) return null;
  const rest = body.slice(SIZE);
  if (rest === '') return { label: '' };
  // A longer run of the same character is another marker size (a nested conflict) or ordinary text.
  if (rest.startsWith(char)) return null;
  // `=======` never has a label; text after it is ordinary text.
  if (char === '=') return null;
  return rest.startsWith(' ') ? { label: rest.slice(1) } : null;
}

export interface ConflictPart {
  /** The part's lines, each with its own line ending. */
  readonly text: string;
  /** Where the part starts and ends in the file (character offsets; `to` is after its last line ending). */
  readonly from: number;
  readonly to: number;
}

export interface ConflictHunk {
  readonly index: number;
  /** The whole conflict, from the `<<<<<<<` line to the end of the `>>>>>>>` line. */
  readonly from: number;
  readonly to: number;
  /** The checked-out side ("ours"): the user's own version during a merge, the library's during a rebase. */
  readonly current: ConflictPart;
  /** The common ancestor, when the style shows it (`diff3`, `zdiff3`). */
  readonly base: ConflictPart | null;
  /** The side being brought in ("theirs"). */
  readonly incoming: ConflictPart;
  /** git's labels after the markers, e.g. `HEAD` and `origin/main`. */
  readonly labels: { readonly current: string; readonly base: string | null; readonly incoming: string };
  /** The marker lines' ranges, e.g. for their decorations. */
  readonly markers: ReadonlyArray<{ readonly from: number; readonly to: number }>;
}

function linesOf(text: string): Array<{ text: string; from: number; to: number }> {
  const lines: Array<{ text: string; from: number; to: number }> = [];
  let at = 0;
  while (at < text.length) {
    const end = text.indexOf('\n', at);
    const to = end < 0 ? text.length : end + 1;
    lines.push({ text: text.slice(at, to), from: at, to });
    at = to;
  }
  return lines;
}

/** Every complete conflict in a file, in order. A `<<<<<<<` without its closing marker is ordinary text. */
export function parseConflicts(text: string): ConflictHunk[] {
  const lines = linesOf(text);
  const hunks: ConflictHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = marker(lines[i]!.text, '<');
    if (!open) {
      i++;
      continue;
    }
    const start = lines[i]!;
    let j = i + 1;
    let baseAt = -1;
    let baseLabel: string | null = null;
    let separator = -1;
    let close = -1;
    let closeLabel = '';
    for (; j < lines.length; j++) {
      const line = lines[j]!.text;
      if (marker(line, '<')) break;
      if (separator < 0 && baseAt < 0) {
        const base = marker(line, '|');
        if (base) {
          baseAt = j;
          baseLabel = base.label;
          continue;
        }
      }
      if (separator < 0 && marker(line, '=')) {
        separator = j;
        continue;
      }
      if (separator >= 0) {
        const end = marker(line, '>');
        if (end) {
          close = j;
          closeLabel = end.label;
          break;
        }
      }
    }
    if (separator < 0 || close < 0) {
      // Not a complete conflict: go on after its first line.
      i++;
      continue;
    }
    const currentEnd = baseAt >= 0 ? baseAt : separator;
    const current = partOf(i + 1, currentEnd, lines, start.to, text);
    const base = baseAt >= 0 ? partOf(baseAt + 1, separator, lines, lines[baseAt]!.to, text) : null;
    const incoming = partOf(separator + 1, close, lines, lines[separator]!.to, text);
    const markers = [i, ...(baseAt >= 0 ? [baseAt] : []), separator, close].map((k) => ({
      from: lines[k]!.from,
      to: lines[k]!.to,
    }));
    hunks.push({
      index: hunks.length,
      from: start.from,
      to: lines[close]!.to,
      current,
      base,
      incoming,
      labels: { current: open.label, base: baseLabel, incoming: closeLabel },
      markers,
    });
    i = close + 1;
  }
  return hunks;
}

/** The lines from `begin` up to (not including) `end`; empty at `emptyAt` when there are none. */
function partOf(
  begin: number,
  end: number,
  lines: ReadonlyArray<{ from: number; to: number }>,
  emptyAt: number,
  text: string,
): ConflictPart {
  if (begin >= end) return { text: '', from: emptyAt, to: emptyAt };
  const from = lines[begin]!.from;
  const to = lines[end - 1]!.to;
  return { text: text.slice(from, to), from, to };
}

/** Whether a file still has a complete conflict in it: [Mark as resolved] is refused while it has (PLAN.md §3.10). */
export function hasConflictMarkers(text: string): boolean {
  return parseConflicts(text).length > 0;
}

export type ConflictChoice = 'current' | 'incoming' | 'both';

/** The text a choice puts in place of the conflict: one side, or both (current first). */
export function conflictResolution(hunk: ConflictHunk, choice: ConflictChoice): string {
  if (choice === 'current') return hunk.current.text;
  if (choice === 'incoming') return hunk.incoming.text;
  // A part without a final line ending (the file's last line) gets the file's line ending before the next part.
  const current = hunk.current.text;
  const ending = /\r\n/.test(current) || /\r\n/.test(hunk.incoming.text) ? '\r\n' : '\n';
  const joined = current !== '' && !current.endsWith('\n') ? `${current}${ending}` : current;
  return `${joined}${hunk.incoming.text}`;
}

/** Resolves one conflict of a file and returns the new text; the rest of the file keeps its bytes. */
export function resolveConflict(text: string, index: number, choice: ConflictChoice): string {
  const hunk = parseConflicts(text)[index];
  if (!hunk) return text;
  return `${text.slice(0, hunk.from)}${conflictResolution(hunk, choice)}${text.slice(hunk.to)}`;
}
