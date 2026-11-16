// The changes screen (PLAN.md §3.10 "The changes screen"): `git status` grouped by skill as "Modified on this device",
// each file's diff against the last commit, [Discard], the message and [Commit] / [Commit and push], and the commits
// that are "Not pushed yet" with [Undo last commit]. The commit runs its checks first and asks what needs an answer.
import type {
  ChangeGroupView,
  ChangesView,
  CommitChecksView,
  InstanceView,
  PushResultView,
  ReviewStatusView,
  SyncStatusView,
} from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { Link, useParams } from '@tanstack/react-router';
import { FileDiff, Files, GitBranchPlus, Info, Undo2, Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  callInstance,
  queryInstance,
  useDeviceQuery,
  useInstanceQuery,
  useInstanceQueryWith,
} from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { DialogShell } from '../../ui/dialog.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { DiffView } from '../editor/history-panel.tsx';
import { EventTime } from '../links/activity-page.tsx';
import { BranchDialog } from '../review/review-dialogs.tsx';
import { useFrameFlows } from '../review/review-flows.tsx';
import { ChecksDialog, IdentityDialog, needsAnswer } from './commit-dialogs.tsx';
import { PushResultDialog } from './push-dialogs.tsx';
import { SyncFrame } from './sync-frame.tsx';

/** A group's name: the skill, the instructions, or the library's other files. */
export function groupLabel(group: Pick<ChangeGroupView, 'kind' | 'skill'>, t: (key: string) => string): string {
  return group.kind === 'skill' ? (group.skill ?? '') : t(`sync.changes.groups.${group.kind}`);
}

export function FileDiffPanel({ instanceId, path }: { instanceId: string; path: string }) {
  const { t } = useTranslation();
  const diff = useInstanceQueryWith(instanceId, 'changeDiff', { path });
  if (diff.error) return <ErrorMessage error={diff.error as unknown as ErrorView} />;
  if (!diff.data) return null;
  const name = path.split('/').at(-1) ?? path;
  return (
    <section aria-label={t('sync.changes.diffLabel', { path })} className="flex flex-col gap-2">
      <h3 className="font-mono text-sm">{path}</h3>
      {diff.data.binary ? (
        <p className="text-sm text-muted-foreground">{t('sync.changes.binary')}</p>
      ) : (
        <DiffView
          before={diff.data.before ?? ''}
          after={diff.data.after ?? ''}
          fileName={name}
          label={t('sync.changes.diffLabel', { path })}
        />
      )}
    </section>
  );
}

export interface ChangesActions {
  readonly checks: (paths: readonly string[]) => Promise<CommitChecksView>;
  commit(input: {
    paths: string[];
    message: string;
    confirm: { deletions?: boolean; secrets?: boolean; largeFiles?: boolean; problems?: boolean };
    push: boolean;
  }): Promise<{ push: PushResultView | null }>;
  setIdentity(identity: { name: string; email: string }): Promise<void>;
  readonly discard: (paths: readonly string[]) => Promise<void>;
  readonly undo: () => Promise<void>;
  readonly push: (confirmSecrets: boolean) => Promise<PushResultView>;
  /** [Commit to a new branch] (Step 12, PLAN.md §3.11 step 1): the branch's suggested name, and the commit there. */
  readonly suggestBranch?: (skills: readonly string[]) => Promise<string>;
  commitToBranch?(input: {
    paths: string[];
    message: string;
    branch: string;
    confirm: { deletions?: boolean; secrets?: boolean; largeFiles?: boolean; problems?: boolean };
  }): Promise<void>;
  /** The signing key, asked first when the host requires signed commits and none is chosen (PLAN.md §3.10). */
  readonly chooseKey?: (then: () => void) => void;
}

