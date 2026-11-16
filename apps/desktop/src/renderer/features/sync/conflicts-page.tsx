// The conflict view (PLAN.md §3.10 step 3): each conflicted file of the merge, rebase, revert or re-applied stash.
// A text file opens in the conflict view (source mode only), with [Accept current], [Accept incoming] and [Accept both]
// above each conflict and a three-way view one click away; a binary file offers [Keep mine] or [Use theirs]; a file
// edited on one side and deleted on the other offers [Keep it] or [Delete it]. [Mark as resolved] is refused while
// markers remain; then [Commit merge] (or [Continue]) and [Abort merge].
import type { ConflictsView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Check, FileWarning, GitMerge, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, useDeviceQuery, useInstanceQuery, useInstanceQueryWith } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { EditorSurface, useConflictLabels } from '../editor/editor-surface.tsx';
import { SaveStatus } from '../editor/save-status.tsx';
import { useFileEditor } from '../editor/use-file-editor.ts';
import { SyncFrame } from './sync-frame.tsx';
import { useWho } from './who.ts';

/** The three versions side by side: the common base, the current side and the incoming side. */
function ThreeWay({
  instanceId,
  path,
  sides,
}: {
  instanceId: string;
  path: string;
  sides: { current: string; incoming: string };
}) {
  const { t } = useTranslation();
  const file = useInstanceQueryWith(instanceId, 'conflictFile', { path });
  if (!file.data) return null;
  const columns = [
    { key: 'base', title: t('sync.conflicts.base'), text: file.data.base },
    { key: 'current', title: t('sync.conflicts.currentSide', { who: sides.current }), text: file.data.current },
    { key: 'incoming', title: t('sync.conflicts.incomingSide', { who: sides.incoming }), text: file.data.incoming },
  ];
  return (
    <section aria-label={t('sync.conflicts.threeWay')} className="grid gap-3 md:grid-cols-3">
      {columns.map((column) => (
        <div key={column.key} className="flex min-w-0 flex-col gap-1">
          <h4 className="text-sm font-semibold">{column.title}</h4>
          <pre
            tabIndex={0}
            className="max-h-80 overflow-auto rounded-md border border-input bg-background p-2 font-mono text-xs whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-ring"
          >
            {column.text ?? t('sync.conflicts.noVersion')}
          </pre>
        </div>
      ))}
    </section>
  );
}

