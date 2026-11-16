// The git screens' frame (PLAN.md §3.10): the sync bar ("Acme · main · ↓2 incoming · ↑1 to push" with [Fetch], [Pull…]
// and [Push]), the offline state, and the sub-pages: Changes, History, Branches and Stashes. Push runs from here, with
// its secret scan's confirmation and its rejections explained. The role decides what the bar offers (PLAN.md §3.11): a
// Viewer's library is local only, a Member pushes a branch and opens a change request on the host's website instead of
// pushing to the company branch (ADR 0032).
import type { InstanceView, PushResultView, ReviewStatusView, SyncStatusView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowDownToLine, ArrowUpFromLine, CloudOff, GitBranch, RefreshCw, TriangleAlert } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, useInstanceQuery } from '../../rpc/queries.ts';
import { Button, buttonVariants } from '../../ui/button.tsx';
import { Card, CardContent } from '../../ui/card.tsx';
import { cn } from '../../ui/cn.ts';
import { ErrorMessage } from '../errors/error-message.tsx';
import { LibraryNav } from '../links/library-nav.tsx';
import { hostName, type ReviewFlows, ReviewFlowsContext, useReviewFlows } from '../review/review-flows.tsx';
import { PushResultDialog } from './push-dialogs.tsx';

/** A time as hours and minutes in UTC, the same in every screenshot; masked by the tour (TESTING.md §7.2). */
export function ClockTime({ ms }: { ms: number }) {
  const iso = new Date(ms).toISOString();
  return (
    <time dateTime={iso} data-time="" className="tabular-nums">
      {iso.slice(11, 16)}
    </time>
  );
}

/** Why Pull and Push are off, or null: offline, a library.yaml this app can't read, or a merge under way. */
export function syncBlocked(status: SyncStatusView | undefined): 'offline' | 'update' | 'merging' | 'noRemote' | null {
  if (!status) return null;
  if (!status.remote) return 'noRemote';
  if (status.offline) return 'offline';
  if (status.compatibility !== 'ok') return 'update';
  if (status.operation !== 'none' || status.conflicts.length > 0) return 'merging';
  return null;
}

const tab = cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'px-2');
const active = { 'aria-current': 'page' as const, className: 'bg-accent text-accent-foreground' };

/** Why the role keeps Push off here (PLAN.md §3.11), or null: a Viewer anywhere, a Member on the company branch. */
export function pushBlockedByRole(review: ReviewStatusView | undefined): 'viewer' | 'member' | null {
  const actions = review?.actions;
  if (!actions) return null;
  if (actions.companyBranch === 'none') return 'viewer';
  return actions.companyBranch === 'request' && review.onCompanyBranch ? 'member' : null;
}

function SyncNav({ instanceId }: { instanceId: string }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('sync.nav.label')} className="flex flex-wrap gap-0.5">
      <Link
        to="/library/$instanceId/changes"
        params={{ instanceId }}
        className={tab}
        activeOptions={{ exact: true }}
        activeProps={active}
      >
        {t('sync.nav.changes')}
      </Link>
      <Link to="/library/$instanceId/changes/history" params={{ instanceId }} className={tab} activeProps={active}>
        {t('sync.nav.history')}
      </Link>
      <Link to="/library/$instanceId/changes/branches" params={{ instanceId }} className={tab} activeProps={active}>
        {t('sync.nav.branches')}
      </Link>
      <Link to="/library/$instanceId/changes/stashes" params={{ instanceId }} className={tab} activeProps={active}>
        {t('sync.nav.stashes')}
      </Link>
    </nav>
  );
}

export interface SyncBarActions {
  readonly fetch: () => Promise<void>;
  readonly push: (confirmSecrets: boolean) => Promise<PushResultView>;
  /** Opens the incoming preview. */
  readonly openIncoming: () => void;
}

