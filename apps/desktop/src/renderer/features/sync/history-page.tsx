// History (PLAN.md §3.10 "Also as in other git GUIs", §3.15): the library's log, or one skill's, with each commit's
// files and diffs, `scripts/` and `allowed-tools` changes flagged, and [Revert this commit], which makes a new commit
// that undoes it. A bad skill is fixed like bad code: revert, then push.
import type { HistoryEntryView, InstanceView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useNavigate, useParams } from '@tanstack/react-router';
import { FileCode2, RotateCcw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, useDeviceQuery, useInstanceQuery, useInstanceQueryWith } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent } from '../../ui/card.tsx';
import { DialogShell } from '../../ui/dialog.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { DiffView } from '../editor/history-panel.tsx';
import { EventTime } from '../links/activity-page.tsx';
import { SyncFrame } from './sync-frame.tsx';

const PAGE = 50;

export function CommitFlags({ entry }: { entry: Pick<HistoryEntryView, 'scripts' | 'allowedTools' | 'local'> }) {
  const { t } = useTranslation();
  return (
    <>
      {entry.local && <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{t('sync.history.notPushed')}</span>}
      {entry.scripts && (
        <span className="inline-flex items-center gap-1 rounded border border-warning px-1.5 py-0.5 text-xs">
          <FileCode2 aria-hidden="true" className="size-3" />
          {t('sync.flags.scripts')}
        </span>
      )}
      {entry.allowedTools && (
        <span className="inline-flex items-center gap-1 rounded border border-warning px-1.5 py-0.5 text-xs">
          <ShieldAlert aria-hidden="true" className="size-3" />
          {t('sync.flags.allowedTools')}
        </span>
      )}
    </>
  );
}

function CommitDetail({
  instanceId,
  id,
  onRevert,
}: {
  instanceId: string;
  id: string;
  onRevert: (subject: string) => void;
}) {
  const { t } = useTranslation();
  const commit = useInstanceQueryWith(instanceId, 'gitCommit', { id });
  const [path, setPath] = useState<string | null>(null);
  const diff = useInstanceQueryWith(instanceId, 'commitDiff', { id, path: path ?? '' }, path !== null);
  if (commit.error) return <ErrorMessage error={commit.error as unknown as ErrorView} />;
  if (!commit.data) return null;
  const c = commit.data;
  return (
    <section aria-label={t('sync.history.commitLabel', { subject: c.subject })} className="flex flex-col gap-3">
      <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{c.message.trim()}</pre>
      <ul className="flex flex-col">
        {c.changes.map((change) => (
          <li key={change.path}>
            <button
              type="button"
              aria-pressed={path === change.path}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent aria-pressed:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => setPath(path === change.path ? null : change.path)}
            >
              <span className="w-24 shrink-0 text-xs text-muted-foreground">
                {t(`sync.history.kinds.${change.status}`)}
              </span>
              <span className="truncate font-mono text-xs">
                {change.from ? `${change.from} → ${change.path}` : change.path}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {path !== null &&
        diff.data &&
        (diff.data.binary ? (
          <p className="text-sm text-muted-foreground">{t('sync.changes.binary')}</p>
        ) : (
          <DiffView
            before={diff.data.before ?? ''}
            after={diff.data.after ?? ''}
            fileName={path.split('/').at(-1) ?? path}
            label={t('sync.changes.diffLabel', { path })}
          />
        ))}
      <div>
        <Button type="button" variant="secondary" size="sm" onClick={() => onRevert(c.subject)}>
          <RotateCcw aria-hidden="true" />
          {t('sync.history.revert')}
        </Button>
      </div>
    </section>
  );
}

export function HistoryList({
  entries,
  selected,
  onSelect,
}: {
  entries: readonly HistoryEntryView[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <ol aria-label={t('sync.history.listLabel')} className="flex flex-col divide-y divide-border">
      {entries.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            aria-pressed={selected === entry.id}
            className="flex w-full flex-col items-start gap-1 px-2 py-2 text-left text-sm hover:bg-accent aria-pressed:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => onSelect(selected === entry.id ? null : entry.id)}
          >
            <span className="font-medium">{entry.subject}</span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {entry.author}
              <EventTime ms={entry.authorDate} />
              <span className="font-mono" data-volatile="">
                {entry.id.slice(0, 7)}
              </span>
              <CommitFlags entry={entry} />
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function HistoryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { instanceId } = useParams({ from: '/library/$instanceId/changes/history' });
  const instances = useDeviceQuery('instances');
  const instance: InstanceView | undefined = instances.data?.find((i) => i.id === instanceId);
  const ready = instance?.status === 'ready' ? instanceId : undefined;
  const snapshot = useInstanceQuery(ready, 'librarySnapshot');
  const [skill, setSkill] = useState<string | null>(null);
  const [max, setMax] = useState(PAGE);
  const history = useInstanceQueryWith(ready, 'gitHistory', { skill, skip: 0, max });
  const [selected, setSelected] = useState<string | null>(null);
  const [reverting, setReverting] = useState<{ id: string; subject: string } | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  const skills = (snapshot.data?.skills ?? []).map((s) => s.folder).sort();
  return (
    <SyncFrame instance={instance} title={t('sync.history.title', { name: instance.name })}>
      {error && <ErrorMessage error={error} />}
      <label className="flex items-center gap-2 text-sm">
        {t('sync.history.filter')}
        <select
          className="h-9 rounded-md border border-input bg-background px-2"
          value={skill ?? ''}
          onChange={(e) => {
            setSkill(e.target.value === '' ? null : e.target.value);
            setSelected(null);
            setMax(PAGE);
          }}
        >
          <option value="">{t('sync.history.allSkills')}</option>
          {skills.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          {history.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('sync.history.none')}</p>}
          {history.data && history.data.length > 0 && (
            <HistoryList entries={history.data} selected={selected} onSelect={setSelected} />
          )}
          {selected && (
            <CommitDetail
              instanceId={instanceId}
              id={selected}
              onRevert={(subject) => setReverting({ id: selected, subject })}
            />
          )}
          {history.data?.length === max && (
            <div>
              <Button type="button" variant="secondary" size="sm" onClick={() => setMax(max + PAGE)}>
                {t('sync.history.more')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <DialogShell
        open={reverting !== null}
        onOpenChange={(open) => !open && setReverting(null)}
        title={t('sync.history.revertTitle', { subject: reverting?.subject ?? '' })}
        description={t('sync.history.revertBody')}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setReverting(null)}>
              {t('sync.cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                const target = reverting;
                setReverting(null);
                if (!target) return;
                setError(null);
                callInstance(instanceId, 'revertCommit', { id: target.id })
                  .then((outcome) => {
                    if (outcome.kind === 'conflicts') {
                      void navigate({ to: '/library/$instanceId/changes/conflicts', params: { instanceId } });
                    } else setSelected(null);
                  })
                  .catch((e: unknown) => setError(e as ErrorView));
              }}
            >
              {t('sync.history.revert')}
            </Button>
          </>
        }
      />
    </SyncFrame>
  );
}
