// The conflict banner on every page of a library (PLAN.md §3.10 step 3): "Pull stopped: conflicts in acme-code-review"
// with [Resolve] and [Abort merge], until the conflicts are resolved.
import type { SyncStatusView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { Link } from '@tanstack/react-router';
import { Swords } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, useInstanceQuery } from '../../rpc/queries.ts';
import { Button, buttonVariants } from '../../ui/button.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';

/** The skills with conflicts, by name; the library's own files count as the library. */
export function conflictedSkills(status: SyncStatusView): string[] {
  return [...new Set(status.conflicts.map((c) => c.skill ?? ''))].filter((s) => s !== '').sort();
}

export function ConflictBannerView({
  instanceId,
  status,
  onAbort,
}: {
  instanceId: string;
  status: SyncStatusView;
  onAbort: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const stopped = status.operation !== 'none' || status.conflicts.length > 0;
  if (!stopped) return null;
  const skills = conflictedSkills(status);
  const kind = status.operation === 'none' ? 'stash' : status.operation;
  const done = status.conflicts.length === 0;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-md border border-danger bg-background p-3 text-sm"
      data-testid="conflict-banner"
    >
      <Swords aria-hidden="true" className="size-4 text-danger" />
      <span className="min-w-0 flex-1 font-medium">
        {done
          ? t(`sync.banner.ready.${kind}`)
          : skills.length > 0
            ? t(`sync.banner.stopped.${kind}`, { skills: skills.join(', ') })
            : t(`sync.banner.stoppedFiles.${kind}`, { count: status.conflicts.length })}
      </span>
      <Link
        to="/library/$instanceId/changes/conflicts"
        params={{ instanceId }}
        className={buttonVariants({ size: 'sm' })}
      >
        {t('sync.banner.resolve')}
      </Link>
      {kind !== 'stash' && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            onAbort()
              .catch((e: unknown) => setError(e as ErrorView))
              .finally(() => setBusy(false));
          }}
        >
          {t(`sync.banner.abort.${kind}`)}
        </Button>
      )}
      {error && <ErrorMessage error={error} />}
    </div>
  );
}

export function ConflictBanner({ instanceId }: { instanceId: string }) {
  const status = useInstanceQuery(instanceId, 'syncStatus');
  if (!status.data) return null;
  return (
    <ConflictBannerView
      instanceId={instanceId}
      status={status.data}
      onAbort={async () => {
        await callInstance(instanceId, 'abortOperation', {});
      }}
    />
  );
}
