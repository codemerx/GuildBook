// Source mode and other text files (PLAN.md §3.14): CodeMirror 6 with syntax highlighting by file name. The file keeps
// its line endings, and the loaded text comes back byte for byte until the user changes something. Tab isn't bound,
// so the keyboard can always leave the editor (A10.11).
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml, yamlFrontmatter } from '@codemirror/lang-yaml';
import { HighlightStyle, type LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { lineEnding } from './blocks.ts';
import { type ConflictLabels, conflictView } from './conflict.ts';

/** The language a file is highlighted as, by its name; null for plain text. */
export function languageOf(fileName: string): LanguageSupport | null {
  const extension = /\.([^./]+)$/.exec(fileName.toLowerCase())?.[1] ?? '';
  switch (extension) {
    case 'md':
    case 'markdown':
      // A SKILL.md's header is YAML, not a heading over a `---` line.
      return yamlFrontmatter({ content: markdown() });
    case 'yaml':
    case 'yml':
      return yaml();
    case 'json':
      return json();
    case 'py':
      return python();
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    default:
      return null;
  }
}

export interface SourceEditorOptions {
  readonly text: string;
  readonly fileName: string;
  readonly label: string;
  readonly readOnly: boolean;
  readonly onChange: (text: string) => void;
  /** The conflict view's buttons (PLAN.md §3.10): conflicts in the text are shown with them. */
  readonly conflicts?: ConflictLabels | undefined;
}

export interface SourceEditor {
  getText(): string;
  /** Source mode reports each change at once: nothing waits. */
  flush(): void;
  focus(): void;
  destroy(): void;
}

/**
 * Highlighting from the app's colour tokens, readable in the light and the dark theme (axe's contrast check):
 * CodeMirror's default colours are made for a light background only.
 */
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--primary)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--success)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--warning)' },
  { tag: [tags.comment, tags.meta, tags.processingInstruction], color: 'var(--muted-foreground)' },
  { tag: tags.heading, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: [tags.link, tags.url], color: 'var(--primary)', textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--danger)' },
]);

/** The editor's look, from the app's colour tokens, so it follows the light and dark themes. */
const theme = EditorView.theme({
  '&': { color: 'var(--foreground)', backgroundColor: 'transparent', fontSize: '13px' },
  '.cm-content': { fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace", caretColor: 'var(--foreground)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted-foreground)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in oklab, var(--accent) 50%, transparent)',
  },
  '&.cm-focused': { outline: '2px solid var(--ring)', outlineOffset: '-2px' },
});

export function sourceExtensions(fileName: string, label: string, readOnly: boolean, eol: string): Extension[] {
  const language = languageOf(fileName);
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    syntaxHighlighting(highlight),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    EditorView.lineWrapping,
    EditorState.lineSeparator.of(eol),
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({ 'aria-label': label, 'data-testid': 'source' }),
    theme,
    ...(language ? [language] : []),
  ];
}

export function createSourceEditor(host: HTMLElement, options: SourceEditorOptions): SourceEditor {
  const loaded = options.text;
  let changed = false;
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: loaded,
      extensions: [
        ...sourceExtensions(options.fileName, options.label, options.readOnly, lineEnding(loaded)),
        ...(options.conflicts ? [conflictView(options.conflicts)] : []),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          changed = true;
          options.onChange(update.state.sliceDoc());
        }),
      ],
    }),
  });
  return {
    getText: () => (changed ? view.state.sliceDoc() : loaded),
    flush: () => undefined,
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
