// The activity log (PLAN.md §3.13): what happened in a library on this device, newest first. Entries whose folder or
// link went to the trash offer [Restore] until the trash keeps it no more (PLAN.md §3.8 "Retention"). The timeline
// filters by kind, skill and date, shows one skill's history, and "what changed since yesterday" (Step 11).
import type { ActivityEntryView, ActivityFilter, InstanceView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { CalendarClock, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, useDeviceQuery, useInstanceQuery, useInstanceQueryWith } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent } from '../../ui/card.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { LibraryNav } from './library-nav.tsx';

/** A time in UTC, the same in every screenshot; marked so the tour masks it (TESTING.md §7.2). */
export function EventTime({ ms }: { ms: number }) {
  const iso = new Date(ms).toISOString();
  return (
    <time dateTime={iso} data-time="" className="tabular-nums text-muted-foreground">
      {`${iso.slice(0, 10)} ${iso.slice(11, 16)}`}
    </time>
  );
}

function detailsOf(entry: ActivityEntryView): Record<string, string> {
  const details = (entry.details ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number') out[key] = String(value);
    else if (Array.isArray(value)) out[key] = value.join(', ');
  }
  return out;
}

/** The entry's sentence: its kind, and a variant for what's special about it (an outdated copy, an overwrite). */
function messageKey(entry: ActivityEntryView, details: Record<string, unknown>): string {
  if (entry.kind === 'relinked' && details.why === 'stale') return 'activity.kinds.relinkedStale';
  if (entry.kind === 'installed' && details.overwrote === true) return 'activity.kinds.installedOverwrote';
  if (entry.kind === 'installed' && typeof details.movedTo === 'string') return 'activity.kinds.installedMoved';
  if (entry.kind === 'renamed' && entry.author) return 'activity.kinds.renamedBy';
  // Step 10: a skill created in the editor, and a past version restored from the history.
  if (entry.kind === 'modified-locally' && typeof details.created === 'string') return 'activity.kinds.createdInEditor';
  // Step 13: an import names where the skill came from; [Replace] moved the original to the trash.
  if (entry.kind === 'imported' && details.replacedOriginal === true) return 'activity.kinds.importedReplaced';
  if (entry.kind === 'imported' && typeof details.source !== 'string') return 'activity.kinds.importedLocal';
  if (entry.kind === 'restored' && typeof details.version === 'string') return 'activity.kinds.restoredVersion';
  // Step 7: a change to the company's instructions in a tool's file, brought in or discarded.
  if (entry.kind === 'brought-in' && typeof details.file === 'string') return 'activity.kinds.broughtInInstructions';
  // Step 6: links in a code repo name the repo; placement entries say what changed.
  if ((entry.kind === 'installed' || entry.kind === 'removed') && Array.isArray(details.repos)) {
    return `activity.kinds.${entry.kind}Repo`;
  }
  if (entry.kind === 'removed' && details.duplicate === true) return 'activity.kinds.removedDuplicate';
  if (entry.kind === 'repo-removed' && typeof details.root === 'string') return 'activity.kinds.repoRemovedRoot';
  if (entry.kind === 'tag-rule-changed') {
    if (typeof details.from === 'string') return 'activity.kinds.tagRuleRetag';
    return details.on === false ? 'activity.kinds.tagRuleOff' : 'activity.kinds.tagRuleOn';
  }
  // Step 8: the local prefix set, changed or dropped, and a both-changed copy decided.
  if (entry.kind === 'local-prefix-changed') {
    if (typeof details.to !== 'string') return 'activity.kinds.localPrefixDropped';
    return typeof details.from === 'string' ? 'activity.kinds.localPrefixChanged' : 'activity.kinds.localPrefixSet';
  }
  // Step 14: the prefix corrected or changed here, or a change this device followed after a pull.
  if (entry.kind === 'prefix-changed') {
    if (details.correction === true) return 'activity.kinds.prefixCorrected';
    return details.pulled === true || details.device === true
      ? 'activity.kinds.prefixFollowed'
      : 'activity.kinds.prefixChanged';
  }
  if (entry.kind === 'copy-kept') {
    return details.kept === 'copy' ? 'activity.kinds.copyKeptCopy' : 'activity.kinds.copyKeptLibrary';
  }
  if (entry.kind === 'library-moved' && details.method === 'locate') return 'activity.kinds.libraryFound';
  if (entry.kind === 'database-restored' && details.damaged === true) return 'activity.kinds.databaseRestoredDamaged';
  if (entry.kind === 'placement-changed' && typeof details.op === 'string') {
    const op = details.op === 'mode' ? `mode-${String(details.mode)}` : details.op;
    const on = details.op === 'add' || details.op === 'exclude' ? (details.on === false ? '-off' : '-on') : '';
    return `activity.kinds.placement.${op}${on}`;
  }
  return `activity.kinds.${entry.kind}`;
}

