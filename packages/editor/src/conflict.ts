// The conflict view (PLAN.md §3.10 "Conflicts", research R6): source mode with each conflict shown in place, as in VS
// Code. Above each conflict, [Accept current], [Accept incoming] and [Accept both] put that text in its place; the text
// can also be edited by hand. The buttons name whose side each is, because "current" and "incoming" swap places during
// a rebase. Files with markers open in source mode only: a rich editor would read `=======` as a heading underline and
// rewrite the markers (R6).
import { type ConflictChoice, conflictResolution, parseConflicts } from '@app/schemas';
import { type EditorState, type Extension, type Range, StateField, Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

export interface ConflictLabels {
  /** e.g. "Accept current (yours)". */
  readonly current: string;
  /** e.g. "Accept incoming (Ayşe's)". */
  readonly incoming: string;
  readonly both: string;
  /** The toolbar's accessible name, e.g. "Conflict 1 of 2". */
  toolbar(index: number, count: number): string;
}

class ConflictToolbar extends WidgetType {
  readonly index: number;
  readonly count: number;
  readonly labels: ConflictLabels;

  constructor(index: number, count: number, labels: ConflictLabels) {
    super();
    this.index = index;
    this.count = count;
    this.labels = labels;
  }

  override eq(other: ConflictToolbar): boolean {
    return other.index === this.index && other.count === this.count && other.labels === this.labels;
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-conflict-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', this.labels.toolbar(this.index, this.count));
    const button = (choice: ConflictChoice, label: string) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      element.dataset.choice = choice;
      element.addEventListener('mousedown', (event) => event.preventDefault());
      element.addEventListener('click', () => acceptConflict(view, this.index, choice));
      return element;
    };
    bar.append(
      button('current', this.labels.current),
      button('incoming', this.labels.incoming),
      button('both', this.labels.both),
    );
    return bar;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * The document with "\n" between lines: its offsets are the editor's positions, whatever the file's line endings (a
 * CRLF file's `sliceDoc()` has two characters per line break, a position only one).
 */
const docText = (state: EditorState) => state.doc.toString();

/** Puts one side (or both) in place of a conflict, as one change the user can undo. */
export function acceptConflict(view: EditorView, index: number, choice: ConflictChoice): boolean {
  const hunk = parseConflicts(docText(view.state))[index];
  if (!hunk) return false;
  // As lines, so the editor joins them with the file's own line ending.
  const insert = Text.of(conflictResolution(hunk, choice).split('\n'));
  view.dispatch({ changes: { from: hunk.from, to: hunk.to, insert }, userEvent: 'input.conflict' });
  return true;
}

const line = (className: string) => Decoration.line({ class: className });
const MARKER = line('cm-conflict-marker');
const CURRENT = line('cm-conflict-current');
const BASE = line('cm-conflict-base');
const INCOMING = line('cm-conflict-incoming');

function decorations(state: EditorState, labels: ConflictLabels): DecorationSet {
  const hunks = parseConflicts(docText(state));
  const ranges: Range<Decoration>[] = [];
  const lines = (from: number, to: number, decoration: Decoration) => {
    // A part ends after its last line ending: its last line starts before `to`.
    for (let at = from; at < to;) {
      const current = state.doc.lineAt(at);
      ranges.push(decoration.range(current.from));
      at = current.to + 1;
    }
  };
  for (const hunk of hunks) {
    const toolbar = new ConflictToolbar(hunk.index, hunks.length, labels);
    ranges.push(Decoration.widget({ widget: toolbar, block: true, side: -1 }).range(hunk.from));
    const [open, ...rest] = hunk.markers;
    lines(open!.from, open!.to, MARKER);
    lines(hunk.current.from, hunk.current.to, CURRENT);
    if (hunk.base) {
      lines(rest[0]!.from, rest[0]!.to, MARKER);
      lines(hunk.base.from, hunk.base.to, BASE);
    }
    const separator = rest[rest.length - 2]!;
    const close = rest[rest.length - 1]!;
    lines(separator.from, separator.to, MARKER);
    lines(hunk.incoming.from, hunk.incoming.to, INCOMING);
    lines(close.from, close.to, MARKER);
  }
  return Decoration.set(ranges, true);
}

const theme = EditorView.theme({
  '.cm-conflict-toolbar': {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    padding: '4px 0 2px',
    fontFamily: 'inherit',
  },
  '.cm-conflict-toolbar button': {
    font: 'inherit',
    fontSize: '12px',
    padding: '1px 8px',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    background: 'var(--background)',
    color: 'var(--foreground)',
    cursor: 'pointer',
  },
  '.cm-conflict-toolbar button:focus-visible': { outline: '2px solid var(--ring)', outlineOffset: '1px' },
  '.cm-conflict-marker': { color: 'var(--muted-foreground)', fontWeight: 'bold' },
  '.cm-conflict-current': { backgroundColor: 'color-mix(in oklab, var(--primary) 14%, transparent)' },
  '.cm-conflict-base': { backgroundColor: 'color-mix(in oklab, var(--muted-foreground) 14%, transparent)' },
  '.cm-conflict-incoming': { backgroundColor: 'color-mix(in oklab, var(--success) 14%, transparent)' },
});

/** The conflict view's part of a source editor. */
export function conflictView(labels: ConflictLabels): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => decorations(state, labels),
    update: (value, transaction) => (transaction.docChanged ? decorations(transaction.state, labels) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [field, theme];
}