export function ChangesPageView({
  instance,
  changes,
  conflicted,
  actions,
  diff,
  review,
}: {
  instance: InstanceView;
  changes: ChangesView | undefined;
  /** A merge or a stash stopped on conflicts: commit waits for them (PLAN.md §3.10 step 3). */
  conflicted: boolean;
  actions: ChangesActions;
  /** The selected file's diff (the page passes the live panel; stories a still one). */
  diff: (path: string) => React.ReactNode;
  /** The role (Step 12): a Viewer commits locally only; a Member commits to a new branch on the company branch. */
  review?: ReviewStatusView | undefined;
}) {
  const { t } = useTranslation();
  const flows = useFrameFlows();
  const chooseKey = actions.chooseKey ?? flows?.chooseKey;
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [asking, setAsking] = useState<{ push: boolean; branch?: string } | null>(null);
  const [checks, setChecks] = useState<{ checks: CommitChecksView; push: { push: boolean; branch?: string } } | null>(
    null,
  );
  const [discarding, setDiscarding] = useState<ChangeGroupView | null>(null);
  const [pushed, setPushed] = useState<PushResultView | null>(null);
  const [branching, setBranching] = useState<string | null>(null);
  const groups = changes?.groups ?? [];
  const chosen = groups.filter((g) => !unchecked.has(g.key));
  const paths = [...new Set(chosen.flatMap((g) => g.paths))];
  const localOnly = review?.actions?.companyBranch === 'none';
  // A Member on the company branch commits to a new branch (PLAN.md §3.11 step 1).
  const member = review?.actions?.companyBranch === 'request' && review.onCompanyBranch;
  /** Where the commit goes: here (`push` after it, or not), or onto a new branch. */
  type Target = { push: boolean; branch?: string };

  const commit = async (target: Target, confirm: Parameters<ChangesActions['commit']>[0]['confirm']) => {
    if (target.branch !== undefined && actions.commitToBranch) {
      await actions.commitToBranch({ paths, message, branch: target.branch, confirm });
    } else {
      const result = await actions.commit({ paths, message, confirm, push: target.push });
      if (result.push && result.push.kind !== 'pushed' && result.push.kind !== 'upToDate') setPushed(result.push);
    }
    setMessage('');
    setShown(null);
  };
  const start = (target: Target) => {
    const push = target;
    setBusy(true);
    setError(null);
    actions
      .checks(paths)
      .then(async (found) => {
        if (found.identityNeeded) return setAsking(push);
        if (found.signingKeyNeeded && chooseKey) return chooseKey(() => start(target));
        if (found.caseClashes.length > 0 || found.tooLarge.length > 0) {
          const [a, b] = found.caseClashes[0] ?? ['', ''];
          return setError(
            found.caseClashes.length > 0
              ? { code: 'sync.caseClash', params: { a, b } }
              : { code: 'sync.fileTooLarge', params: { path: found.tooLarge[0]?.path ?? '' } },
          );
        }
        if (needsAnswer(found)) return setChecks({ checks: found, push });
        await commit(target, {});
      })
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(false));
  };
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-6">
      {error && <ErrorMessage error={error} />}
      {conflicted && (
        <p className="text-sm">
          {t('sync.changes.conflicted')}{' '}
          <Link
            to="/library/$instanceId/changes/conflicts"
            params={{ instanceId: instance.id }}
            className="font-medium underline underline-offset-4"
          >
            {t('sync.banner.resolve')}
          </Link>
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('sync.changes.modified')}</CardTitle>
          <CardDescription>{t('sync.changes.modifiedBody')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {changes && groups.length === 0 && <p className="text-sm text-muted-foreground">{t('sync.changes.none')}</p>}
          {groups.length > 0 && (
            <ul aria-label={t('sync.changes.listLabel')} className="flex flex-col divide-y divide-border">
              {groups.map((group) => {
                const label = groupLabel(group, t);
                return (
                  <li key={group.key} className="flex flex-col gap-1 py-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={!unchecked.has(group.key)}
                          onChange={(e) => {
                            const next = new Set(unchecked);
                            if (e.target.checked) next.delete(group.key);
                            else next.add(group.key);
                            setUnchecked(next);
                          }}
                        />
                        <span className="truncate">{label}</span>
                        {group.deleted && (
                          <span className="rounded bg-danger px-1.5 text-xs text-danger-foreground">
                            {t('sync.changes.deletedSkill')}
                          </span>
                        )}
                      </label>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy || conflicted}
                        aria-label={t('sync.changes.discardLabel', { name: label })}
                        onClick={() => setDiscarding(group)}
                      >
                        <Undo2 aria-hidden="true" />
                        {t('sync.changes.discard')}
                      </Button>
                    </div>
                    <ul className="ml-6 flex flex-col">
                      {group.files.map((file) => (
                        <li key={file.path}>
                          <button
                            type="button"
                            aria-pressed={shown === file.path}
                            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent aria-pressed:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                            onClick={() => setShown(shown === file.path ? null : file.path)}
                          >
                            <FileDiff aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                            <span className="w-24 shrink-0 text-xs text-muted-foreground">
                              {t(`sync.changes.kinds.${file.change}`)}
                            </span>
                            <span className="truncate font-mono text-xs">
                              {file.from ? `${file.from} → ${file.path}` : file.path}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
          {shown && diff(shown)}
          {groups.length > 0 && (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-sm font-medium">
                {t('sync.changes.message')}
                <textarea
                  className="min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm font-normal focus-visible:outline-2 focus-visible:outline-ring"
                  value={message}
                  placeholder={t('sync.changes.messagePlaceholder')}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </label>
              {(localOnly || member) && (
                <p className="flex items-start gap-2 text-sm" data-testid="commit-guide">
                  <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  {localOnly
                    ? t('review.localOnly')
                    : t('review.memberGuide', { branch: review?.companyBranch ?? 'main' })}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {member && actions.commitToBranch && (
                  <Button
                    type="button"
                    disabled={busy || conflicted || paths.length === 0 || message.trim() === ''}
                    onClick={() => {
                      const skills = chosen.flatMap((g) => (g.skill ? [g.skill] : []));
                      (actions.suggestBranch?.(skills) ?? Promise.resolve(''))
                        .then(setBranching)
                        .catch((e: unknown) => setError(e as ErrorView));
                    }}
                  >
                    <GitBranchPlus aria-hidden="true" />
                    {t('review.commitToBranch')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant={member ? 'secondary' : 'default'}
                  disabled={busy || conflicted || paths.length === 0 || message.trim() === ''}
                  onClick={() => start({ push: false })}
                >
                  {t('sync.changes.commit')}
                </Button>
                {!localOnly && !member && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy || conflicted || paths.length === 0 || message.trim() === ''}
                    onClick={() => start({ push: true })}
                  >
                    <Upload aria-hidden="true" />
                    {t('sync.changes.commitAndPush')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('sync.changes.notPushed')}</CardTitle>
          <CardDescription>{t('sync.changes.notPushedBody')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {changes && changes.notPushed.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('sync.changes.allPushed')}</p>
          )}
          {changes && changes.notPushed.length > 0 && (
            <ol aria-label={t('sync.changes.notPushed')} className="flex flex-col divide-y divide-border">
              {changes.notPushed.map((commit) => (
                <li key={commit.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                  <Files aria-hidden="true" className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 font-medium">{commit.subject}</span>
                  <span className="text-muted-foreground">{commit.author}</span>
                  <EventTime ms={commit.authorDate} />
                </li>
              ))}
            </ol>
          )}
          {changes?.canUndo && (
            <div>
              <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => run(actions.undo)}>
                <Undo2 aria-hidden="true" />
                {t('sync.changes.undo')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <IdentityDialog
        open={asking !== null}
        library={instance.name}
        onCancel={() => setAsking(null)}
        onSave={(identity) => {
          const target = asking ?? { push: false };
          setAsking(null);
          run(async () => {
            await actions.setIdentity(identity);
            start(target);
          });
        }}
      />
      <ChecksDialog
        checks={checks?.checks ?? null}
        library={instance.name}
        onCancel={() => setChecks(null)}
        onConfirm={() => {
          const target = checks?.push ?? { push: false };
          setChecks(null);
          run(() => commit(target, { deletions: true, secrets: true, largeFiles: true, problems: true }));
        }}
      />
      <BranchDialog
        open={branching !== null}
        title={t('review.branchDialog.title')}
        description={t('review.branchDialog.body')}
        suggestion={branching ?? ''}
        confirm={t('review.branchDialog.commit')}
        onCancel={() => setBranching(null)}
        onConfirm={(branch) => {
          setBranching(null);
          start({ push: false, branch });
        }}
      />
      <DialogShell
        open={discarding !== null}
        onOpenChange={(open) => !open && setDiscarding(null)}
        title={t('sync.changes.discardTitle', { name: discarding ? groupLabel(discarding, t) : '' })}
        description={t('sync.changes.discardBody')}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setDiscarding(null)}>
              {t('sync.cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                const group = discarding;
                setDiscarding(null);
                if (group) run(() => actions.discard(group.paths));
              }}
            >
              {t('sync.changes.discard')}
            </Button>
          </>
        }
      />
      <PushResultDialog
        result={pushed}
        library={instance.name}
        onMove={flows && review?.actions?.requests && review.onCompanyBranch ? flows.move : undefined}
        onSign={flows?.sign}
        onClose={() => setPushed(null)}
        onConfirmSecrets={() => {
          setPushed(null);
          run(async () => {
            const result = await actions.push(true);
            if (result.kind !== 'pushed' && result.kind !== 'upToDate') setPushed(result);
          });
        }}
      />
    </div>
  );
}

const PULL_MODES = ['merge', 'rebase'] as const;

/**
 * The library's sync settings (PLAN.md §3.10, §3.17): the fetch every 3 minutes, which SSH keys that ask for a touch on
 * every use make a nuisance, and whether Pull merges or rebases.
 */
export function SyncSettings({
  status,
  onChange,
}: {
  status: SyncStatusView;
  onChange: (settings: { fetchTimer?: boolean; pullMode?: 'merge' | 'rebase' }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorView | null>(null);
  // Shown at once; the worker's answer comes with the next status, which renders the card again (its `key`).
  const [shown, setShown] = useState({ fetchTimer: status.fetchTimer, pullMode: status.pullMode });
  const change = (settings: { fetchTimer?: boolean; pullMode?: 'merge' | 'rebase' }) => {
    setError(null);
    setShown((current) => ({ ...current, ...settings }));
    onChange(settings).catch((e: unknown) => setError(e as ErrorView));
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sync.settings.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {error && <ErrorMessage error={error} />}
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={shown.fetchTimer}
            onChange={(e) => change({ fetchTimer: e.target.checked })}
          />
          <span className="flex flex-col gap-0.5">
            {t('sync.settings.fetchTimer')}
            <span className="text-muted-foreground">{t('sync.settings.fetchTimerHelp')}</span>
          </span>
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1">{t('sync.settings.pullMode')}</legend>
          {PULL_MODES.map((mode) => (
            <label key={mode} className="flex items-center gap-2">
              <input
                type="radio"
                name="pull-mode"
                className="accent-primary"
                checked={shown.pullMode === mode}
                onChange={() => change({ pullMode: mode })}
              />
              {t(`sync.settings.${mode}`)}
            </label>
          ))}
        </fieldset>
      </CardContent>
    </Card>
  );
}

export function ChangesPage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId/changes' });
  const instances = useDeviceQuery('instances');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const ready = instance?.status === 'ready' ? instanceId : undefined;
  const changes = useInstanceQuery(ready, 'changes');
  const status = useInstanceQuery(ready, 'syncStatus');
  const review = useInstanceQuery(ready, 'reviewStatus');
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  const actions: ChangesActions = {
    checks: (paths) => queryInstance(instanceId, 'commitChecks', { paths: [...paths] }),
    commit: async (input) => {
      const result = await callInstance(instanceId, 'commit', input);
      return { push: result.kind === 'committed' ? result.push : null };
    },
    setIdentity: async (identity) => {
      await callInstance(instanceId, 'setCommitIdentity', identity);
    },
    discard: async (paths) => {
      await callInstance(instanceId, 'discard', { paths: [...paths] });
    },
    undo: async () => {
      await callInstance(instanceId, 'undoLastCommit', {});
    },
    push: (confirmSecrets) => callInstance(instanceId, 'push', { confirmSecrets }),
    suggestBranch: async (skills) => (await queryInstance(instanceId, 'suggestBranch', { skills: [...skills] })).branch,
    commitToBranch: async (input) => {
      await callInstance(instanceId, 'commitToNewBranch', input);
    },
  };
  return (
    <SyncFrame instance={instance} title={t('sync.changes.title', { name: instance.name })}>
      {changes.error && <ErrorMessage error={changes.error as unknown as ErrorView} />}
      <ChangesPageView
        instance={instance}
        changes={changes.data}
        conflicted={(status.data?.conflicts.length ?? 0) > 0 || (status.data?.operation ?? 'none') !== 'none'}
        actions={actions}
        review={review.data}
        diff={(path) => <FileDiffPanel instanceId={instanceId} path={path} />}
      />
      {status.data && (
        <SyncSettings
          key={`${status.data.fetchTimer}:${status.data.pullMode}`}
          status={status.data}
          onChange={async (settings) => {
            await callInstance(instanceId, 'setSyncSettings', settings);
          }}
        />
      )}
    </SyncFrame>
  );
}
