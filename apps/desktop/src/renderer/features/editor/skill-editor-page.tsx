// A skill in the editor (PLAN.md §3.14): rich mode by default with the header as a form, or source mode with the raw
// file; the skill's files; the checks and "What the agent sees"; the version history. Edits are saved about a second
// after typing stops (A10.4). Renaming the skill renames its folder and `name:` line and moves its placement choices
// (A10.8).
import type { EditorMode } from '@app/editor';
import type { InstanceView, LibrarySnapshotView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Tabs } from 'radix-ui';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  callDevice,
  callInstance,
  queryInstance,
  useDeviceQuery,
  useInstanceQuery,
  useInstanceQueryWith,
} from '../../rpc/queries.ts';
import { cn } from '../../ui/cn.ts';
import { ErrorMessage } from '../errors/error-message.tsx';
import { ChecksPanel } from './checks-panel.tsx';
import { EditorFrame } from './editor-frame.tsx';
import { hasConflictMarkers } from '@app/schemas';
import { useConflictSides } from '../sync/who.ts';
import { EditorSurface, useConflictLabels } from './editor-surface.tsx';
import { type DropTarget, FilesPanel, fileLook } from './files-panel.tsx';
import { HeaderForm } from './header-form.tsx';
import { HistoryPanel } from './history-panel.tsx';
import { ChangedOnDiskDialog, SaveStatus } from './save-status.tsx';
import { bodyOf, headerValues, withBody, withHeaderEdit } from './skill-text.ts';
import { useFileEditor } from './use-file-editor.ts';

const tabClass =
  'rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:bg-accent data-[state=active]:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring';

const MODES: readonly EditorMode[] = ['rich', 'source'];

export function ModeSwitch({
  mode,
  onMode,
  locked = false,
}: {
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  /** The text has conflict markers: rich mode waits until they're gone (PLAN.md §3.10). */
  locked?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t('editor.mode.label')}
      className="inline-flex self-start rounded-md border border-input p-0.5"
    >
      {MODES.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          disabled={locked && value === 'rich'}
          className={cn(
            'rounded px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring',
            mode === value ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground',
          )}
          onClick={() => onMode(value)}
        >
          {t(`editor.mode.${value}`)}
        </button>
      ))}
    </div>
  );
}

/** One text file of the skill in source mode, saved like SKILL.md. */
function TextFileEditor({ instanceId, path }: { instanceId: string; path: string }) {
  const { t } = useTranslation();
  const editor = useFileEditor(instanceId, path);
  const labels = useConflictLabels(useConflictSides(instanceId));
  if (editor.error) return <ErrorMessage error={editor.error} />;
  if (editor.text === null) return null;
  const markers = hasConflictMarkers(editor.text);
  return (
    <section aria-label={path} className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-sm">{path.split('/').slice(2).join('/')}</h3>
        <SaveStatus state={editor.state} />
      </div>
      <EditorSurface
        text={editor.text}
        version={editor.version}
        mode={path.toLowerCase().endsWith('.md') && !markers ? 'rich' : 'source'}
        fileName={path}
        label={t('editor.fileLabel', { file: path.split('/').at(-1) })}
        conflictLabels={markers ? labels : undefined}
        onChange={editor.edit}
      />
      <ChangedOnDiskDialog
        open={editor.state.status === 'conflict'}
        file={path}
        onKeepMine={() => void editor.keepMine()}
        onUseDisk={editor.useDisk}
      />
    </section>
  );
}

