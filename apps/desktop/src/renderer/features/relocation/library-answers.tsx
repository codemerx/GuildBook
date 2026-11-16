// The instance-wide items of "Needs attention" (Step 9) and their answers:
// - S9 the library folder is missing (PLAN.md §3.8): [Locate folder…] [Download again] [Remove … from this computer]
// - the connections were lost with the database (PLAN.md §3.5): [Recover connections], which asks for the repo
//   folders again
// - a move stopped with an error (PLAN.md §3.9 "Crash at any point"): [Try again]
import type {
  AttentionItemView,
  InstanceView,
  LocateCheckView,
  RecoveryReportView,
  RelocationSummaryView,
} from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { AlertTriangle, FolderPlus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, callInstance, queryInstance } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { RemoveDialog } from '../library/remove-dialog.tsx';
import { RelocationSummary } from './relocation-summary.tsx';
import { announceRelocation } from './summary-host.tsx';

export interface LibraryActions {
  /** Picks a folder; null when the user cancelled. */
  choose(purpose: 'locate' | 'repo'): Promise<string | null>;
  checkLocate(path: string): Promise<LocateCheckView>;
  locate(path: string): Promise<RelocationSummaryView>;
  downloadAgain(): Promise<void>;
  recover(repos: readonly string[]): Promise<RecoveryReportView>;
  retry(): Promise<RelocationSummaryView>;
}

export function libraryActions(instanceId: string): LibraryActions {
  return {
    choose: async (purpose) => (await callDevice('chooseFolder', { purpose })).path,
    checkLocate: (path) => queryInstance(instanceId, 'checkLocate', { path }),
    locate: (path) => callInstance(instanceId, 'locateLibrary', { path }),
    async downloadAgain() {
      await callInstance(instanceId, 'downloadAgain', {});
    },
    recover: (repos) => callInstance(instanceId, 'recoverConnections', { repos: [...repos] }),
    retry: () => callInstance(instanceId, 'retryRelocation', {}),
  };
}

export const LIBRARY_ITEMS: readonly AttentionItemView['kind'][] = [
  'library-missing',
  'connections-lost',
  'relocation-unfinished',
];

