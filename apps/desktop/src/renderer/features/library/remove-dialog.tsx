// Removing an instance (PLAN.md §3.8 S12, A4.15): from the library page, S9, the access-lost state, and when a setup
// is cancelled after the download. It asks about the library folder: kept by default, and the question says so when
// it holds work that isn't pushed. Afterwards it offers to drop another instance's local prefix that was there only
// because of this one (§3.3): that library's page opens with the offer.
import type { InstanceView, RemovalCheckView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, useDeviceQuery, useInstanceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';

export function RemoveDialogView({
  instance,
  home,
  check,
  open,
  busy,
  error,
  trigger,
  onOpenChange,
  onRemove,
}: {
  instance: InstanceView;
  home: string | undefined;
  check: RemovalCheckView | undefined;
  open: boolean;
  busy: boolean;
  error: ErrorView | null;
  /** remove: the access-lost state's button; cancel: the wizard's "Cancel setup"; library: the library page and S9. */
  trigger: 'remove' | 'cancel' | 'library';
  onOpenChange: (open: boolean) => void;
  onRemove: (deleteFolder: boolean) => void;
}) {
  const { t } = useTranslation();
  const [deleteFolder, setDeleteFolder] = useState(false);
  const unpushed = check !== undefined && (check.unpushedCommits > 0 || check.changedFiles > 0);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <Button
          type="button"
          size={trigger === 'library' ? 'sm' : 'default'}
          variant={trigger === 'cancel' ? 'ghost' : 'secondary'}
        >
          {trigger === 'library'
            ? t('remove.fromComputer', { name: instance.name })
            : t(trigger === 'remove' ? 'access.removeButton' : 'setup.cancelSetup')}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 flex w-[32rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border border-border bg-background p-6 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">{t('remove.title', { name: instance.name })}</Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">{t('remove.body')}</Dialog.Description>
          <p className="flex flex-col gap-1 text-sm">
            <span>{t('remove.folderKept')}</span>
            <PathText path={instance.libraryPath} home={home} />
          </p>
          {unpushed && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
              {t('remove.unpushed', {
                commits: t('remove.commits', { count: check.unpushedCommits }),
                files: t('remove.files', { count: check.changedFiles }),
              })}
            </p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={deleteFolder} onChange={(event) => setDeleteFolder(event.target.checked)} />
            {t('remove.deleteFolder')}
          </label>
          {error && <ErrorMessage error={error} />}
          <div className="flex justify-end gap-3">
            <Dialog.Close asChild>
              <Button type="button" variant="ghost">
                {t('remove.cancel')}
              </Button>
            </Dialog.Close>
            <Button type="button" disabled={busy} onClick={() => onRemove(deleteFolder)}>
              {t('remove.confirm')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function RemoveDialog({
  instance,
  home,
  trigger,
}: {
  instance: InstanceView;
  home: string | undefined;
  trigger: 'remove' | 'cancel' | 'library';
}) {
  const navigate = useNavigate();
  const instances = useDeviceQuery('instances');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const check = useInstanceQuery(open ? instance.id : undefined, 'removalCheck');
  return (
    <RemoveDialogView
      instance={instance}
      home={home}
      check={check.data}
      open={open}
      busy={busy}
      error={error}
      trigger={trigger}
      onOpenChange={setOpen}
      onRemove={(deleteFolder) => {
        setBusy(true);
        // Another library with a local prefix only because this one used its git prefix (PLAN.md §3.3).
        const freed = (instances.data ?? []).find(
          (other) =>
            other.id !== instance.id &&
            (other.localPrefix ?? null) !== null &&
            other.gitPrefix !== undefined &&
            other.gitPrefix !== null &&
            other.gitPrefix === instance.prefix,
        );
        callDevice('removeInstance', { instanceId: instance.id, deleteFolder })
          .then(() => {
            setOpen(false);
            if (freed) {
              offerPrefixDrop(freed.id);
              void navigate({ to: '/library/$instanceId', params: { instanceId: freed.id } });
            } else void navigate({ to: '/' });
          })
          .catch((e: unknown) => setError(e as ErrorView))
          .finally(() => setBusy(false));
      }}
    />
  );
}

/** The library whose page offers to drop its local prefix once it opens (S12, PLAN.md §3.3). */
let pendingOffer: string | null = null;

export function offerPrefixDrop(instanceId: string): void {
  pendingOffer = instanceId;
}

/** Whether this library's page opens with the offer. */
export function prefixOfferFor(instanceId: string): boolean {
  return pendingOffer === instanceId;
}

/** The offer was answered or closed. */
export function clearPrefixOffer(): void {
  pendingOffer = null;
}
