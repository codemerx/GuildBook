// The import screen (PLAN.md §3.18, IMPLEMENTATION.md Step 13): the source picker (a skills repo URL, a folder, an
// existing skill, a zip), the table of found skills with the review gate, what isn't imported, and the import report.
// Each selected skill must be opened in the editor before [Add] (a ✓ appears once opened).
import type { ImportReportView, ImportSessionView, NotImportedView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { Link, useParams } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, FileArchive, Folder, FolderGit2, GitBranch, Package } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, callInstance, useDeviceQuery, useInstanceQuery } from '../../rpc/queries.ts';
import { Button, buttonVariants } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { Input, Label } from '../../ui/input.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { EditorFrame } from '../editor/editor-frame.tsx';
import { useEditorContext } from '../editor/skill-editor-page.tsx';
import { gateOf, selectedIn, useSelectionStore } from './import-selection.ts';

type Source = { kind: 'url'; url: string } | { kind: 'folder'; path: string } | { kind: 'archive'; path: string };

/** An error of the import, as the user reads it: a refused archive says why. */
export function ImportError({ error }: { error: ErrorView }) {
  const { t } = useTranslation();
  if (error.code === 'import.archiveRefused') {
    const reason = String(error.params.reason ?? '');
    return (
      <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
        <span className="flex flex-col gap-1">
          <span className="font-medium">{t('imports.archive.refused')}</span>
          <span>{t(`imports.archive.${reason}`, { path: String(error.params.path ?? ''), defaultValue: reason })}</span>
        </span>
      </div>
    );
  }
  return <ErrorMessage error={error} />;
}

/** PLAN.md §3.18 A: the library's sign-in can't read the repo; a local clone can be imported instead. */
export function CannotReadOffer({ repo, onChooseClone }: { repo: string; onChooseClone: () => void }) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t('imports.cannotRead.title')}
      className="flex flex-col gap-3 rounded-md border border-warning/50 bg-warning/10 p-4 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle aria-hidden="true" className="size-4 text-warning" />
        {t('imports.cannotRead.title')}
      </p>
      <p>{t('imports.cannotRead.body', { repo })}</p>
      <p className="text-muted-foreground">{t('imports.cannotRead.github')}</p>
      <div>
        <Button size="sm" onClick={onChooseClone}>
          {t('imports.cannotRead.chooseClone')}
        </Button>
      </div>
    </section>
  );
}