export function SkillEditor({
  instance,
  skill,
  snapshot,
  localPrefix,
  home,
}: {
  instance: InstanceView;
  skill: string;
  snapshot: LibrarySnapshotView | undefined;
  localPrefix: string | null;
  home: string | undefined;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const instanceId = instance.id;
  const path = `skills/${skill}/SKILL.md`;
  const editor = useFileEditor(instanceId, path);
  const [chosenMode, setMode] = useState<EditorMode>('rich');
  const [tab, setTab] = useState('write');
  const conflictLabels = useConflictLabels(useConflictSides(instanceId));
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const files = useInstanceQueryWith(instanceId, 'skillFiles', { skill });
  const agents = useInstanceQueryWith(instanceId, 'agentView', { skill }, tab === 'checks');
  const history = useInstanceQueryWith(instanceId, 'history', { path: `skills/${skill}` }, tab === 'history');
  const gitPrefix = snapshot?.config.prefix ?? null;
  const summary = snapshot?.skills.find((entry) => entry.folder === skill);
  const issues = useMemo(() => (snapshot?.issues ?? []).filter((issue) => issue.skill === skill), [snapshot, skill]);
  const text = editor.text;
  // A file with conflict markers opens in source mode only: a rich editor would rewrite them (research R6).
  const locked = text !== null && hasConflictMarkers(text);
  const mode: EditorMode = locked ? 'source' : chosenMode;
  const values = text === null ? null : headerValues(text);
  const historyActions = useMemo(
    () => ({
      versionText: async (commit: string) => (await queryInstance(instanceId, 'versionText', { commit, path })).text,
      restore: async (commit: string) => {
        await callInstance(instanceId, 'restoreVersion', { path: `skills/${skill}`, commit });
      },
    }),
    [instanceId, path, skill],
  );

  if (editor.error) return <ErrorMessage error={editor.error} />;
  if (text === null) return <p className="text-sm text-muted-foreground">{t('editor.loading')}</p>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-mono text-lg font-semibold">{values?.name || skill}</h2>
        <SaveStatus state={editor.state} />
      </div>
      {error && <ErrorMessage error={error} />}
      <Tabs.Root value={tab} onValueChange={setTab} className="flex flex-col gap-4">
        <Tabs.List aria-label={t('editor.tabs.label')} className="flex gap-1 border-b border-border pb-2">
          <Tabs.Trigger value="write" className={tabClass}>
            {t('editor.tabs.write')}
          </Tabs.Trigger>
          <Tabs.Trigger value="files" className={tabClass}>
            {t('editor.tabs.files')}
          </Tabs.Trigger>
          <Tabs.Trigger value="checks" className={tabClass}>
            {issues.length > 0 ? t('editor.tabs.checksCount', { count: issues.length }) : t('editor.tabs.checks')}
          </Tabs.Trigger>
          <Tabs.Trigger value="history" className={tabClass}>
            {t('editor.tabs.history')}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="write" className="flex flex-col gap-4 outline-none">
          <ModeSwitch mode={mode} onMode={setMode} locked={locked} />
          {locked && (
            <p role="status" className="rounded-md border border-warning p-3 text-sm">
              {t('editor.conflict.locked')}
            </p>
          )}
          {mode === 'rich' && values && gitPrefix !== null && (
            <HeaderForm
              key={values.name}
              values={values}
              gitPrefix={gitPrefix}
              effectivePrefix={localPrefix ?? gitPrefix}
              knownTags={(snapshot?.tags ?? []).map((entry) => entry.tag)}
              onEdit={(edit) => {
                const edited = withHeaderEdit(text, edit);
                if (edited !== null) editor.edit(edited);
              }}
              onRename={async (to) => {
                setError(null);
                try {
                  // Unsaved edits are saved under the old name first; the rename then carries them.
                  await editor.flush();
                  await callInstance(instanceId, 'renameSkill', { from: skill, to });
                  await navigate({ to: '/library/$instanceId/edit/skill/$skill', params: { instanceId, skill: to } });
                } catch (e) {
                  setError(e as ErrorView);
                }
              }}
            />
          )}
          {mode === 'rich' && !values && (
            <p role="alert" className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
              {t('editor.header.unreadable')}
            </p>
          )}
          {mode === 'rich' ? (
            <EditorSurface
              text={bodyOf(text)}
              version={editor.version}
              mode="rich"
              fileName="SKILL.md"
              label={t('editor.bodyLabel', { skill })}
              onChange={(body) => editor.edit(withBody(text, body))}
            />
          ) : (
            <EditorSurface
              text={text}
              version={editor.version}
              mode="source"
              fileName="SKILL.md"
              label={t('editor.sourceLabel', { skill })}
              conflictLabels={locked ? conflictLabels : undefined}
              onChange={editor.edit}
            />
          )}
        </Tabs.Content>
        <Tabs.Content value="files" className="flex flex-col gap-4 outline-none">
          <FilesPanel
            instanceId={instanceId}
            skill={skill}
            files={files.data}
            selected={selectedFile}
            onSelect={setSelectedFile}
            actions={{
              add: async (folder: DropTarget | null, name, bytes, replace) => {
                await callInstance(instanceId, 'addSkillFile', { skill, folder, name, bytes, replace });
              },
              pick: async () => {
                const picked = await callDevice('pickFile', { purpose: 'skill-file' });
                if (!picked) return null;
                return { name: picked.name, size: picked.size, bytes: async () => picked.bytes };
              },
              remove: async (target) => {
                await callInstance(instanceId, 'deleteSkillFile', { path: target });
                setSelectedFile(null);
              },
            }}
          />
          {selectedFile && selectedFile !== 'SKILL.md' && fileLook(selectedFile) === 'text' && (
            <TextFileEditor key={selectedFile} instanceId={instanceId} path={`skills/${skill}/${selectedFile}`} />
          )}
        </Tabs.Content>
        <Tabs.Content value="checks" className="outline-none">
          <ChecksPanel
            issues={issues}
            bytes={summary?.bytes ?? 0}
            files={summary?.files ?? 0}
            agents={agents.data}
            home={home}
          />
        </Tabs.Content>
        <Tabs.Content value="history" className="outline-none">
          <HistoryPanel
            versions={history.data}
            current={text}
            fileName="SKILL.md"
            title={skill}
            actions={historyActions}
          />
        </Tabs.Content>
      </Tabs.Root>
      <ChangedOnDiskDialog
        open={editor.state.status === 'conflict'}
        file="SKILL.md"
        onKeepMine={() => void editor.keepMine()}
        onUseDisk={editor.useDisk}
      />
    </div>
  );
}

