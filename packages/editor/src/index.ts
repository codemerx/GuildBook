// The Markdown editor behind an interface (IMPLEMENTATION.md §2.11, ADR 0019). Rich mode is Milkdown (Crepe), and
// untouched blocks keep their text (ADR 0029); CodeMirror 6 handles source mode, other text files and diffs. Features
// use only this interface, so the engine can be swapped without touching them.
import { hasConflictMarkers } from '@app/schemas';
import type { ConflictLabels } from './conflict.ts';
import { createRichEditor, type RichEditor, type RichLabels } from './rich.ts';
import { createSourceEditor, type SourceEditor } from './source.ts';

export { keepBlocks, lineEnding, markdownStyle, splitBlocks } from './blocks.ts';
export { acceptConflict, type ConflictLabels, conflictView } from './conflict.ts';
export { createDiffView, type DiffView, type DiffViewOptions } from './diff.ts';
export { type RichLabels } from './rich.ts';
export { createSourceEditor, languageOf, type SourceEditor, type SourceEditorOptions } from './source.ts';

export type EditorMode = 'rich' | 'source';

export interface MarkdownEditorOptions {
  readonly initialText: string;
  readonly mode: EditorMode;
  readonly readOnly: boolean;
  /** The editor's accessible name. */
  readonly label: string;
  /** The file's name, for source mode's highlighting. */
  readonly fileName: string;
  readonly labels: RichLabels;
  /**
   * The conflict view's buttons. A text with conflict markers opens in source mode only, whatever `mode` asks: a rich
   * editor would rewrite the markers (PLAN.md §3.10, research R6).
   */
  readonly conflictLabels?: ConflictLabels | undefined;
  /** Each change the user makes, with the whole text as it would be saved. */
  onChange(text: string): void;
}

export interface MarkdownEditor {
  /** Resolves once the current mode shows the text. */
  readonly ready: Promise<void>;
  /** The text as it would be saved: byte for byte what was loaded, unless the user changed it. */
  getText(): string;
  /** Reports a change that waits for its pause now (synchronously), e.g. before the page closes the editor. */
  flush(): void;
  /** Loads another text (e.g. the file changed on disk); it becomes the loaded text. */
  setText(text: string): Promise<void>;
  /** Switches the mode; the text carries over. Rich mode waits until the text has no conflict markers. */
  setMode(mode: EditorMode): Promise<void>;
  /** The mode the text shows in: source while it has conflict markers, even when rich was asked for. */
  readonly mode: EditorMode;
  focus(): void;
  destroy(): Promise<void>;
}

/** Creates an editor inside a host element. */
export type MarkdownEditorFactory = (host: HTMLElement, options: MarkdownEditorOptions) => MarkdownEditor;

export const createMarkdownEditor: MarkdownEditorFactory = (host, options) => {
  let mode = options.mode;
  let text = options.initialText;
  // The mode asked for, and the one shown: rich mode is locked while the text has conflict markers.
  const shown = () => (mode === 'rich' && hasConflictMarkers(text) ? 'source' : mode);
  let current: { editor: RichEditor | SourceEditor; box: HTMLElement; mode: EditorMode } | null = null;
  // Each mounted editor gets its own element in the host, and its clean-up removes only that: a host can already show
  // the next editor (another mode, a reloaded text) while the old one is still being taken down.
  const mount = async (): Promise<void> => {
    const loaded = text;
    const onChange = (changed: string) => {
      text = changed;
      options.onChange(changed);
    };
    const box = document.createElement('div');
    host.append(box);
    if (shown() === 'rich') {
      const rich = createRichEditor(box, { ...options, text: loaded, onChange });
      current = { editor: rich, box, mode: 'rich' };
      await rich.ready;
    } else {
      const conflicts = options.conflictLabels;
      current = {
        editor: createSourceEditor(box, { ...options, text: loaded, onChange, conflicts }),
        box,
        mode: 'source',
      };
    }
  };
  const unmount = async () => {
    const mounted = current;
    current = null;
    if (!mounted) return;
    await mounted.editor.destroy();
    mounted.box.remove();
  };
  let ready = mount();
  return {
    get ready() {
      return ready;
    },
    get mode() {
      return current?.mode ?? shown();
    },
    getText: () => current?.editor.getText() ?? text,
    flush: () => current?.editor.flush(),
    setText: async (next) => {
      await ready;
      await unmount();
      text = next;
      ready = mount();
      await ready;
    },
    setMode: async (next) => {
      await ready;
      text = current?.editor.getText() ?? text;
      const before = current?.mode ?? shown();
      mode = next;
      if (shown() === before) return;
      await unmount();
      ready = mount();
      await ready;
    },
    focus: () => current?.editor.focus(),
    destroy: async () => {
      await ready.catch(() => undefined);
      await unmount();
    },
  };
};
