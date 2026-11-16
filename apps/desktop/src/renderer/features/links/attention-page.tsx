// "Needs attention" (PLAN.md §3.8): every red warning of a library, with the choices PLAN gives for each.
// - S2 a taken name: [Move my folder] [Overwrite] [Don't install it in <tool> on this device]
// - S3 a removed link: [Reinstall] [Don't install it…]
// - S4 a changed copy: [Show differences] and four choices
// - S5 another tool's link: [Take it back] [Leave it]
// - S8 deleted through the link: [Restore]
// - S2 in a code repo, a skill the repo commits: [Don't place it in this repo] (Step 6)
// - S10 a repo folder gone: [Locate…] [Remove repo] (its confirmation asks about each skill it leaves in no repo);
//   S11 a skill visible twice: [Keep repo only] [Keep global only]
// - a ticked tag that no longer exists: [Use another tag] [Remove the rule]
// - a projected copy whose two sides changed: [Show the differences and decide]; a name too long under the local
//   prefix: [Change the local prefix] (Step 8)
// - a copy-mode copy edited where it is: [Show differences], then bring the change into the library, replace the copy,
//   or leave it (Step 16)
// Every answer is a plan the worker previews; [Apply] sends its hash back (IMPLEMENTATION.md §2.5).
import type {
  AttentionItemView,
  FileDifferenceSchema,
  InstanceView,
  LinkDecisionView,
  OverviewView,
  PlacementEditView,
} from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useParams } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, FileDiff, Info } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { callInstance, queryInstance, useDeviceQuery, useInstanceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { Input } from '../../ui/input.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { AdoptPrefixAnswer } from '../prefix/adopt-prefix.tsx';
import { type PlacementActions, placementActions } from '../placement/placement-confirm.tsx';
import { RemovalConfirm } from '../placement/removal-confirm.tsx';
import { CopyAnswers, type CopyActions, copyActions } from '../projection/copy-answers.tsx';
import { LIBRARY_ITEMS, LibraryAnswers, type LibraryActions, libraryActions } from '../relocation/library-answers.tsx';
import { LibraryNav } from './library-nav.tsx';
import { pickFolder } from '../shell/folder-access.tsx';

type FileDifference = z.infer<typeof FileDifferenceSchema>;

export interface AttentionActions {
  decide(item: AttentionItemView, decision: LinkDecisionView): Promise<void>;
  restore(item: AttentionItemView): Promise<void>;
  differences(item: AttentionItemView): Promise<FileDifference[]>;
  /** A placement change answers it (Step 6): previewed, then applied with its plan's hash. */
  place(edits: readonly PlacementEditView[]): Promise<void>;
  /** A placement change with its own confirmation: S10 [Remove repo]. */
  placement: PlacementActions;
  /** S10 [Locate…]: picks the repo's new folder. */
  locate(repoId: string): Promise<void>;
  /** A projected copy's both-changed answer (Step 8). */
  copies: CopyActions;
  /** The instance-wide items (Step 9): S9, lost connections, a move that stopped. */
  library: LibraryActions;
}

/** The answers placement gives (Step 6): S2 in a repo, S10, S11 and a tag gone. */
function PlacementAnswers({
  item,
  overview,
  actions,
  busy,
  run,
}: {
  item: AttentionItemView;
  overview: OverviewView | undefined;
  actions: AttentionActions;
  busy: boolean;
  run: (task: () => Promise<void>) => void;
}) {
  const { t } = useTranslation();
  const [tag, setTag] = useState('');
  const [removing, setRemoving] = useState(false);
  const skill = item.skill ?? '';
  if (item.kind === 'skipped' && item.reason === 'committed' && item.repoId) {
    const repo = item.repoId;
    return (
      <div>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => run(() => actions.place([{ op: 'exclude', repo, skill, on: true }]))}
        >
          {t('placement.actions.dontPlace')}
        </Button>
      </div>
    );
  }
  if (item.kind === 'duplicate') {
    // The extra link is the one the app didn't make: keeping its side is a placement change, the other drops it.
    const drop = () => actions.decide(item, { kind: 'drop-duplicate' });
    const repo = item.repoId;
    const keepRepo = repo ? () => actions.place([{ op: 'add', repo, skill, on: true }]) : drop;
    const keepGlobal = repo ? drop : () => actions.place([{ op: 'mode', skill, mode: 'global' }]);
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => run(keepRepo)}>
          {t('placement.actions.keepRepo')}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => run(keepGlobal)}>
          {t('placement.actions.keepGlobal')}
        </Button>
      </div>
    );
  }
  if (item.kind === 'repo-missing' && item.repoId) {
    const repo = item.repoId;
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => run(() => actions.locate(repo))}>
          {t('placement.repo.locate')}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setRemoving(true)}>
          {t('placement.repo.remove')}
        </Button>
        {removing && (
          <RemovalConfirm
            actions={actions.placement}
            onOpenChange={setRemoving}
            title={t('placement.repo.removeTitle', { repo: item.repo ?? '' })}
            description={t('placement.repo.removeBody')}
            label={t('placement.repo.remove')}
            edits={[{ op: 'remove-repo', repo }]}
          />
        )}
      </div>
    );
  }
  if (item.kind === 'tag-gone' && item.tag) {
    const gone = item.tag;
    const repos = overview?.repos.filter((repo) => repo.rules.includes(gone)) ?? [];
    const tags = overview?.tags.map((entry) => entry.tag) ?? [];
    return (
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t('placement.actions.otherTag')}</span>
          <select
            aria-label={t('placement.actions.otherTag')}
            className="h-8 rounded-md border border-input bg-background px-2"
            value={tag}
            onChange={(event) => setTag(event.target.value)}
          >
            <option value="">{t('placement.actions.chooseTag')}</option>
            {tags.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          size="sm"
          disabled={busy || tag === ''}
          onClick={() =>
            run(() => actions.place(repos.map((repo) => ({ op: 'retag', repo: repo.id, from: gone, to: tag }))))
          }
        >
          {tag === '' ? t('placement.actions.useAnother') : t('placement.actions.useTag', { tag })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            run(() => actions.place(repos.map((repo) => ({ op: 'rule', repo: repo.id, tag: gone, on: false }))))
          }
        >
          {t('placement.actions.removeRule')}
        </Button>
      </div>
    );
  }
  return null;
}