/** The editor's pages read the library, its local prefix and the home folder. */
export function useEditorContext(instanceId: string) {
  const instances = useDeviceQuery('instances');
  const appInfo = useDeviceQuery('appInfo');
  const instance = instances.data?.find((entry) => entry.id === instanceId);
  // An Admin's library that is setting up is edited too: its import and its instructions (PLAN.md §3.17).
  const usable = instance?.status === 'ready' || instance?.status === 'setting-up';
  const ready = usable ? instanceId : undefined;
  const snapshot = useInstanceQuery(ready, 'librarySnapshot');
  const local = useInstanceQuery(ready, 'localPrefix');
  return {
    instance,
    usable,
    loading: instances.isLoading,
    snapshot: snapshot.data,
    localPrefix: local.data?.localPrefix ?? null,
    home: appInfo.data?.homePath,
  };
}

export function SkillEditorPage() {
  const { t } = useTranslation();
  const { instanceId, skill } = useParams({ from: '/library/$instanceId/edit/skill/$skill' });
  const context = useEditorContext(instanceId);
  if (!context.instance) return context.loading ? null : <p>{t('library.notFound')}</p>;
  return (
    <EditorFrame instance={context.instance} snapshot={context.snapshot} localPrefix={context.localPrefix}>
      <SkillEditor
        key={skill}
        instance={context.instance}
        skill={skill}
        snapshot={context.snapshot}
        localPrefix={context.localPrefix}
        home={context.home}
      />
    </EditorFrame>
  );
}