/** The kinds of PLAN.md §3.13, in the groups the timeline filters by. */
export const ACTIVITY_GROUPS: Readonly<Record<string, readonly string[]>> = {
  git: [
    'committed',
    'commit-undone',
    'discarded',
    'pulled',
    'merged',
    'conflict-resolved',
    'merge-aborted',
    'pushed',
    'push-rejected',
    'branch-created',
    'branch-switched',
    'branch-deleted',
    'stashed',
    'stash-applied',
    'stash-dropped',
    'reverted',
  ],
  links: [
    'installed',
    'skipped',
    'suppressed',
    'relinked',
    'taken-back',
    'detached',
    'renamed',
    'removed',
    'restored-from-trash',
    'brought-in',
    'written-back',
    'copy-kept',
  ],
  placement: ['placement-changed', 'tag-rule-changed', 'repo-added', 'repo-removed', 'worktree-linked'],
  editor: ['modified-locally', 'restored', 'imported'],
  library: [
    'tool-enabled',
    'tool-disabled',
    'instructions-linked',
    'instructions-unlinked',
    'local-prefix-changed',
    'prefix-changed',
    'library-moved',
    'library-downloaded',
    'connections-recovered',
    'database-restored',
    'instance-added',
    'instance-removed',
  ],
  // Step 12: change requests and the signing key.
  requests: [
    'request-opened',
    'request-updated',
    'request-approved',
    'request-declined',
    'request-merged',
    'request-withdrawn',
    'signing-key-added',
  ],
};

export interface TimelineFilter {
  readonly group: string;
  readonly skill: string;
  /** `YYYY-MM-DD` in UTC, as the times are shown; '' for no limit. */
  readonly from: string;
  readonly to: string;
  /** `yesterday`: "what changed since yesterday", by the worker's clock. */
  readonly period: string;
}

export const NO_FILTER: TimelineFilter = { group: '', skill: '', from: '', to: '', period: '' };

const DAY = 24 * 60 * 60 * 1000;

/** The activity query's filter for the timeline's choices. */
export function activityFilter(filter: TimelineFilter): ActivityFilter {
  return {
    limit: 500,
    ...(filter.group !== '' ? { kinds: [...(ACTIVITY_GROUPS[filter.group] ?? [])] } : {}),
    ...(filter.skill !== '' ? { skill: filter.skill } : {}),
    ...(filter.from !== '' ? { since: Date.parse(`${filter.from}T00:00:00Z`) } : {}),
    ...(filter.to !== '' ? { until: Date.parse(`${filter.to}T00:00:00Z`) + DAY } : {}),
    ...(filter.period === 'yesterday' ? { sinceYesterday: true } : {}),
  };
}

