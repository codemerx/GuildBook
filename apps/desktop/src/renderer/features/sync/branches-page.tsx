// Branches and stashes (PLAN.md §3.10 "Also as in other git GUIs"). Branches: create, switch, merge into the current
// one, delete; on another branch than the company's, [Merge main from the server] brings the company's new changes in,
// e.g. into a change request's branch (ADR 0032). When local changes block a switch, the same choices as for a pull: [Commit them first] or [Stash, switch
// and re-apply]. Tools always see the checked-out branch. Stashes: put changes aside, apply them, drop them.
import type { BranchesView, InstanceView, StashResultViewSchema, SwitchResultView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Archive, GitBranch, GitMerge, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { callInstance, useDeviceQuery, useInstanceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { DialogShell } from '../../ui/dialog.tsx';
import { Input } from '../../ui/input.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { SyncFrame } from './sync-frame.tsx';

type StashResult = z.infer<typeof StashResultViewSchema>;

function useAction(): {
  busy: boolean;
  error: ErrorView | null;
  run: (fn: () => Promise<unknown>) => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  return {
    busy,
    error,
    run: (fn) => {
      setBusy(true);
      setError(null);
      fn()
        .catch((e: unknown) => setError(e as ErrorView))
        .finally(() => setBusy(false));
    },
  };
}

export function BranchList({
  instance,
  branches,
  onSwitch,
  onCreate,
  onMerge,
  onDelete,
}: {
  instance: InstanceView;
  branches: BranchesView;
  onSwitch: (name: string, stash: boolean) => Promise<SwitchResultView>;
  onCreate: (name: string) => Promise<SwitchResultView>;
  onMerge: (name: string, remote?: boolean) => Promise<string>;
  onDelete: (name: string, force: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { busy, error, run } = useAction();
  const [name, setName] = useState('');
  const [blocked, setBlocked] = useState<{ name: string; files: string[] } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const after = (result: SwitchResultView, target: string) => {
    if (result.kind === 'localChanges') setBlocked({ name: target, files: result.files });
    if (result.kind === 'stashConflicts') {
      void navigate({ to: '/library/$instanceId/changes/conflicts', params: { instanceId: instance.id } });
    }
  };
  const merge = (target: string, remote: boolean) =>
    run(async () => {
      const outcome = await onMerge(target, remote);
      if (outcome === 'conflicts') {
        void navigate({ to: '/library/$instanceId/changes/conflicts', params: { instanceId: instance.id } });
      }
    });
  const company = branches.defaultBranch;
  const all = [
    ...branches.local.map((b) => ({ name: b.name, current: b.current, remote: false })),
    ...branches.remote.map((b) => ({ name: b.name, current: false, remote: true })),
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sync.branches.title')}</CardTitle>
        <CardDescription>{t('sync.branches.body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <ErrorMessage error={error} />}
        {company !== null && branches.current !== null && branches.current !== company && (
          <div>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => merge(company, true)}>
              <GitMerge aria-hidden="true" />
              {t('sync.branches.mergeCompany', { branch: company })}
            </Button>
          </div>
        )}
        <ul aria-label={t('sync.branches.listLabel')} className="flex flex-col divide-y divide-border">
          {all.map((branch) => (
            <li key={`${branch.remote}:${branch.name}`} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <GitBranch aria-hidden="true" className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 font-medium">
                {branch.name}
                {branch.name === branches.defaultBranch && (
                  <span className="ml-2 text-xs text-muted-foreground">{t('sync.branches.company')}</span>
                )}
                {branch.remote && (
                  <span className="ml-2 text-xs text-muted-foreground">{t('sync.branches.onServer')}</span>
                )}
              </span>
              {branch.current ? (
                <span className="text-xs font-medium">{t('sync.branches.current')}</span>
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => run(async () => after(await onSwitch(branch.name, false), branch.name))}
                  >
                    {t('sync.branches.switch')}
                  </Button>
                  {!branch.remote && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t('sync.branches.mergeLabel', { name: branch.name, current: branches.current ?? '' })}
                      onClick={() => merge(branch.name, false)}
                    >
                      <GitMerge aria-hidden="true" />
                      {t('sync.branches.merge')}
                    </Button>
                  )}
                  {!branch.remote && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t('sync.branches.deleteLabel', { name: branch.name })}
                      onClick={() => setDeleting(branch.name)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const target = name.trim();
            run(async () => {
              after(await onCreate(target), target);
              setName('');
            });
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            {t('sync.branches.newName')}
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('sync.branches.placeholder')}
            />
          </label>
          <Button type="submit" disabled={busy || name.trim() === ''}>
            {t('sync.branches.create')}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">{t('sync.branches.toolsSee')}</p>
        <DialogShell
          open={blocked !== null}
          onOpenChange={(open) => !open && setBlocked(null)}
          title={t('sync.branches.blockedTitle', { name: blocked?.name ?? '' })}
          description={t('sync.branches.blockedBody')}
          footer={
            <>
              <Link
                to="/library/$instanceId/changes"
                params={{ instanceId: instance.id }}
                className="inline-flex h-9 items-center rounded-md border border-border bg-secondary px-4 text-sm font-medium"
              >
                {t('sync.incoming.commitFirst')}
              </Link>
              <Button
                type="button"
                onClick={() => {
                  const target = blocked?.name ?? '';
                  setBlocked(null);
                  run(async () => after(await onSwitch(target, true), target));
                }}
              >
                {t('sync.branches.stashSwitch')}
              </Button>
            </>
          }
        >
          <ul className="flex flex-col gap-1">
            {blocked?.files.map((file) => (
              <li key={file} className="font-mono text-xs">
                {file}
              </li>
            ))}
          </ul>
        </DialogShell>
        <DialogShell
          open={deleting !== null}
          onOpenChange={(open) => !open && setDeleting(null)}
          title={t('sync.branches.deleteTitle', { name: deleting ?? '' })}
          description={t('sync.branches.deleteBody')}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setDeleting(null)}>
                {t('sync.cancel')}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  const target = deleting ?? '';
                  setDeleting(null);
                  run(() => onDelete(target, true));
                }}
              >
                {t('sync.branches.delete')}
              </Button>
            </>
          }
        />
      </CardContent>
    </Card>
  );
}

export function BranchesPage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId/changes/branches' });
  const instances = useDeviceQuery('instances');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const branches = useInstanceQuery(instance?.status === 'ready' ? instanceId : undefined, 'branches');
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  return (
    <SyncFrame instance={instance} title={t('sync.branches.pageTitle', { name: instance.name })}>
      {branches.error && <ErrorMessage error={branches.error as unknown as ErrorView} />}
      {branches.data && (
        <BranchList
          instance={instance}
          branches={branches.data}
          onSwitch={(name, stash) => callInstance(instanceId, 'switchBranch', { name, stash })}
          onCreate={(name) => callInstance(instanceId, 'createBranch', { name, switchTo: true })}
          onMerge={async (name, remote) => (await callInstance(instanceId, 'mergeBranch', { name, remote })).kind}
          onDelete={async (name, force) => {
            await callInstance(instanceId, 'deleteBranch', { name, force });
          }}
        />
      )}
    </SyncFrame>
  );
}

export function StashesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { instanceId } = useParams({ from: '/library/$instanceId/changes/stashes' });
  const instances = useDeviceQuery('instances');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const ready = instance?.status === 'ready' ? instanceId : undefined;
  const stashes = useInstanceQuery(ready, 'stashes');
  const status = useInstanceQuery(ready, 'syncStatus');
  const { busy, error, run } = useAction();
  const [message, setMessage] = useState('');
  const [drop, setDrop] = useState(true);
  const [blocked, setBlocked] = useState<string[] | null>(null);
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  const after = (result: StashResult) => {
    if (result.kind === 'conflicts')
      void navigate({ to: '/library/$instanceId/changes/conflicts', params: { instanceId } });
    if (result.kind === 'localChanges') setBlocked(result.files);
  };
  return (
    <SyncFrame instance={instance} title={t('sync.stashes.title', { name: instance.name })}>
      <Card>
        <CardHeader>
          <CardTitle>{t('sync.stashes.heading')}</CardTitle>
          <CardDescription>{t('sync.stashes.body')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error && <ErrorMessage error={error} />}
          {blocked && (
            <p role="alert" className="text-sm">
              {t('sync.stashes.blocked', { files: blocked.join(', ') })}
            </p>
          )}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await callInstance(instanceId, 'stash', { message });
                setMessage('');
              });
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              {t('sync.stashes.message')}
              <Input value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <Button type="submit" disabled={busy || (status.data?.changes ?? 0) === 0}>
              <Archive aria-hidden="true" />
              {t('sync.stashes.stash')}
            </Button>
          </form>
          {stashes.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('sync.stashes.none')}</p>}
          {stashes.data && stashes.data.length > 0 && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={drop}
                  onChange={(e) => setDrop(e.target.checked)}
                />
                {t('sync.stashes.dropAfter')}
              </label>
              <ul aria-label={t('sync.stashes.listLabel')} className="flex flex-col divide-y divide-border">
                {stashes.data.map((stash) => (
                  <li key={stash.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <span className="min-w-0 flex-1">{stash.message}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        run(async () =>
                          after(await callInstance(instanceId, 'applyStash', { index: stash.index, drop })),
                        )
                      }
                    >
                      {t('sync.stashes.apply')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t('sync.stashes.dropLabel', { message: stash.message })}
                      onClick={() => run(() => callInstance(instanceId, 'dropStash', { index: stash.index }))}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </SyncFrame>
  );
}
