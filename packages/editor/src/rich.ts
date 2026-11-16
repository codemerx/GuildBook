// Rich mode: Milkdown (Crepe) 7 (ADR 0029). Only the features the app uses are added: no LaTeX (so no KaTeX), no
// image upload and no AI. Crepe's list-item view is left out too: it puts a <div> straight into <ul>, which screen
// readers don't read as a list (axe "list"); ProseMirror's own lists are plain <ul>/<li>. The engine writes new blocks in the file's own bullet and rule style; untouched blocks keep
// their text (blocks.ts). The labels come from the app's translations.
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { blockEdit, type BlockEditFeatureConfig } from '@milkdown/crepe/feature/block-edit';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { placeholder } from '@milkdown/crepe/feature/placeholder';
import { table } from '@milkdown/crepe/feature/table';
import { toolbar } from '@milkdown/crepe/feature/toolbar';
import { editorViewOptionsCtx, prosePluginsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { keepBlocks, markdownStyle } from './blocks.ts';

/** The texts the rich editor shows, in the user's language. */
export interface RichLabels {
  readonly placeholder: string;
  readonly text: string;
  readonly heading: (level: number) => string;
  readonly quote: string;
  readonly divider: string;
  readonly lists: string;
  readonly bulletList: string;
  readonly orderedList: string;
  readonly taskList: string;
  readonly advanced: string;
  readonly codeBlock: string;
  readonly table: string;
}

/** How long typing pauses before a change is worked out and reported (autosave waits about a second more). */
export const REPORT_PAUSE_MS = 150;

export interface RichEditorOptions {
  readonly text: string;
  readonly label: string;
  readonly readOnly: boolean;
  readonly labels: RichLabels;
  /** Each change the user makes, with the text as it would be saved. */
  readonly onChange: (text: string) => void;
}

export interface RichEditor {
  /** Resolves once the engine shows the text. */
  readonly ready: Promise<void>;
  /** The text as it would be saved: the loaded text, byte for byte, until the user changes something. */
  getText(): string;
  /** Reports a change that waits for its pause now, e.g. before the editor closes. */
  flush(): void;
  /** What the engine itself would write for the whole text (the golden test compares it, A10.1). */
  engineText(): string;
  focus(): void;
  destroy(): Promise<void>;
}

export function createRichEditor(host: HTMLElement, options: RichEditorOptions): RichEditor {
  const loaded = options.text;
  const style = markdownStyle(loaded);
  const { labels } = options;
  const menu: BlockEditFeatureConfig = {
    textGroup: {
      label: labels.text,
      text: { label: labels.text },
      h1: { label: labels.heading(1) },
      h2: { label: labels.heading(2) },
      h3: { label: labels.heading(3) },
      h4: { label: labels.heading(4) },
      h5: { label: labels.heading(5) },
      h6: { label: labels.heading(6) },
      quote: { label: labels.quote },
      divider: { label: labels.divider },
    },
    listGroup: {
      label: labels.lists,
      bulletList: { label: labels.bulletList },
      orderedList: { label: labels.orderedList },
      taskList: { label: labels.taskList },
    },
    advancedGroup: {
      label: labels.advanced,
      image: null,
      codeBlock: { label: labels.codeBlock },
      table: { label: labels.table },
      math: null,
    },
  };
  const builder: CrepeBuilder = new CrepeBuilder({ root: host, defaultValue: loaded })
    .addFeature(linkTooltip)
    .addFeature(cursor)
    .addFeature(toolbar)
    .addFeature(table)
    .addFeature(codeMirror)
    .addFeature(placeholder, { text: labels.placeholder, mode: 'doc' })
    .addFeature(blockEdit, menu);

  // Every change of the document marks the editor dirty at once; the text is worked out and reported after a short
  // pause, and at once by flush() — so a change made just before the editor closes is never lost.
  let dirty = false;
  let current = loaded;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const report = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    const text = keepBlocks(loaded, builder.getMarkdown());
    if (text === current) return;
    current = text;
    options.onChange(text);
  };
  const watch = new Plugin({
    key: new PluginKey('app-changes'),
    view: () => ({
      update: (view, previous) => {
        if (view.state.doc.eq(previous.doc)) return;
        dirty = true;
        if (timer === null) timer = setTimeout(report, REPORT_PAUSE_MS);
      },
    }),
  });
  builder.editor.config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (o) => ({ ...o, bullet: style.bullet, rule: style.rule }));
    ctx.update(prosePluginsCtx, (plugins) => [...plugins, watch]);
    ctx.update(editorViewOptionsCtx, (o) => ({
      ...o,
      editable: () => !options.readOnly,
      attributes: { 'aria-label': options.label, role: 'textbox', 'aria-multiline': 'true', 'data-testid': 'rich' },
    }));
  });
  // The keyboard must be able to leave the editor (A10.11): Tab moves the focus on, as in any form, except in a list
  // item (indent) or a table cell (the next cell), where Tab has a meaning of its own. The listener runs before
  // ProseMirror's, which never sees such a Tab, so the browser moves the focus.
  const leaveOnTab = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const at = document.getSelection()?.anchorNode ?? null;
    const element = at instanceof Element ? at : (at?.parentElement ?? null);
    if (element?.closest('li, td, th, .cm-editor')) return;
    event.stopPropagation();
  };
  host.addEventListener('keydown', leaveOnTab, true);
  const ready = builder.create().then(() => undefined);
  return {
    ready,
    getText: () => {
      report();
      return current;
    },
    flush: report,
    engineText: () => builder.getMarkdown(),
    focus: () => {
      const editable = host.querySelector<HTMLElement>('[contenteditable]');
      editable?.focus();
    },
    destroy: async () => {
      report();
      host.removeEventListener('keydown', leaveOnTab, true);
      await ready.catch(() => undefined);
      await builder.destroy();
    },
  };
}