/** The suggested name for the user's own copy: no prefix, and `-mine` (PLAN.md §3.8 S2, S4). */
export function mineName(skill: string, prefix: string | null): string {
  const bare = prefix && skill.startsWith(`${prefix}-`) ? skill.slice(prefix.length + 1) : skill;
  return `${bare}-mine`.slice(0, 64);
}

function toolsText(item: AttentionItemView, fallback: string): string {
  return item.tools.length > 0 ? item.tools.join(', ') : fallback;
}

/** [Move my folder] (S2) and "Keep my version as my own skill" (S4): a new name, and the name line shown. */
function MoveDialog({
  item,
  prefix,
  open,
  onOpenChange,
  rewriteOption,
  onMove,
}: {
  item: AttentionItemView;
  prefix: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** S2 lets the user keep the name line; S4 always changes it. */
  rewriteOption: boolean;
  onMove: (name: string, rewriteName: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(() => mineName(item.skill ?? '', prefix));
  const [rewrite, setRewrite] = useState(true);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const folder = item.reason === null || item.reason === 'folder';
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t(rewriteOption ? 'links.move.title' : 'links.move.keepTitle', { skill: item.skill })}
      description={t(rewriteOption ? 'links.move.body' : 'links.move.keepBody', { skill: item.skill })}
      footer={
        <>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {t('links.cancel')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={busy || name.trim() === ''}
            onClick={() => {
              setBusy(true);
              setError(null);
              onMove(name.trim(), !rewriteOption || (folder && rewrite))
                .then(() => onOpenChange(false))
                .catch((e: unknown) => setError(e as ErrorView))
                .finally(() => setBusy(false));
            }}
          >
            {t(rewriteOption ? 'links.move.confirm' : 'links.move.keepConfirm')}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1 text-sm">
        <span>{t('links.move.name')}</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      {folder && (
        <div className="flex flex-col gap-2 text-sm">
          {rewriteOption && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={rewrite} onChange={(event) => setRewrite(event.target.checked)} />
              {t('links.move.rewrite')}
            </label>
          )}
          {(!rewriteOption || rewrite) && (
            <div
              className="rounded-md border border-border bg-muted p-3 font-mono text-xs"
              aria-label={t('links.move.change')}
            >
              <p className="text-danger">
                <span aria-hidden="true">− </span>
                {`name: ${item.skill ?? ''}`}
              </p>
              <p className="text-success">
                <span aria-hidden="true">+ </span>
                {`name: ${name.trim()}`}
              </p>
            </div>
          )}
        </div>
      )}
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}

/** A confirmation for an answer that moves something to the trash. */
function TrashDialog({
  open,
  onOpenChange,
  title,
  body,
  confirm,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={body}
      footer={
        <>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {t('links.cancel')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onConfirm()
                .then(() => onOpenChange(false))
                .catch((e: unknown) => setError(e as ErrorView))
                .finally(() => setBusy(false));
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}

/** The files of a copy that differ from the library's, as a list (names only). */
function DifferenceList({ differences }: { differences: readonly FileDifference[] }) {
  const { t } = useTranslation();
  return (
    <ul
      aria-label={t('links.diverged.differences')}
      className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm"
    >
      {differences.length === 0 && <li>{t('links.diverged.noDifferences')}</li>}
      {differences.map((d) => (
        <li key={d.path} className="flex gap-2">
          <span className="w-24 shrink-0 text-muted-foreground">{t(`links.diverged.change.${d.change}`)}</span>
          <span className="font-mono text-xs">{d.path}</span>
        </li>
      ))}
    </ul>
  );
}

type CopyChangedChoice = 'bring-in' | 'replace' | 'leave';

/** A copy-mode copy edited where it is (PLAN.md §3.4, Step 16): "bring this change into the library". */
function CopyChangedChoices({
  item,
  actions,
  run,
}: {
  item: AttentionItemView;
  actions: AttentionActions;
  run: (task: () => Promise<void>) => void;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<CopyChangedChoice>('bring-in');
  const [differences, setDifferences] = useState<FileDifference[] | null>(null);
  const tools = toolsText(item, item.folder ?? '');
  const options: CopyChangedChoice[] = ['bring-in', 'replace', 'leave'];
  return (
    <div className="flex flex-col gap-3">
      {item.reason === 'library-changed' && (
        <p className="flex items-start gap-2">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t('links.copyChanged.libraryChanged')}
        </p>
      )}
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => run(async () => setDifferences(await actions.differences(item)))}
        >
          <FileDiff aria-hidden="true" />
          {t('links.diverged.showDifferences')}
        </Button>
      </div>
      {differences && <DifferenceList differences={differences} />}
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="sr-only">{t('links.copyChanged.legend', { skill: item.skill })}</legend>
        {options.map((option) => (
          <label key={option} className="flex items-start gap-2">
            <input
              type="radio"
              name={`copy-changed-${item.id}`}
              className="mt-1"
              checked={choice === option}
              onChange={() => setChoice(option)}
            />
            <span className="flex flex-col">
              <span className="font-medium">{t(`links.copyChanged.${option}.label`, { tools })}</span>
              <span className="text-muted-foreground">{t(`links.copyChanged.${option}.body`, { tools })}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div>
        <Button type="button" onClick={() => run(() => actions.decide(item, { kind: choice }))}>
          {t('links.diverged.apply')}
        </Button>
      </div>
    </div>
  );
}

type DivergedChoice = 'keep' | 'replace' | 'bring-in' | 'leave';

function DivergedChoices({
  item,
  prefix,
  actions,
  run,
}: {
  item: AttentionItemView;
  prefix: string | null;
  actions: AttentionActions;
  run: (task: () => Promise<void>) => void;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<DivergedChoice | null>(null);
  const [differences, setDifferences] = useState<FileDifference[] | null>(null);
  const [keepOpen, setKeepOpen] = useState(false);
  const tools = toolsText(item, item.folder ?? '');
  const options: DivergedChoice[] = ['keep', 'replace', 'bring-in', 'leave'];
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => run(async () => setDifferences(await actions.differences(item)))}
        >
          <FileDiff aria-hidden="true" />
          {t('links.diverged.showDifferences')}
        </Button>
      </div>
      {differences && <DifferenceList differences={differences} />}
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="sr-only">{t('links.diverged.legend', { skill: item.skill })}</legend>
        {options.map((option) => (
          <label key={option} className="flex items-start gap-2">
            <input
              type="radio"
              name={`diverged-${item.id}`}
              className="mt-1"
              checked={choice === option}
              onChange={() => setChoice(option)}
            />
            <span className="flex flex-col">
              <span className="font-medium">{t(`links.diverged.${option}.label`, { tools })}</span>
              <span className="text-muted-foreground">{t(`links.diverged.${option}.body`, { tools })}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div>
        <Button
          type="button"
          disabled={choice === null}
          onClick={() => {
            if (choice === 'keep') setKeepOpen(true);
            else if (choice) run(() => actions.decide(item, { kind: choice }));
          }}
        >
          {t('links.diverged.apply')}
        </Button>
      </div>
      {keepOpen && (
        <MoveDialog
          item={item}
          prefix={prefix}
          open={keepOpen}
          onOpenChange={setKeepOpen}
          rewriteOption={false}
          onMove={(name) => actions.decide(item, { kind: 'move-aside', name, rewriteName: true })}
        />
      )}
    </div>
  );
}

export function WarningCard({
  item,
  home,
  prefix,
  actions,
  overview,
  instanceId,
  gitPrefix,
  instance,
}: {
  item: AttentionItemView;
  home: string | undefined;
  prefix: string | null;
  actions: AttentionActions;
  overview?: OverviewView | undefined;
  instanceId?: string;
  /** The library's git prefix, for a skill that doesn't start with it (Step 8). */
  gitPrefix?: string | null;
  /** The instance, for the instance-wide items' answers (Step 9). */
  instance?: InstanceView;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'move' | 'overwrite' | null>(null);
  // In a code repo, the tools are named with the repo: "Claude Code in backend-api".
  const tools =
    item.repo && item.kind !== 'repo-missing'
      ? t('placement.inRepo', { tools: toolsText(item, item.folder ?? ''), repo: item.repo })
      : toolsText(item, item.folder ?? '');
  const run = (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    task()
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(false));
  };
  const decide = (decision: LinkDecisionView) => run(() => actions.decide(item, decision));
  const titleKey =
    item.kind === 'skipped' && item.reason === 'link'
      ? 'skippedLink'
      : item.kind === 'skipped' && item.reason === 'committed'
        ? 'skippedCommitted'
        : item.kind === 'skipped' && item.reason === 'no-access'
          ? 'skippedNoAccess'
          : item.kind;
  const params = {
    skill: item.skill,
    tools,
    repo: item.repo ?? '',
    tag: item.tag ?? '',
    repos: item.repos.join(', '),
    // A projected copy's items (Step 8): the local name, and the git prefix.
    name: item.reason ?? '',
    prefix: gitPrefix ?? '',
    library: instance?.name ?? '',
    // A prefix change that waits (Step 14): the new prefix, and the old one.
    to: item.kind === 'prefix-waiting' ? (item.reason ?? '') : '',
    from: item.kind === 'prefix-waiting' ? (item.takenBy ?? '') : '',
  };
  const copyItem = item.kind === 'copy-conflict' || item.kind === 'name-too-long' || item.kind === 'wrong-prefix';
  return (
    <Card role="region" aria-label={t(`links.warning.${titleKey}.title`, params)}>
      <CardHeader>
        <CardTitle className="flex items-start gap-2 text-base">
          {item.kind === 'frozen' ? (
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          ) : (
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          )}
          <span>{t(`links.warning.${titleKey}.title`, params)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {item.dest && (
          <p className="flex flex-wrap items-baseline gap-1">
            <PathText path={item.dest} home={home} />
            <span>{t(`links.warning.${titleKey}.body`, params)}</span>
          </p>
        )}
        {item.kind === 'frozen' && <p>{t('links.warning.frozen.body')}</p>}
        {LIBRARY_ITEMS.includes(item.kind) && instance && (
          <LibraryAnswers item={item} instance={instance} home={home} actions={actions.library} />
        )}
        {item.kind === 'tag-gone' && <p>{t('links.warning.tag-gone.body', params)}</p>}
        {item.kind === 'prefix-waiting' && <p>{t('links.warning.prefix-waiting.body', params)}</p>}
        {item.kind === 'prefix-waiting' && instanceId && (
          <AdoptPrefixAnswer to={item.reason ?? ''} instanceId={instanceId} />
        )}
        {copyItem && <p>{t(`links.warning.${item.kind}.body`, params)}</p>}
        {copyItem && instanceId && <CopyAnswers item={item} instanceId={instanceId} actions={actions.copies} />}
        {item.kind === 'taken-over' && item.takenBy && (
          <p className="flex flex-wrap items-baseline gap-1 text-muted-foreground">
            {t('links.warning.taken-over.pointsTo')}
            <PathText path={item.takenBy} home={home} />
          </p>
        )}
        {item.kind === 'taken-over' && <p>{t('links.warning.taken-over.outdated', { tools })}</p>}
        {item.kind === 'skipped' && item.reason === 'no-access' && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => decide({ kind: 'reinstall' })}>
              {t('links.actions.tryAgain')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => decide({ kind: 'suppress' })}
            >
              {t('links.actions.dontInstall', { tools })}
            </Button>
          </div>
        )}
        {item.kind === 'skipped' && item.reason !== 'committed' && item.reason !== 'no-access' && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => setDialog('move')}>
              {t('links.actions.moveMyFolder')}
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setDialog('overwrite')}>
              {t('links.actions.overwrite')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => decide({ kind: 'suppress' })}
            >
              {t('links.actions.dontInstall', { tools })}
            </Button>
          </div>
        )}
        {item.kind === 'missing' && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => decide({ kind: 'reinstall' })}>
              {t('links.actions.reinstall')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => decide({ kind: 'suppress' })}
            >
              {t('links.actions.dontInstall', { tools })}
            </Button>
          </div>
        )}
        {item.kind === 'taken-over' && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => decide({ kind: 'take-back' })}>
              {t('links.actions.takeBack')}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => decide({ kind: 'leave' })}>
              {t('links.actions.leave')}
            </Button>
          </div>
        )}
        {item.kind === 'deleted' && (
          <div>
            <Button type="button" size="sm" disabled={busy} onClick={() => run(() => actions.restore(item))}>
              {t('links.actions.restore')}
            </Button>
          </div>
        )}
        {item.kind === 'diverged' && <DivergedChoices item={item} prefix={prefix} actions={actions} run={run} />}
        {item.kind === 'copy-changed' && <CopyChangedChoices item={item} actions={actions} run={run} />}
        <PlacementAnswers item={item} overview={overview} actions={actions} busy={busy} run={run} />
        {error && <ErrorMessage error={error} />}
      </CardContent>
      {dialog === 'move' && (
        <MoveDialog
          item={item}
          prefix={prefix}
          open
          onOpenChange={(open) => setDialog(open ? 'move' : null)}
          rewriteOption
          onMove={(name, rewriteName) => actions.decide(item, { kind: 'move-aside', name, rewriteName })}
        />
      )}
      {dialog === 'overwrite' && (
        <TrashDialog
          open
          onOpenChange={(open) => setDialog(open ? 'overwrite' : null)}
          title={t('links.overwrite.title', { skill: item.skill, tools })}
          body={t('links.overwrite.body')}
          confirm={t('links.actions.overwrite')}
          onConfirm={() => actions.decide(item, { kind: 'overwrite' })}
        />
      )}
    </Card>
  );
}

