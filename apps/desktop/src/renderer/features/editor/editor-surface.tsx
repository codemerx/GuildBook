// The editor in a page (PLAN.md §3.14): `packages/editor` behind its interface, mounted in a host element. It's created
// again when another text is loaded (`version`) or the mode changes; typing never re-creates it.
import {
  type ConflictLabels,
  createMarkdownEditor,
  type EditorMode,
  type MarkdownEditor,
  type RichLabels,
} from '@app/editor';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export function useRichLabels(): RichLabels {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      placeholder: t('editor.rich.placeholder'),
      text: t('editor.rich.text'),
      heading: (level: number) => t('editor.rich.heading', { level }),
      quote: t('editor.rich.quote'),
      divider: t('editor.rich.divider'),
      lists: t('editor.rich.lists'),
      bulletList: t('editor.rich.bulletList'),
      orderedList: t('editor.rich.orderedList'),
      taskList: t('editor.rich.taskList'),
      advanced: t('editor.rich.advanced'),
      codeBlock: t('editor.rich.codeBlock'),
      table: t('editor.rich.table'),
    }),
    [t],
  );
}

/**
 * The conflict view's buttons (PLAN.md §3.10): they name whose side each is, because "current" and "incoming" swap places
 * during a rebase.
 */
export function useConflictLabels(sides: { current: string; incoming: string }): ConflictLabels {
  const { t } = useTranslation();
  const { current, incoming } = sides;
  return useMemo(
    () => ({
      current: t('editor.conflict.current', { who: current }),
      incoming: t('editor.conflict.incoming', { who: incoming }),
      both: t('editor.conflict.both'),
      toolbar: (index: number, count: number) => t('editor.conflict.toolbar', { index: index + 1, count }),
    }),
    [t, current, incoming],
  );
}

export function EditorSurface({
  text,
  version,
  mode,
  fileName,
  label,
  readOnly = false,
  conflictLabels,
  onChange,
}: {
  /** The text to load when the editor is created. */
  text: string;
  /** Changes when another text is loaded (e.g. the file changed on disk). */
  version: number;
  mode: EditorMode;
  fileName: string;
  label: string;
  readOnly?: boolean;
  /** A text with conflict markers shows them with these buttons, in source mode only (research R6). */
  conflictLabels?: ConflictLabels | undefined;
  onChange: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<MarkdownEditor | null>(null);
  const latest = useRef({ text, onChange });
  useLayoutEffect(() => {
    latest.current = { text, onChange };
  });
  const labels = useRichLabels();
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const created = createMarkdownEditor(element, {
      initialText: latest.current.text,
      mode,
      readOnly,
      label,
      fileName,
      labels,
      conflictLabels,
      onChange: (changed) => latest.current.onChange(changed),
    });
    editor.current = created;
    return () => {
      editor.current = null;
      created.flush();
      void created.destroy();
    };
  }, [version, mode, readOnly, label, fileName, labels, conflictLabels]);
  // When the page closes the editor, a change that waits for its pause is reported first: layout cleanups run before
  // the page's own (passive) cleanups, which save what's unsaved.
  useLayoutEffect(() => () => editor.current?.flush(), []);
  return (
    <div
      ref={host}
      data-testid="editor-host"
      data-mode={mode}
      className="editor-surface min-h-64 rounded-md border border-input bg-background"
    />
  );
}