/** The sync bar: where the branch stands against the server, and the three buttons. */
export function SyncBar({
  status,
  library,
  actions,
  review,
  flows,
}: {
  status: SyncStatusView;
  library: string;
  actions: SyncBarActions;
  /** The role and the branch's request (Step 12); undefined while it loads, or in a story without roles. */
  review?: ReviewStatusView | undefined;
  flows?: Pick<ReviewFlows, 'open' | 'move' | 'sign'> | undefined;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'fetch' | 'push' | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [result, setResult] = useState<PushResultView | null>(null);
  const blocked = syncBlocked(status);
  const why = blocked === null ? undefined : t(`sync.bar.blocked.${blocked}`);
  const roleBlocked = pushBlockedByRole(review);
  const pushWhy =
    why ??
    (roleBlocked === null ? undefined : t(`review.blocked.${roleBlocked}`, { branch: review?.companyBranch ?? '' }));
  // A branch of one's own: the push opens the page that makes the change request (PLAN.md §3.11 step 2, ADR 0032).
  const opensRequest = flows !== undefined && review?.requestBranch === true;
  const push = (confirmSecrets: boolean) => {
    setBusy('push');
    setError(null);
    actions
      .push(confirmSecrets)
      .then((outcome) => setResult(outcome.kind === 'pushed' || outcome.kind === 'upToDate' ? null : outcome))
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(null));
  };
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="sync-state">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <GitBranch aria-hidden="true" className="size-4" />
              {status.branch ?? t('sync.bar.detached')}
            </span>
            <span>{t('sync.bar.incoming', { count: status.incoming })}</span>
            <span>{t('sync.bar.toPush', { count: status.toPush })}</span>
          </p>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy !== null || status.fetching || !status.remote}
              onClick={() => {
                setBusy('fetch');
                setError(null);
                actions
                  .fetch()
                  .catch((e: unknown) => setError(e as ErrorView))
                  .finally(() => setBusy(null));
              }}
            >
              <RefreshCw aria-hidden="true" className={status.fetching ? 'animate-spin' : undefined} />
              {t('sync.bar.fetch')}
            </Button>
            {/* A disabled button gets no pointer events: its tooltip is on the wrapper (PLAN.md §3.19 "Offline"). */}
            <span title={why} className="inline-flex">
              <Button
                type="button"
                size="sm"
                variant={status.incoming > 0 ? 'default' : 'secondary'}
                disabled={busy !== null || blocked !== null || status.incoming === 0}
                aria-describedby={why ? 'sync-blocked' : undefined}
                onClick={actions.openIncoming}
              >
                <ArrowDownToLine aria-hidden="true" />
                {t('sync.bar.pull')}
              </Button>
            </span>
            <span title={pushWhy ?? ''} className="inline-flex">
              <Button
                type="button"
                size="sm"
                variant={status.toPush > 0 && roleBlocked === null ? 'default' : 'secondary'}
                disabled={
                  busy !== null || blocked !== null || roleBlocked !== null || (status.toPush === 0 && !opensRequest)
                }
                aria-describedby={why || (pushWhy && status.toPush > 0) ? 'sync-blocked' : undefined}
                onClick={() => (opensRequest ? flows.open() : push(false))}
              >
                <ArrowUpFromLine aria-hidden="true" />
                {t(opensRequest ? 'review.pushAndOpen' : 'sync.bar.push')}
              </Button>
            </span>
          </div>
        </div>
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          {status.offline && <CloudOff aria-hidden="true" className="size-4 text-warning" />}
          {status.fetching ? (
            t('sync.bar.checking')
          ) : status.lastFetchAt === null ? (
            status.offline ? (
              t('sync.bar.offlineNever')
            ) : (
              t('sync.bar.notChecked')
            )
          ) : (
            <span>
              {t(status.offline ? 'sync.bar.offline' : 'sync.bar.checked')} <ClockTime ms={status.lastFetchAt} />
            </span>
          )}
        </p>
        {/* The role's reason shows when commits wait; the commit box says it already otherwise. */}
        {(why ?? (status.toPush > 0 ? pushWhy : undefined)) && (
          <p id="sync-blocked" className="flex items-center gap-2 text-sm">
            <TriangleAlert aria-hidden="true" className="size-4 text-warning" />
            {why ?? pushWhy}
          </p>
        )}
        {/* A Member's commits on main (made before, or with another git tool) go to a request (PLAN.md §3.11 step 8). */}
        {why === undefined && roleBlocked === 'member' && status.toPush > 0 && flows && (
          <div>
            <Button type="button" size="sm" onClick={flows.move}>
              {t('review.move')}
            </Button>
          </div>
        )}
        {review?.role && (
          <p className="text-sm text-muted-foreground" data-testid="sync-role">
            {t('review.role', { role: t(`roles.${review.role}`), host: hostName(review, t) })}
          </p>
        )}
        {status.fetchError && <ErrorMessage error={status.fetchError} />}
        {error && <ErrorMessage error={error} />}
        <PushResultDialog
          result={result}
          library={library}
          onClose={() => setResult(null)}
          onConfirmSecrets={() => {
            setResult(null);
            push(true);
          }}
          onMove={review?.actions?.requests && review.onCompanyBranch ? flows?.move : undefined}
          onSign={flows?.sign}
        />
      </CardContent>
    </Card>
  );
}

/** Every git screen's frame: the title, the library's pages, the sync bar and the git screens' own pages. */
export function SyncFrame({
  instance,
  title,
  children,
}: {
  instance: InstanceView;
  title: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const ready = instance.status === 'ready';
  const status = useInstanceQuery(ready ? instance.id : undefined, 'syncStatus');
  const review = useInstanceQuery(ready ? instance.id : undefined, 'reviewStatus');
  const [flowError, setFlowError] = useState<ErrorView | null>(null);
  const [flowPush, setFlowPush] = useState<PushResultView | null>(null);
  const flows = useReviewFlows(instance, review.data, { onPush: setFlowPush, onError: setFlowError });
  const actions: SyncBarActions = {
    fetch: async () => {
      await callInstance(instance.id, 'fetch', {});
    },
    push: (confirmSecrets) => callInstance(instance.id, 'push', { confirmSecrets }),
    openIncoming: () =>
      void navigate({ to: '/library/$instanceId/changes/incoming', params: { instanceId: instance.id } }),
  };
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <LibraryNav instanceId={instance.id} attention={instance.attention} />
      </header>
      {status.error && <ErrorMessage error={status.error as unknown as ErrorView} />}
      {status.data && (
        <SyncBar status={status.data} library={instance.name} actions={actions} review={review.data} flows={flows} />
      )}
      {flowError && <ErrorMessage error={flowError} />}
      {flows.note}
      <SyncNav instanceId={instance.id} />
      <ReviewFlowsContext.Provider value={flows}>{children}</ReviewFlowsContext.Provider>
      {flows.dialogs}
      <PushResultDialog
        result={flowPush}
        library={instance.name}
        onClose={() => setFlowPush(null)}
        onConfirmSecrets={() => {
          setFlowPush(null);
          flows.confirmSecrets();
        }}
        onSign={flows.sign}
      />
    </div>
  );
}