export function AttentionPageView({
  instance,
  items,
  home,
  actions,
  overview,
}: {
  instance: InstanceView;
  items: readonly AttentionItemView[] | undefined;
  home: string | undefined;
  actions: AttentionActions;
  overview?: OverviewView | undefined;
}) {
  const { t } = useTranslation();
  // The git prefix: the effective one while the library has no local prefix.
  const gitPrefix = (instance.localPrefix ?? null) === null ? instance.prefix : null;
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">{t('links.attention.title', { name: instance.name })}</h1>
        <LibraryNav instanceId={instance.id} attention={items?.length ?? instance.attention} />
      </header>
      {items && items.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
          {t('links.attention.empty')}
        </p>
      )}
      {items?.map((item) => (
        <WarningCard
          key={item.id}
          item={item}
          home={home}
          prefix={instance.prefix}
          actions={actions}
          overview={overview}
          instanceId={instance.id}
          gitPrefix={gitPrefix}
          instance={instance}
        />
      ))}
    </div>
  );
}

export function attentionActions(instanceId: string): AttentionActions {
  return {
    async decide(item, decision) {
      if (!item.dest) return;
      const plan = await queryInstance(instanceId, 'previewDecision', { dest: item.dest, decision });
      await callInstance(instanceId, 'resolveLink', { dest: item.dest, decision, planHash: plan.hash });
    },
    async restore(item) {
      if (item.skill) await callInstance(instanceId, 'restoreSkill', { skill: item.skill });
    },
    differences: async (item) => (item.dest ? queryInstance(instanceId, 'folderDifferences', { dest: item.dest }) : []),
    async place(edits) {
      const plan = await queryInstance(instanceId, 'previewPlacement', { edits: [...edits] });
      await callInstance(instanceId, 'applyPlacement', { edits: [...edits], planHash: plan.hash });
    },
    async locate(repoId) {
      const path = await pickFolder('repo');
      if (path !== null) await callInstance(instanceId, 'locateRepo', { repo: repoId, path });
    },
    placement: placementActions(instanceId),
    copies: copyActions(instanceId),
    library: libraryActions(instanceId),
  };
}

export function AttentionPage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId/attention' });
  const instances = useDeviceQuery('instances');
  const appInfo = useDeviceQuery('appInfo');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const items = useInstanceQuery(instance?.status === 'ready' ? instanceId : undefined, 'attention');
  const overview = useInstanceQuery(instance?.status === 'ready' ? instanceId : undefined, 'overview');
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  return (
    <AttentionPageView
      instance={instance}
      items={items.data}
      home={appInfo.data?.homePath}
      actions={attentionActions(instanceId)}
      overview={overview.data}
    />
  );
}
