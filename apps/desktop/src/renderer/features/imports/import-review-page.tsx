// The mandatory review of one found skill (PLAN.md §3.18 "Rule for every import"): opening it here gives it its ✓. It
// shows the skill as it will be added, with the change from the import highlighted; its files with `scripts/`,
// `allowed-tools` and links inside the skill flagged; the validation problems; and the mentions of the old names, which
// the reviewer fixes by hand in the editor below.
import type { ImportReviewView, IssueView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, CheckCircle2, FileCode2, Link2, ShieldAlert, XCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, useDeviceQuery } from '../../rpc/queries.ts';
import { Button, buttonVariants } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { Input, Label } from '../../ui/input.tsx';
import { displayPath, PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { EditorFrame } from '../editor/editor-frame.tsx';
import { EditorSurface } from '../editor/editor-surface.tsx';
import { DiffView } from '../editor/history-panel.tsx';
import { ChangedOnDiskDialog, SaveStatus } from '../editor/save-status.tsx';
import { useEditorContext } from '../editor/skill-editor-page.tsx';
import { useFileEditor } from '../editor/use-file-editor.ts';

/** The review's cache key: the review command marks the skill opened and answers what the page shows. */
export const reviewKey = (instanceId: string, id: string) => ['instance', instanceId, 'importReview', id] as const;

export function ReviewFlags({ review, home }: { review: ImportReviewView; home: string | undefined }) {
  const { t } = useTranslation();
  const { flags } = review;
  const none = flags.scripts.length === 0 && flags.allowedTools === null && flags.links.length === 0;
  return (
    <section aria-label={t('imports.review.flags.title')} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('imports.review.flags.title')}</h3>
      {none ? (
        <p className="text-sm text-muted-foreground">{t('imports.review.flags.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {flags.scripts.length > 0 && (
            <li className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3">
              <FileCode2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
              <span className="flex flex-col gap-1">
                <span className="font-medium">
                  {t('imports.review.flags.scripts', { count: flags.scripts.length })}
                </span>
                <span className="text-muted-foreground">{t('imports.review.flags.scriptsBody')}</span>
                <span className="font-mono text-xs">{flags.scripts.join(', ')}</span>
              </span>
            </li>
          )}
          {flags.allowedTools !== null && (
            <li className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3">
              <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{t('imports.review.flags.allowedTools')}</span>
                <span className="text-muted-foreground">{t('imports.review.flags.allowedToolsBody')}</span>
                <span className="font-mono text-xs">
                  {t('imports.review.flags.allowedToolsValue', { value: flags.allowedTools })}
                </span>
              </span>
            </li>
          )}
          {flags.links.map((link) => (
            <li
              key={link.path}
              className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3"
            >
              <Link2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{t('imports.review.flags.link', { path: link.path })}</span>
                <span className="text-muted-foreground">{t('imports.review.flags.linkBody')}</span>
                <span className="flex flex-wrap items-center gap-1 text-xs">
                  {t('imports.review.flags.linkTarget')} <PathText path={link.target} home={home} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A problem's message; a path in it is shown as people read it, with ~ for the home folder. */
function IssueList({ issues, home }: { issues: readonly IssueView[]; home: string | undefined }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('imports.review.problems.title')} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('imports.review.problems.title')}</h3>
      {issues.length === 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
          {t('imports.review.problems.none')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {issues.map((issue) => (
            <li key={`${issue.code}:${issue.path}`} className="flex items-start gap-2">
              {issue.severity === 'error' ? (
                <XCircle
                  role="img"
                  aria-label={t('editor.checks.error')}
                  className="mt-0.5 size-4 shrink-0 text-danger"
                />
              ) : (
                <AlertTriangle
                  role="img"
                  aria-label={t('editor.checks.warning')}
                  className="mt-0.5 size-4 shrink-0 text-warning"
                />
              )}
              <span>
                {t(issue.messageKey, {
                  ...issue.params,
                  ...(typeof issue.params.target === 'string'
                    ? { target: displayPath(issue.params.target, home) }
                    : {}),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Mentions({ review }: { review: ImportReviewView }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('imports.review.mentions.title')} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('imports.review.mentions.title')}</h3>
      {review.mentions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('imports.review.mentions.none')}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t('imports.review.mentions.body')}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {review.mentions.map((mention) => (
              <li key={`${mention.file}:${mention.line}:${mention.name}`} className="flex flex-col">
                <span className="text-xs text-muted-foreground">
                  {t('imports.review.mentions.where', { file: mention.file, line: mention.line, name: mention.name })}
                </span>
                <span className="font-mono text-xs">{mention.text}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RenameField({ review, onRename }: { review: ImportReviewView; onRename: (name: string) => Promise<void> }) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState(review.candidate.name);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void onRename(name.trim()).finally(() => setBusy(false));
      }}
    >
      <Label htmlFor={`${id}-name`}>{t('imports.review.name')}</Label>
      <div className="flex gap-2">
        <Input
          id={`${id}-name`}
          value={name}
          className="font-mono"
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={busy || name.trim() === review.candidate.name}>
          {t('imports.review.rename')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('imports.review.oldName', { name: review.candidate.oldName })}</p>
    </form>
  );
}

/** The staged SKILL.md, edited as in the editor: the reviewer's changes are saved into the copy to be added. */
function StagedEditor({ instanceId, id }: { instanceId: string; id: string }) {
  const { t } = useTranslation();
  const editor = useFileEditor(instanceId, 'SKILL.md', true, { kind: 'import', id });
  if (editor.error) return <ErrorMessage error={editor.error} />;
  if (editor.text === null) return null;
  return (
    <section aria-label={t('imports.review.editor')} className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('imports.review.editor')}</h3>
        <SaveStatus state={editor.state} />
      </div>
      <EditorSurface
        text={editor.text}
        version={editor.version}
        mode="source"
        fileName="SKILL.md"
        label={t('imports.review.editorLabel')}
        onChange={editor.edit}
      />
      <ChangedOnDiskDialog
        open={editor.state.status === 'conflict'}
        file="SKILL.md"
        onKeepMine={() => void editor.keepMine()}
        onUseDisk={editor.useDisk}
      />
    </section>
  );
}

export function ImportReviewPage() {
  const { t } = useTranslation();
  const { instanceId, candidate } = useParams({ from: '/library/$instanceId/edit/import/$candidate' });
  const context = useEditorContext(instanceId);
  const appInfo = useDeviceQuery('appInfo');
  const [error, setError] = useState<ErrorView | null>(null);
  const review = useQuery({
    queryKey: reviewKey(instanceId, candidate),
    enabled: context.usable,
    queryFn: () => callInstance(instanceId, 'reviewImportSkill', { id: candidate }),
  });
  if (!context.instance) return context.loading ? null : <p>{t('library.notFound')}</p>;
  const home = appInfo.data?.homePath;
  const data = review.data;
  return (
    <EditorFrame instance={context.instance} snapshot={context.snapshot} localPrefix={context.localPrefix}>
      <div className="flex flex-col gap-4">
        <Link
          to="/library/$instanceId/edit/import"
          params={{ instanceId }}
          className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'self-start' })}
        >
          <ArrowLeft aria-hidden="true" />
          {t('imports.review.back')}
        </Link>
        {review.error && <ErrorMessage error={review.error as unknown as ErrorView} />}
        {error && <ErrorMessage error={error} />}
        {!data ? (
          !review.error && <p className="text-sm text-muted-foreground">{t('editor.loading')}</p>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="font-mono">{t('imports.review.title', { name: data.candidate.name })}</span>
                <span className="flex items-center gap-1 text-xs font-normal text-success">
                  <CheckCircle2 aria-hidden="true" className="size-4" />
                  {t('imports.table.reviewed')}
                </span>
              </CardTitle>
              <CardDescription>
                {data.candidate.foundAt === ''
                  ? t('imports.review.foundSource')
                  : t('imports.review.foundAt', { path: `${data.candidate.foundAt}/` })}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <RenameField
                key={data.candidate.name}
                review={data}
                onRename={async (name) => {
                  setError(null);
                  try {
                    await callInstance(instanceId, 'renameImportSkill', { id: candidate, name });
                    await review.refetch();
                  } catch (e) {
                    setError(e as ErrorView);
                  }
                }}
              />
              <ReviewFlags review={data} home={home} />
              <IssueList issues={data.issues} home={home} />
              <Mentions review={data} />
              <section aria-label={t('imports.review.changes')} className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{t('imports.review.changes')}</h3>
                <p className="text-sm text-muted-foreground">{t('imports.review.changesBody')}</p>
                <DiffView
                  before={data.original}
                  after={data.staged}
                  fileName="SKILL.md"
                  label={t('imports.review.changesLabel')}
                />
              </section>
              <StagedEditor key={candidate} instanceId={instanceId} id={candidate} />
              <section aria-label={t('imports.review.files')} className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{t('imports.review.files')}</h3>
                <ul className="flex flex-col gap-0.5 font-mono text-xs">
                  {data.files.map((file) => {
                    const flagged =
                      file.kind === 'link' || (file.kind === 'file' && data.flags.scripts.includes(file.path));
                    return (
                      <li key={file.path} className="flex items-center gap-2">
                        {flagged && (
                          <AlertTriangle
                            role="img"
                            aria-label={t('imports.review.flagged')}
                            className="size-3 shrink-0 text-warning"
                          />
                        )}
                        <span>{file.kind === 'dir' ? `${file.path}/` : file.path}</span>
                        {file.kind === 'link' && (
                          <span className="font-sans text-muted-foreground">{t('imports.review.isLink')}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            </CardContent>
          </Card>
        )}
      </div>
    </EditorFrame>
  );
}