/** S9 [Locate folder…]: the picked folder is checked; only this library with the same remote is taken. */
function LocateDialog({
  name,
  path,
  check,
  home,
  actions,
  onOpenChange,
}: {
  name: string;
  path: string;
  check: LocateCheckView;
  home: string | undefined;
  actions: LibraryActions;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const ok = check.problems.length === 0;
  return (
    <DialogShell
      open
      onOpenChange={(open) => !busy && onOpenChange(open)}
      title={t('missing.locateTitle')}
      footer={
        <>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={busy}>
              {t('relocation.cancel')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={!ok || busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              actions
                .locate(path)
                .then((summary) => {
                  // The worker starts again at the folder found: the summary waits above every page.
                  announceRelocation(name, summary);
                  onOpenChange(false);
                })
                .catch((e: unknown) => setError(e as ErrorView))
                .finally(() => setBusy(false));
            }}
          >
            {t('missing.useFolder')}
          </Button>
        </>
      }
    >
      <p className="flex flex-wrap items-baseline gap-1 text-sm">
        <PathText path={path} home={home} />
      </p>
      {check.problems.map((problem) => (
        <p key={problem.code} role="alert" className="text-sm text-danger">
          {t(`missing.problems.${problem.code.slice('relocation.'.length)}`, problem.params)}
        </p>
      ))}
      {ok && <p className="text-sm">{t('missing.locateOk')}</p>}
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}

/** S9 [Download again]: what the moved folder holds and the server doesn't isn't in the new download. */
function DownloadDialog({
  instance,
  home,
  actions,
  onOpenChange,
}: {
  instance: InstanceView;
  home: string | undefined;
  actions: LibraryActions;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  return (
    <DialogShell
      open
      onOpenChange={(open) => !busy && onOpenChange(open)}
      title={t('missing.downloadTitle', { name: instance.name })}
      footer={
        <>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={busy}>
              {t('relocation.cancel')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              actions
                .downloadAgain()
                .then(() => onOpenChange(false))
                .catch((e: unknown) => setError(e as ErrorView))
                .finally(() => setBusy(false));
            }}
          >
            {t('missing.download')}
          </Button>
        </>
      }
    >
      <p className="flex flex-wrap items-baseline gap-1 text-sm">
        {t('missing.downloadInto')}
        <PathText path={instance.libraryPath} home={home} />
      </p>
      <p role="alert" className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
        {t('missing.unpushed')}
      </p>
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}

/** [Recover connections] (PLAN.md §3.5): the repo folders the user adds again are looked at too. */
export function RecoverDialog({
  instance,
  home,
  actions,
  onOpenChange,
}: {
  instance: InstanceView;
  home: string | undefined;
  actions: LibraryActions;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [repos, setRepos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [report, setReport] = useState<RecoveryReportView | null>(null);
  return (
    <DialogShell
      open
      onOpenChange={(open) => !busy && onOpenChange(open)}
      title={t('recovery.title', { name: instance.name })}
      description={report ? undefined : t('recovery.body')}
      footer={
        report ? (
          <DialogClose asChild>
            <Button type="button">{t('relocation.close')}</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={busy}>
                {t('relocation.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                actions
                  .recover(repos)
                  .then(setReport)
                  .catch((e: unknown) => setError(e as ErrorView))
                  .finally(() => setBusy(false));
              }}
            >
              {t('recovery.recover')}
            </Button>
          </>
        )
      }
    >
      {!report && (
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-medium">{t('recovery.repos')}</p>
          {repos.length === 0 && <p className="text-muted-foreground">{t('recovery.noRepos')}</p>}
          <ul className="flex flex-col gap-1" aria-label={t('recovery.repos')}>
            {repos.map((repo) => (
              <li key={repo} className="flex items-center gap-2">
                <PathText path={repo} home={home} />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t('recovery.removeRepo')}
                  onClick={() => setRepos((now) => now.filter((r) => r !== repo))}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          <div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void actions
                  .choose('repo')
                  .then((path) => path !== null && setRepos((now) => (now.includes(path) ? now : [...now, path])))
              }
            >
              <FolderPlus aria-hidden="true" />
              {t('recovery.addRepo')}
            </Button>
          </div>
        </div>
      )}
      {report && (
        <div className="flex flex-col gap-2 text-sm" role="status">
          <p className="font-medium">
            {report.tools.length > 0
              ? t('recovery.done', { count: report.links, tools: report.tools.join(', ') })
              : t('recovery.none')}
          </p>
          {report.repos.map((repo) => (
            <p key={repo.name}>
              {repo.skills.length > 0
                ? t('recovery.inRepo', { repo: repo.name, skills: repo.skills.join(', ') })
                : t('recovery.inRepoNone', { repo: repo.name })}
            </p>
          ))}
          {report.notRepos.length > 0 && <p>{t('recovery.notRepos', { folders: report.notRepos.join(', ') })}</p>}
          <p className="text-muted-foreground">{t('recovery.tagsByHand')}</p>
        </div>
      )}
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}

export function LibraryAnswers({
  item,
  instance,
  home,
  actions,
}: {
  item: AttentionItemView;
  instance: InstanceView;
  home: string | undefined;
  actions: LibraryActions;
}) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<
    { kind: 'locate'; path: string; check: LocateCheckView } | { kind: 'download' } | { kind: 'recover' } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [retried, setRetried] = useState<RelocationSummaryView | null>(null);
  const close = (open: boolean) => !open && setDialog(null);
  return (
    <div className="flex flex-col gap-3">
      {item.kind === 'library-missing' && (
        <>
          <p>{t('links.warning.library-missing.body')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => {
                setError(null);
                void actions
                  .choose('locate')
                  .then(async (path) => {
                    if (path === null) return;
                    setDialog({ kind: 'locate', path, check: await actions.checkLocate(path) });
                  })
                  .catch((e: unknown) => setError(e as ErrorView));
              }}
            >
              {t('missing.locate')}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setDialog({ kind: 'download' })}>
              {t('missing.download')}
            </Button>
            <RemoveDialog instance={instance} home={home} trigger="library" />
          </div>
        </>
      )}
      {item.kind === 'connections-lost' && (
        <>
          <p>{t('links.warning.connections-lost.body')}</p>
          <div>
            <Button type="button" size="sm" onClick={() => setDialog({ kind: 'recover' })}>
              {t('recovery.button')}
            </Button>
          </div>
        </>
      )}
      {item.kind === 'relocation-unfinished' && (
        <>
          <p className="flex flex-wrap items-baseline gap-1">
            {t('links.warning.relocation-unfinished.body')}
            {item.reason && <PathText path={item.reason} home={home} />}
          </p>
          {retried ? (
            <RelocationSummary summary={retried} home={home} />
          ) : (
            <div>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  actions
                    .retry()
                    .then((summary) => {
                      setRetried(summary);
                      announceRelocation(instance.name, summary);
                    })
                    .catch((e: unknown) => setError(e as ErrorView))
                    .finally(() => setBusy(false));
                }}
              >
                {t('relocation.retry')}
              </Button>
            </div>
          )}
        </>
      )}
      {error && <ErrorMessage error={error} />}
      {dialog?.kind === 'locate' && (
        <LocateDialog
          name={instance.name}
          path={dialog.path}
          check={dialog.check}
          home={home}
          actions={actions}
          onOpenChange={close}
        />
      )}
      {dialog?.kind === 'download' && (
        <DownloadDialog instance={instance} home={home} actions={actions} onOpenChange={close} />
      )}
      {dialog?.kind === 'recover' && (
        <RecoverDialog instance={instance} home={home} actions={actions} onOpenChange={close} />
      )}
    </div>
  );
}