/** One text file in the conflict view, saved as it's edited (Step 10's autosave). */
function TextConflict({
  instanceId,
  path,
  sides,
  markers,
  onResolved,
}: {
  instanceId: string;
  path: string;
  sides: { current: string; incoming: string };
  markers: boolean;
  onResolved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const editor = useFileEditor(instanceId, path);
  const labels = useConflictLabels(sides);
  const [threeWay, setThreeWay] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const name = path.split('/').at(-1) ?? path;
  return (
    <div className="flex flex-col gap-3">
      {editor.error && <ErrorMessage error={editor.error} />}
      {error && <ErrorMessage error={error} />}
      <p className="text-sm text-muted-foreground">{t('sync.conflicts.textHelp')}</p>
      {editor.text !== null && (
        <EditorSurface
          text={editor.text}
          version={editor.version}
          mode="source"
          fileName={name}
          label={t('sync.conflicts.editorLabel', { path })}
          conflictLabels={labels}
          onChange={editor.edit}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SaveStatus state={editor.state} />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-pressed={threeWay}
          onClick={() => setThreeWay(!threeWay)}
        >
          {t('sync.conflicts.showThreeWay')}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setError(null);
            editor
              .flush()
              .then(onResolved)
              .catch((e: unknown) => setError(e as ErrorView));
          }}
        >
          <Check aria-hidden="true" />
          {t('sync.conflicts.markResolved')}
        </Button>
        {!markers && <span className="text-sm text-muted-foreground">{t('sync.conflicts.noMarkers')}</span>}
      </div>
      {threeWay && <ThreeWay instanceId={instanceId} path={path} sides={sides} />}
    </div>
  );
}

export interface ConflictActions {
  readonly take: (path: string, take: 'ours' | 'theirs' | 'delete') => Promise<void>;
  readonly markResolved: (path: string) => Promise<void>;
  readonly continue: () => Promise<'done' | 'conflicts' | 'unresolved'>;
  readonly abort: () => Promise<void>;
}

export function ConflictsPageView({
  conflicts,
  actions,
  text,
}: {
  conflicts: ConflictsView;
  actions: ConflictActions;
  /** The text conflict's editor (the page passes the live one). */
  text: (path: string, sides: { current: string; incoming: string }, markers: boolean) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const who = useWho();
  const sides = { current: who(conflicts.current), incoming: who(conflicts.incoming) };
  const [selected, setSelected] = useState<string | null>(conflicts.files[0]?.path ?? null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const file = conflicts.files.find((f) => f.path === selected) ?? null;
  const operation = conflicts.operation;
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(false));
  };
  const deleted = file?.kind === 'deletedByUs' || file?.kind === 'deletedByThem';
  return (
    <div className="flex flex-col gap-6">
      {error && <ErrorMessage error={error} />}
      <Card>
        <CardHeader>
          <CardTitle>{t(`sync.conflicts.heading.${operation}`)}</CardTitle>
          <CardDescription>
            {t('sync.conflicts.sides', { current: sides.current, incoming: sides.incoming })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {conflicts.files.length === 0 ? (
            <p className="text-sm">
              {t(operation === 'stash' ? 'sync.conflicts.stashDone' : 'sync.conflicts.allResolved')}
            </p>
          ) : (
            <ul aria-label={t('sync.conflicts.files')} className="flex flex-col">
              {conflicts.files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    aria-pressed={selected === f.path}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent aria-pressed:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => setSelected(f.path)}
                  >
                    <FileWarning aria-hidden="true" className="size-4 shrink-0 text-danger" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
                    <span className="text-xs text-muted-foreground">{t(`sync.conflicts.kinds.${f.kind}`)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {file && !file.binary && !deleted && text(file.path, sides, file.markers)}
          {file && file.binary && !deleted && (
            <div className="flex flex-col gap-2">
              <p className="text-sm">{t('sync.conflicts.binaryHelp')}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => run(() => actions.take(file.path, 'ours'))}
                >
                  {t('sync.conflicts.keepMine', { who: sides.current })}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => run(() => actions.take(file.path, 'theirs'))}
                >
                  {t('sync.conflicts.useTheirs', { who: sides.incoming })}
                </Button>
              </div>
            </div>
          )}
          {file && deleted && (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                {t(file.kind === 'deletedByThem' ? 'sync.conflicts.deletedByThem' : 'sync.conflicts.deletedByUs', {
                  current: sides.current,
                  incoming: sides.incoming,
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => run(() => actions.take(file.path, file.kind === 'deletedByThem' ? 'ours' : 'theirs'))}
                >
                  {t('sync.conflicts.keepIt')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => run(() => actions.take(file.path, 'delete'))}
                >
                  {t('sync.conflicts.deleteIt')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="flex flex-wrap gap-2">
        {operation !== 'stash' && operation !== 'none' && (
          <Button
            type="button"
            disabled={busy || !conflicts.ready}
            onClick={() =>
              run(async () => {
                const outcome = await actions.continue();
                if (outcome === 'unresolved') setError({ code: 'sync.markersLeft', params: { path: '' } });
              })
            }
          >
            <GitMerge aria-hidden="true" />
            {t(`sync.conflicts.finish.${operation}`)}
          </Button>
        )}
        {operation !== 'stash' && operation !== 'none' && (
          <Button type="button" variant="secondary" disabled={busy} onClick={() => run(actions.abort)}>
            <Undo2 aria-hidden="true" />
            {t(`sync.banner.abort.${operation}`)}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ConflictsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { instanceId } = useParams({ from: '/library/$instanceId/changes/conflicts' });
  const instances = useDeviceQuery('instances');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const conflicts = useInstanceQuery(instance?.status === 'ready' ? instanceId : undefined, 'conflicts');
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  const actions: ConflictActions = {
    take: async (path, take) => {
      await callInstance(instanceId, 'takeConflict', { path, take });
    },
    markResolved: async (path) => {
      await callInstance(instanceId, 'markResolved', { paths: [path] });
    },
    continue: async () => {
      const outcome = await callInstance(instanceId, 'continueOperation', {});
      if (outcome.kind === 'done') void navigate({ to: '/library/$instanceId/changes', params: { instanceId } });
      return outcome.kind;
    },
    abort: async () => {
      await callInstance(instanceId, 'abortOperation', {});
      void navigate({ to: '/library/$instanceId/changes', params: { instanceId } });
    },
  };
  return (
    <SyncFrame instance={instance} title={t('sync.conflicts.title', { name: instance.name })}>
      {conflicts.error && <ErrorMessage error={conflicts.error as unknown as ErrorView} />}
      {conflicts.data && conflicts.data.operation === 'none' && (
        <p className="text-sm text-muted-foreground">{t('sync.conflicts.none')}</p>
      )}
      {conflicts.data && conflicts.data.operation !== 'none' && (
        <ConflictsPageView
          conflicts={conflicts.data}
          actions={actions}
          text={(path, sides, markers) => (
            <TextConflict
              key={path}
              instanceId={instanceId}
              path={path}
              sides={sides}
              markers={markers}
              onResolved={() => actions.markResolved(path)}
            />
          )}
        />
      )}
    </SyncFrame>
  );
}
