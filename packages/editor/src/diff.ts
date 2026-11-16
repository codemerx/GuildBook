// Version history's diff (PLAN.md §3.14): a past version against the current one, in one column, read-only. Lines only
// in the past version are shown as deleted, lines only in the current one as inserted (@codemirror/merge).
import { getChunks, unifiedMergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { lineEnding } from './blocks.ts';
import { sourceExtensions } from './source.ts';

export interface DiffViewOptions {
  /** The past version. */
  readonly before: string;
  /** The current version. */
  readonly after: string;
  readonly fileName: string;
  readonly label: string;
}

export interface DiffView {
  /** How many changed parts the diff shows. */
  readonly chunks: number;
  destroy(): void;
}

export function createDiffView(host: HTMLElement, options: DiffViewOptions): DiffView {
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: options.after,
      extensions: [
        ...sourceExtensions(options.fileName, options.label, true, lineEnding(options.after)),
        unifiedMergeView({ original: options.before, mergeControls: false, gutter: true }),
      ],
    }),
  });
  return { chunks: getChunks(view.state)?.chunks.length ?? 0, destroy: () => view.destroy() };
}
