// Version history (PLAN.md §3.14, A10.9): past versions of a skill or of the instructions with author, date and message
// from git, a diff of a past version against the current one, and [Restore this version], which makes the skill
// "Modified on this device", to be committed and pushed as usual.
import { createDiffView } from '@app/editor';
import type { VersionEntryView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { History, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { DialogShell } from '../../ui/dialog.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { EventTime } from '../links/activity-page.tsx';

export function DiffView({
  before,
  after,
  fileName,
  label,
}: {
  before: string;
  after: string;
  fileName: string;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = createDiffView(host.current, { before, after, fileName, label });
    return () => view.destroy();
  }, [before, after, fileName, label]);
  return <div ref={host} data-testid="diff" className="rounded-md border border-input" />;
}

export interface HistoryActions {
  /** The file's text in a past version; null when it wasn't there. */
  readonly versionText: (commit: string) => Promise<string | null>;
  readonly restore: (commit: string) => Promise<void>;
}

export function HistoryPanel({
  versions,
  current,
  fileName,
  title,
  actions,
}: {
  versions: readonly VersionEntryView[] | undefined;
  /** The file's current text, for the diff. */
  current: string;
  /** The file the diff shows, e.g. SKILL.md. */
  fileName: string;
  /** What the history is of, e.g. the skill's name. */
  title: string;
  actions: HistoryActions;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<VersionEntryView | null>(null);
  const [loaded, setLoaded] = useState<{ commit: string; text: string | null } | null>(null);
  const past = selected && loaded?.commit === selected.commit ? loaded.text : undefined;
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    actions
      .versionText(selected.commit)
      .then((text) => {
        if (live) setLoaded({ commit: selected.commit, text });
      })
      .catch((e: unknown) => {
        if (live) setError(e as ErrorView);
      });
    return () => {
      live = false;
    };
  }, [selected, actions]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('editor.history.title')}</CardTitle>
        <CardDescription>{t('editor.history.body', { name: title })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <ErrorMessage error={error} />}
        {restored && (
          <p role="status" className="flex items-center gap-2 text-sm">
            <RotateCcw aria-hidden="true" className="size-4 text-success" />
            {t('editor.history.restored')}
          </p>
        )}
        {versions?.length === 0 && <p className="text-sm text-muted-foreground">{t('editor.history.none')}</p>}
        {versions && versions.length > 0 && (
          <ul aria-label={t('editor.history.versions')} className="flex flex-col divide-y divide-border">
            {versions.map((version) => (
              <li key={version.commit}>
                <button
                  type="button"
                  aria-pressed={selected?.commit === version.commit}
                  className="flex w-full flex-col items-start gap-0.5 px-2 py-2 text-left text-sm hover:bg-accent aria-pressed:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => setSelected(version)}
                >
                  <span className="font-medium">{version.subject}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <History aria-hidden="true" className="size-3" />
                    {version.author}
                    <EventTime ms={version.date} />
                    <span className="font-mono" data-volatile="">
                      {version.commit.slice(0, 7)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected && past !== undefined && (
          <section aria-label={t('editor.history.differences')} className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">{t('editor.history.compare', { subject: selected.subject })}</h3>
            {past === null ? (
              <p className="text-sm text-muted-foreground">{t('editor.history.notThere', { file: fileName })}</p>
            ) : (
              <DiffView before={past} after={current} fileName={fileName} label={t('editor.history.differences')} />
            )}
            <div>
              <Button type="button" onClick={() => setConfirm(true)}>
                <RotateCcw aria-hidden="true" />
                {t('editor.history.restore')}
              </Button>
            </div>
          </section>
        )}
        <DialogShell
          open={confirm}
          onOpenChange={setConfirm}
          title={t('editor.history.confirmTitle')}
          description={t('editor.history.confirmBody', { subject: selected?.subject ?? '' })}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setConfirm(false)}>
                {t('editor.cancel')}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (!selected) return;
                  setConfirm(false);
                  setError(null);
                  actions
                    .restore(selected.commit)
                    .then(() => {
                      setRestored(true);
                      setSelected(null);
                    })
                    .catch((e: unknown) => setError(e as ErrorView));
                }}
              >
                {t('editor.history.restore')}
              </Button>
            </>
          }
        />
      </CardContent>
    </Card>
  );
}
