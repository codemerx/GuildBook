// Changing the library's location (PLAN.md §3.9): the new place is checked as the user types or picks it (pre-flight:
// errors refuse it, a cloud folder gets a warning), then [Move library] runs the durable operation in the worker with
// the preview's hash. "Moving your library…" shows its steps; the summary says what changed. When Windows refuses
// the rename because a program has a file open, the user can try again or move it by copying (A9.4).
import type { InstanceView, RelocationPreviewView, RelocationSummaryView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { FolderOpen, Info, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, callInstance, queryInstance } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { Input, Label } from '../../ui/input.tsx';
import { displayPath, PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { LocationResult } from '../setup/steps.tsx';
import { relocationMessage } from './relocation-text.ts';
import { announceRelocation } from './summary-host.tsx';

export interface RelocationActions {
  preview(to: string): Promise<RelocationPreviewView>;
  relocate(
    to: string,
    planHash: string,
    copy: boolean,
    onProgress: (progress: { done: number; total: number }) => void,
  ): Promise<RelocationSummaryView>;
  choose(): Promise<string | null>;
}

export function relocationActions(instanceId: string): RelocationActions {
  return {
    preview: (to) => queryInstance(instanceId, 'previewRelocation', { to }),
    relocate: (to, planHash, copy, onProgress) =>
      callInstance(instanceId, 'relocate', { to, planHash, ...(copy ? { copy } : {}) }, onProgress as never),
    choose: async () => (await callDevice('chooseFolder', { purpose: 'relocation' })).path,
  };
}

/** `~/Work/acme` as the full path: the field takes paths as the app shows them. */
export function expandHome(value: string, home: string | undefined): string {
  const trimmed = value.trim();
  if (!home) return trimmed;
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return `${home}${trimmed.slice(1)}`;
  return trimmed;
}

type Phase =
  | { readonly kind: 'choose' }
  | { readonly kind: 'moving'; readonly done: number; readonly total: number }
  | { readonly kind: 'blocked'; readonly to: string; readonly hash: string };

export function RelocationDialog({
  instance,
  home,
  actions,
  onOpenChange,
}: {
  instance: InstanceView;
  home: string | undefined;
  actions: RelocationActions;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<{ for: string; view: RelocationPreviewView } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [error, setError] = useState<ErrorView | null>(null);
  // Each path is checked once the typing pauses; a picked folder at once.
  useEffect(() => {
    const to = expandHome(path, home);
    if (to === '') return;
    const timer = setTimeout(
      () =>
        void actions.preview(to).then(
          (view) => setPreview({ for: to, view }),
          () => undefined,
        ),
      200,
    );
    return () => clearTimeout(timer);
  }, [path, home, actions]);
  const current = preview?.for === expandHome(path, home) ? preview.view : null;
  const ready = current !== null && current.problems.length === 0 && phase.kind === 'choose';
  const move = (to: string, hash: string, copy: boolean) => {
    setError(null);
    setPhase({ kind: 'moving', done: 0, total: 4 });
    actions
      .relocate(to, hash, copy, (progress) => setPhase({ kind: 'moving', ...progress }))
      .then((summary) => {
        // The worker starts again at the new place now: the summary waits above every page.
        announceRelocation(instance.name, summary);
        onOpenChange(false);
      })
      .catch((e: unknown) => {
        const failure = e as ErrorView;
        if (failure.code === 'relocation.renameBlocked') setPhase({ kind: 'blocked', to, hash });
        else {
          setError(failure);
          setPhase({ kind: 'choose' });
        }
      });
  };
  const moving = phase.kind === 'moving';
  return (
    <DialogShell
      open
      // The move can't be left half-way from here: the dialog stays until it ends.
      onOpenChange={(open) => !moving && onOpenChange(open)}
      title={t('relocation.title', { name: instance.name })}
      description={phase.kind === 'choose' ? t('relocation.body') : undefined}
      footer={
        phase.kind === 'blocked' ? (
          <>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                {t('relocation.cancel')}
              </Button>
            </DialogClose>
            <Button type="button" variant="secondary" onClick={() => move(phase.to, phase.hash, true)}>
              {t('relocation.copyInstead')}
            </Button>
            <Button type="button" onClick={() => move(phase.to, phase.hash, false)}>
              {t('relocation.retry')}
            </Button>
          </>
        ) : (
          <>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={moving}>
                {t('relocation.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={!ready || moving}
              onClick={() => current && move(current.path, current.hash, false)}
            >
              {t('relocation.move')}
            </Button>
          </>
        )
      }
    >
      {phase.kind === 'choose' && (
        <div className="flex flex-col gap-3">
          <p className="flex flex-wrap items-baseline gap-1 text-sm">
            {t('relocation.now')}
            <PathText path={instance.libraryPath} home={home} />
          </p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="relocation-path">{t('relocation.newLocation')}</Label>
            <div className="flex gap-2">
              <Input
                id="relocation-path"
                value={path}
                spellCheck={false}
                onChange={(event) => setPath(event.target.value)}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  void actions.choose().then((picked) => picked !== null && setPath(displayPath(picked, home)))
                }
              >
                <FolderOpen aria-hidden="true" />
                {t('relocation.choose')}
              </Button>
            </div>
          </div>
          {current && <LocationResult check={current} message={(code, params) => relocationMessage(t, code, params)} />}
          {current && current.problems.length === 0 && (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {t(current.method === 'rename' ? 'relocation.sameDisk' : 'relocation.otherDisk')}
            </p>
          )}
        </div>
      )}
      {moving && (
        <p className="flex items-center gap-2 text-sm" role="status">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          {t('relocation.moving', { step: Math.min(phase.done + 1, phase.total), total: phase.total })}
        </p>
      )}
      {phase.kind === 'blocked' && <p className="text-sm">{t('relocation.blocked')}</p>}
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}