function TimelineFilters({
  filter,
  skills,
  onChange,
}: {
  filter: TimelineFilter;
  skills: readonly string[];
  onChange: (filter: TimelineFilter) => void;
}) {
  const { t } = useTranslation();
  const select = 'h-9 rounded-md border border-input bg-background px-2 text-sm';
  return (
    <div role="group" aria-label={t('activity.filters.label')} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm">
        {t('activity.filters.kind')}
        <select
          className={select}
          value={filter.group}
          onChange={(e) => onChange({ ...filter, group: e.target.value })}
        >
          <option value="">{t('activity.filters.allKinds')}</option>
          {Object.keys(ACTIVITY_GROUPS).map((group) => (
            <option key={group} value={group}>
              {t(`activity.filters.groups.${group}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t('activity.filters.skill')}
        <select
          className={select}
          value={filter.skill}
          onChange={(e) => onChange({ ...filter, skill: e.target.value })}
        >
          <option value="">{t('activity.filters.allSkills')}</option>
          {skills.map((skill) => (
            <option key={skill} value={skill}>
              {skill}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t('activity.filters.from')}
        <input
          type="date"
          className={select}
          value={filter.from}
          onChange={(e) => onChange({ ...filter, from: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t('activity.filters.to')}
        <input
          type="date"
          className={select}
          value={filter.to}
          onChange={(e) => onChange({ ...filter, to: e.target.value })}
        />
      </label>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-pressed={filter.period === 'yesterday'}
        onClick={() => onChange({ ...NO_FILTER, period: 'yesterday' })}
      >
        <CalendarClock aria-hidden="true" />
        {t('activity.filters.yesterday')}
      </Button>
      {(filter.group !== '' ||
        filter.skill !== '' ||
        filter.from !== '' ||
        filter.to !== '' ||
        filter.period !== '') && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(NO_FILTER)}>
          {t('activity.filters.clear')}
        </Button>
      )}
    </div>
  );
}

export function ActivityPageView({
  instance,
  entries,
  onRestore,
  filter,
  skills = [],
  onFilter,
}: {
  instance: InstanceView;
  entries: readonly ActivityEntryView[] | undefined;
  onRestore: (trashId: string) => Promise<void>;
  /** The timeline's filters (Step 11); left out, none show. */
  filter?: TimelineFilter;
  skills?: readonly string[];
  onFilter?: (filter: TimelineFilter) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">{t('activity.title', { name: instance.name })}</h1>
        <LibraryNav instanceId={instance.id} attention={instance.attention} />
      </header>
      {filter && onFilter && <TimelineFilters filter={filter} skills={skills} onChange={onFilter} />}
      {error && <ErrorMessage error={error} />}
      {entries && entries.length === 0 && <p className="text-sm text-muted-foreground">{t('activity.empty')}</p>}
      {entries && entries.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <ol aria-label={t('activity.listLabel')} className="flex flex-col divide-y divide-border">
              {entries.map((entry) => {
                const raw = (entry.details ?? {}) as Record<string, unknown>;
                const details = detailsOf(entry);
                const skill = details.skill ?? entry.path?.replace(/^skills\//, '') ?? '';
                // Kept until its retention ends; each health check empties what's past it (PLAN.md §3.8).
                const restorable = entry.trash?.state === 'kept';
                return (
                  <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm">
                    <EventTime ms={entry.ts} />
                    <span className="min-w-0 flex-1">
                      {t(messageKey(entry, raw), {
                        ...details,
                        skill,
                        author: entry.author ?? '',
                        ...(typeof raw.commits === 'number' ? { count: raw.commits } : {}),
                      })}
                    </span>
                    {entry.trash?.state === 'restored' && (
                      <span className="text-xs text-muted-foreground">{t('activity.restored')}</span>
                    )}
                    {restorable && entry.trash && (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null}
                        aria-label={t('activity.restoreLabel', { skill })}
                        onClick={() => {
                          const id = entry.trash?.id ?? '';
                          setBusy(id);
                          setError(null);
                          onRestore(id)
                            .catch((e: unknown) => setError(e as ErrorView))
                            .finally(() => setBusy(null));
                        }}
                      >
                        <RotateCcw aria-hidden="true" />
                        {t('activity.restore')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** The timeline's filters live in the page's address, so a skill's history can be linked to (PLAN.md §3.13). */
export function timelineSearch(search: Record<string, unknown>): Partial<TimelineFilter> {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const out: Record<string, string> = {};
  for (const key of ['group', 'skill', 'from', 'to', 'period'] as const) {
    const value = text(search[key]);
    if (value) out[key] = value;
  }
  return out;
}

export function ActivityPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { instanceId } = useParams({ from: '/library/$instanceId/activity' });
  const search = useSearch({ from: '/library/$instanceId/activity' });
  const filter: TimelineFilter = { ...NO_FILTER, ...search };
  const instances = useDeviceQuery('instances');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const ready = instance?.status === 'ready' ? instanceId : undefined;
  const entries = useInstanceQueryWith(ready, 'activity', activityFilter(filter));
  const snapshot = useInstanceQuery(ready, 'librarySnapshot');
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  return (
    <ActivityPageView
      instance={instance}
      filter={filter}
      skills={(snapshot.data?.skills ?? []).map((s) => s.folder).sort()}
      onFilter={(next) =>
        void navigate({
          to: '/library/$instanceId/activity',
          params: { instanceId },
          search: timelineSearch(next as unknown as Record<string, unknown>),
        })
      }
      entries={entries.data}
      onRestore={async (id) => {
        await callInstance(instanceId, 'restoreFromTrash', { id });
      }}
    />
  );
}