export function SourcePicker({
  busy,
  onStart,
  onChooseFolder,
  onChooseSkill,
  onChooseArchive,
}: {
  busy: boolean;
  onStart: (url: string) => void;
  onChooseFolder: () => void;
  onChooseSkill: () => void;
  onChooseArchive: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [url, setUrl] = useState('');
  return (
    <div className="flex flex-col gap-4" aria-busy={busy}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch aria-hidden="true" className="size-4" />
            {t('imports.sources.repo.title')}
          </CardTitle>
          <CardDescription>{t('imports.sources.repo.body')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (url.trim() !== '') onStart(url.trim());
            }}
          >
            <Label htmlFor={`${id}-url`}>{t('imports.sources.repo.url')}</Label>
            <div className="flex gap-2">
              <Input
                id={`${id}-url`}
                value={url}
                placeholder={t('imports.sources.repo.placeholder')}
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
              />
              <Button type="submit" disabled={busy || url.trim() === ''}>
                {t('imports.sources.repo.read')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <div className="grid grid-cols-3 gap-4">
        <SourceCard
          icon={FolderGit2}
          title={t('imports.sources.folder.title')}
          body={t('imports.sources.folder.body')}
          action={t('imports.sources.folder.choose')}
          busy={busy}
          onClick={onChooseFolder}
        />
        <SourceCard
          icon={Folder}
          title={t('imports.sources.skill.title')}
          body={t('imports.sources.skill.body')}
          action={t('imports.sources.skill.choose')}
          busy={busy}
          onClick={onChooseSkill}
        />
        <SourceCard
          icon={FileArchive}
          title={t('imports.sources.archive.title')}
          body={t('imports.sources.archive.body')}
          action={t('imports.sources.archive.choose')}
          busy={busy}
          onClick={onChooseArchive}
        />
      </div>
      <p className="text-sm text-muted-foreground">{t('imports.sources.reviewRule')}</p>
    </div>
  );
}

function SourceCard({
  icon: Icon,
  title,
  body,
  action,
  busy,
  onClick,
}: {
  icon: typeof Folder;
  title: string;
  body: string;
  action: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon aria-hidden="true" className="size-4" />
          {title}
        </CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
      <CardContent className="mt-auto">
        <Button variant="outline" size="sm" disabled={busy} onClick={onClick}>
          {action}
        </Button>
      </CardContent>
    </Card>
  );
}

function NotImportedList({ items }: { items: readonly NotImportedView[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <section aria-label={t('imports.notImported.title')} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('imports.notImported.title')}</h3>
      <p className="text-sm text-muted-foreground">{t('imports.notImported.body')}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((item) => (
          <li key={item.path} className="flex gap-2">
            <span className="w-28 shrink-0 text-muted-foreground">{t(`imports.notImported.${item.kind}`)}</span>
            <span className="font-mono text-xs leading-5">{item.path}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Where a skill was found, as the table shows it: the source itself when it's one skill; a long path breaks after a slash. */
function FoundAt({ path }: { path: string }) {
  const { t } = useTranslation();
  if (path === '') return <>{t('imports.table.theSource')}</>;
  return (
    <>
      {path.split('/').map((part, index) => (
        <Fragment key={index}>
          {part}/<wbr />
        </Fragment>
      ))}
    </>
  );
}

export function FoundSkills({
  instanceId,
  session,
  home,
  busy,
  onAdd,
  onCancel,
}: {
  instanceId: string;
  session: ImportSessionView;
  home: string | undefined;
  busy: boolean;
  onAdd: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const chosen = useSelectionStore((state) => state.chosen);
  const setChosen = useSelectionStore((state) => state.set);
  const selected = selectedIn(session, chosen);
  const gate = gateOf(session, selected);
  const toggle = (id: string, on: boolean) =>
    setChosen(session.id, on ? [...selected, id] : selected.filter((other) => other !== id));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('imports.table.title', { count: session.candidates.length })}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-1">
          {t(`imports.table.from.${session.source.kind}`)}
          {session.source.kind === 'url' ? (
            <span className="font-mono text-xs">{session.source.label}</span>
          ) : (
            <PathText path={session.source.label} home={home} />
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {session.candidates.length === 0 ? (
          <p className="text-sm">{t('imports.table.none')}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="w-10 py-2 font-medium">
                  <span className="sr-only">{t('imports.table.add')}</span>
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('imports.table.foundAt')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('imports.table.becomes')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('imports.table.notes')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('imports.table.review')}
                </th>
              </tr>
            </thead>
            <tbody>
              {session.candidates.map((candidate) => {
                const notes = [
                  candidate.scripts && t('imports.notes.scripts'),
                  candidate.allowedTools && t('imports.notes.allowedTools'),
                  candidate.fixed && t('imports.notes.fixed'),
                  candidate.clash && t(`imports.notes.clash.${candidate.clash}`),
                ].filter((note): note is string => typeof note === 'string');
                return (
                  <tr key={candidate.id} className="border-b border-border last:border-0">
                    <td className="py-2 align-top">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        aria-label={t('imports.table.select', { name: candidate.name })}
                        checked={selected.includes(candidate.id)}
                        onChange={(event) => toggle(candidate.id, event.target.checked)}
                      />
                    </td>
                    <td className="py-2 pr-3 align-top font-mono text-xs leading-5">
                      <FoundAt path={candidate.foundAt} />
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 align-top font-mono text-xs leading-5">
                      {candidate.name}
                    </td>
                    <td className="py-2 align-top text-xs">
                      {notes.length === 0 ? (
                        <span aria-label={t('imports.notes.none')}>—</span>
                      ) : (
                        <ul className="flex flex-col gap-0.5">
                          {notes.map((note) => (
                            <li key={note} className="flex items-center gap-1">
                              <AlertTriangle aria-hidden="true" className="size-3 shrink-0 text-warning" />
                              {note}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="py-2 align-top">
                      <span className="flex items-center gap-2">
                        {candidate.opened && (
                          <CheckCircle2
                            role="img"
                            aria-label={t('imports.table.reviewed')}
                            className="size-4 text-success"
                          />
                        )}
                        <Link
                          to="/library/$instanceId/edit/import/$candidate"
                          params={{ instanceId, candidate: candidate.id }}
                          className={buttonVariants({ size: 'sm', variant: candidate.opened ? 'ghost' : 'outline' })}
                          aria-label={t('imports.table.open', { name: candidate.name })}
                        >
                          {candidate.opened ? t('imports.table.openAgain') : t('imports.table.openFirst')}
                        </Link>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <NotImportedList items={session.notImported} />
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button disabled={!gate.canAdd || busy} onClick={() => onAdd(selected)}>
            {t('imports.table.addCount', { count: selected.length })}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            {t('imports.table.cancel')}
          </Button>
          <p role="status" className="text-sm text-muted-foreground">
            {selected.length === 0
              ? t('imports.gate.nothing')
              : gate.waiting > 0
                ? t('imports.gate.waiting', { count: gate.waiting })
                : t('imports.gate.ready')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function ImportReport({
  instanceId,
  report,
  onMore,
}: {
  instanceId: string;
  report: ImportReportView;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package aria-hidden="true" className="size-4" />
          {t('imports.report.title', { count: report.added.length })}
        </CardTitle>
        <CardDescription>{t('imports.report.body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <section aria-label={t('imports.report.added')} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('imports.report.added')}</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {report.added.map((added) => (
              <li key={added.name} className="flex items-center gap-2">
                <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
                <Link
                  to="/library/$instanceId/edit/skill/$skill"
                  params={{ instanceId, skill: added.name }}
                  className="font-mono text-xs underline-offset-2 hover:underline"
                >
                  {added.name}
                </Link>
                {added.foundAt !== '' && (
                  <span className="text-xs text-muted-foreground">
                    {t('imports.report.from', { path: `${added.foundAt}/` })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
        {report.notImported.length > 0 ? (
          <NotImportedList items={report.notImported} />
        ) : (
          <p className="text-sm text-muted-foreground">{t('imports.report.nothingLeft')}</p>
        )}
        <div className="flex flex-wrap gap-3 border-t border-border pt-4">
          <Link to="/library/$instanceId/changes" params={{ instanceId }} className={buttonVariants({})}>
            {t('imports.report.toChanges')}
          </Link>
          <Button variant="outline" onClick={onMore}>
            {t('imports.report.more')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ImportPage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId/edit/import' });
  const context = useEditorContext(instanceId);
  const appInfo = useDeviceQuery('appInfo');
  const ready = context.usable ? instanceId : undefined;
  const session = useInstanceQuery(ready, 'importSession');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [report, setReport] = useState<ImportReportView | null>(null);
  const home = appInfo.data?.homePath;

  const start = async (source: Source) => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      await callInstance(instanceId, 'startImport', source);
    } catch (e) {
      setError(e as ErrorView);
    } finally {
      setBusy(false);
    }
  };
  const chooseFolder = async (purpose: 'import-folder' | 'import-skill') => {
    const { path } = await callDevice('chooseFolder', { purpose });
    if (path !== null) await start({ kind: 'folder', path });
  };
  const chooseArchive = async () => {
    const { path } = await callDevice('chooseImportFile', {});
    if (path !== null) await start({ kind: 'archive', path });
  };

  if (!context.instance) return context.loading ? null : <p>{t('library.notFound')}</p>;
  const cannotRead = error?.code === 'import.cannotRead' ? String(error.params.repo ?? '') : null;
  return (
    <EditorFrame instance={context.instance} snapshot={context.snapshot} localPrefix={context.localPrefix}>
      <div className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t('imports.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('imports.body')}</p>
        </header>
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('imports.reading')}
          </p>
        )}
        {cannotRead !== null ? (
          <CannotReadOffer repo={cannotRead} onChooseClone={() => void chooseFolder('import-folder')} />
        ) : (
          error && <ImportError error={error} />
        )}
        {report ? (
          <ImportReport instanceId={instanceId} report={report} onMore={() => setReport(null)} />
        ) : session.data ? (
          <FoundSkills
            instanceId={instanceId}
            session={session.data}
            home={home}
            busy={busy}
            onAdd={(ids) => {
              setBusy(true);
              setError(null);
              callInstance(instanceId, 'addImportedSkills', { ids })
                .then((added) => setReport(added))
                .catch((e: unknown) => setError(e as ErrorView))
                .finally(() => setBusy(false));
            }}
            onCancel={() => {
              setError(null);
              void callInstance(instanceId, 'cancelImport', {}).catch((e: unknown) => setError(e as ErrorView));
            }}
          />
        ) : (
          <SourcePicker
            busy={busy}
            onStart={(url) => void start({ kind: 'url', url })}
            onChooseFolder={() => void chooseFolder('import-folder')}
            onChooseSkill={() => void chooseFolder('import-skill')}
            onChooseArchive={() => void chooseArchive()}
          />
        )}
        {report === null && session.data === null && (
          <p className="text-xs text-muted-foreground">{t('imports.sources.untouched')}</p>
        )}
      </div>
    </EditorFrame>
  );
}
