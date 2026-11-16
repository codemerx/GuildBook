// The company's instructions in the editor (PLAN.md §3.12, §3.14): rich or source mode, the size limits of the tools
// that read them, version history, and [Load from file…], which loads an existing AGENTS.md or CLAUDE.md into the
// editor for review (A10.10). Nothing is shared until the user commits and pushes it.
import type { EditorMode } from '@app/editor';
import type { ErrorView } from '@app/schemas';
import { useParams } from '@tanstack/react-router';
import { FileUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, callInstance, queryInstance, useInstanceQuery, useInstanceQueryWith } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { IssueList, SizeLine } from './checks-panel.tsx';
import { EditorFrame } from './editor-frame.tsx';
import { EditorSurface } from './editor-surface.tsx';
import { HistoryPanel } from './history-panel.tsx';
import { ChangedOnDiskDialog, SaveStatus } from './save-status.tsx';
import { ModeSwitch, useEditorContext } from './skill-editor-page.tsx';
import { useFileEditor } from './use-file-editor.ts';

export const INSTRUCTIONS_PATH = 'instructions/AGENTS.md';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

export function InstructionsEditorPage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId/edit/instructions' });
  const context = useEditorContext(instanceId);
  const editor = useFileEditor(context.usable ? instanceId : undefined, INSTRUCTIONS_PATH);
  const [mode, setMode] = useState<EditorMode>('rich');
  const [error, setError] = useState<ErrorView | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const history = useInstanceQueryWith(instanceId, 'history', { path: INSTRUCTIONS_PATH });
  // The tools with a size limit for instructions, and the room left on this device (PLAN.md §3.12).
  const tools = useInstanceQuery(context.usable ? instanceId : undefined, 'instructions');
  const rooms = (tools.data?.tools ?? []).flatMap((tool) => (tool.room ? [{ ...tool.room, name: tool.name }] : []));
  const issues = useMemo(
    () => (context.snapshot?.issues ?? []).filter((issue) => issue.path === INSTRUCTIONS_PATH),
    [context.snapshot],
  );
  const historyActions = useMemo(
    () => ({
      versionText: async (commit: string) =>
        (await queryInstance(instanceId, 'versionText', { commit, path: INSTRUCTIONS_PATH })).text,
      restore: async (commit: string) => {
        await callInstance(instanceId, 'restoreVersion', { path: INSTRUCTIONS_PATH, commit });
      },
    }),
    [instanceId],
  );
  if (!context.instance) return context.loading ? null : <p>{t('library.notFound')}</p>;
  const text = editor.text;
  const loadFromFile = async () => {
    setError(null);
    try {
      const picked = await callDevice('pickFile', { purpose: 'instructions' });
      if (!picked) return;
      if (picked.bytes === null) {
        setError({ code: 'editor.fileTooLarge', params: { name: picked.name } });
        return;
      }
      editor.replace(decoder.decode(picked.bytes));
      setLoaded(picked.name);
    } catch (e) {
      setError(e as ErrorView);
    }
  };
  return (
    <EditorFrame instance={context.instance} snapshot={context.snapshot} localPrefix={context.localPrefix}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('editor.instructions.title')}</h2>
        <SaveStatus state={editor.state} />
      </div>
      <p className="text-sm text-muted-foreground">{t('editor.instructions.body')}</p>
      {error && <ErrorMessage error={error} />}
      {editor.error && <ErrorMessage error={editor.error} />}
      {loaded && (
        <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">
          {t('editor.instructions.loaded', { file: loaded })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <ModeSwitch mode={mode} onMode={setMode} />
        <Button type="button" variant="secondary" size="sm" onClick={() => void loadFromFile()}>
          <FileUp aria-hidden="true" />
          {t('editor.instructions.load')}
        </Button>
      </div>
      {text !== null && (
        <EditorSurface
          text={text}
          version={editor.version}
          mode={mode}
          fileName="AGENTS.md"
          label={t('editor.instructions.label')}
          onChange={editor.edit}
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('editor.checks.title')}</CardTitle>
          <CardDescription>{t('editor.instructions.checks')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {context.snapshot?.instructions && <SizeLine bytes={context.snapshot.instructions.bytes} files={1} />}
          {rooms.length > 0 && (
            <ul aria-label={t('editor.instructions.limits')} className="flex flex-col gap-1 text-sm">
              {rooms.map((room) => (
                <li key={room.tool}>
                  <span className="font-medium">{room.name}:</span>{' '}
                  {room.left >= 0
                    ? t('instructions.room', {
                        left: room.left.toLocaleString('en'),
                        limit: room.limit.toLocaleString('en'),
                        unit: t(`instructions.units.${room.unit}`),
                      })
                    : t('instructions.roomOver', {
                        over: (-room.left).toLocaleString('en'),
                        limit: room.limit.toLocaleString('en'),
                        unit: t(`instructions.units.${room.unit}`),
                      })}
                </li>
              ))}
            </ul>
          )}
          <IssueList issues={issues} />
        </CardContent>
      </Card>
      {text !== null && (
        <HistoryPanel
          versions={history.data}
          current={text}
          fileName="AGENTS.md"
          title={t('editor.list.instructionsTitle')}
          actions={historyActions}
        />
      )}
      <ChangedOnDiskDialog
        open={editor.state.status === 'conflict'}
        file="AGENTS.md"
        onKeepMine={() => void editor.keepMine()}
        onUseDisk={editor.useDisk}
      />
    </EditorFrame>
  );
}
