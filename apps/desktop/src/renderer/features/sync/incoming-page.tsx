// The incoming preview (PLAN.md §3.10 "Fetch", §3.6, §3.15): who changed what, with `scripts/` and `allowed-tools`
// changes flagged; what the pull does to each skill and where its links go; the questions it raises (a tag that no
// longer exists, a skill that becomes available everywhere); conflicts git reports; and local changes that block it,
// with [Commit them first] and [Stash, pull and re-apply]. [Pull] brings in exactly what the preview shows.
import type { IncomingPreviewView, InstanceView, PlacementEditView, PullResultView } from '@app/ipc';
import { type ErrorView, PrefixSchema } from '@app/schemas';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { AlertTriangle, ArrowDownToLine, ArrowRightLeft, FileCode2, Info, ShieldAlert, Swords } from 'lucide-react';
import { useState } from 'react';
import { type TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { callInstance, useDeviceQuery, useInstanceQueryWith } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { EventTime } from '../links/activity-page.tsx';
import { LocalPrefixField } from '../projection/local-prefix-field.tsx';
import { SyncFrame } from './sync-frame.tsx';

type Where = { global: boolean; repos: string[] };

function whereText(where: Where, t: TFunction): string {
  if (where.global) return t('sync.incoming.everywhere');
  if (where.repos.length > 0) return t('sync.incoming.inRepos', { repos: where.repos.join(', ') });
  return t('sync.incoming.nowhere');
}

/** The answers to the preview's questions, as placement edits written with the pull. */
export interface Answers {
  /** Gone tag → the tag to use instead, or null to remove the rule. Left out: not answered (the rule stays). */
  readonly tags: Readonly<Record<string, string | null>>;
  /** Skill → `everywhere` (the default), `off`, or a repo id to keep it in. */
  readonly skills: Readonly<Record<string, string>>;
}

export function answersToEdits(preview: IncomingPreviewView | undefined, answers: Answers): PlacementEditView[] {
  const edits: PlacementEditView[] = [];
  for (const gone of preview?.questions.tagsGone ?? []) {
    const answer = answers.tags[gone.tag];
    if (answer === undefined) continue;
    for (const repo of gone.repos) {
      edits.push(
        answer === null
          ? { op: 'rule', repo: repo.id, tag: gone.tag, on: false }
          : { op: 'retag', repo: repo.id, from: gone.tag, to: answer },
      );
    }
  }
  for (const question of preview?.questions.becomesGlobal ?? []) {
    const answer = answers.skills[question.skill];
    if (answer === undefined || answer === 'everywhere') continue;
    edits.push(
      answer === 'off'
        ? { op: 'mode', skill: question.skill, mode: 'off' }
        : { op: 'add', repo: answer, skill: question.skill, on: true },
    );
  }
  return edits;
}

/** The pull brings another git prefix (Step 14, PLAN.md §3.2 step 3): what it means here, and its question. */
function PrefixSection({
  prefix,
  renamed,
  localPrefix,
  onLocalPrefix,
  busy,
}: {
  prefix: NonNullable<IncomingPreviewView['prefix']>;
  renamed: number;
  localPrefix: string;
  onLocalPrefix: (value: string) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const asks = prefix.clash !== null && prefix.localPrefix === null;
  return (
    <Card role="region" aria-label={t('sync.incoming.prefix.title', { from: prefix.from, to: prefix.gitPrefix })}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowRightLeft aria-hidden="true" className="size-5" />
          {t('sync.incoming.prefix.title', { from: prefix.from, to: prefix.gitPrefix })}
        </CardTitle>
        <CardDescription>{t('sync.incoming.prefix.body', { count: renamed })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {asks && (
          <>
            <p role="note" className="flex items-start gap-2">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
              {prefix.clash?.kind === 'instance'
                ? t('prefix.clash.instance', { prefix: prefix.gitPrefix, name: prefix.clash.name })
                : t('prefix.clash.folders', { prefix: prefix.gitPrefix })}
            </p>
            <LocalPrefixField
              id="pull-local-prefix"
              value={localPrefix}
              check={prefix.answer}
              busy={busy}
              onChange={onLocalPrefix}
            />
          </>
        )}
        {prefix.localPrefix !== null && (
          <p className="flex items-start gap-2 text-muted-foreground">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {prefix.dropOffered
              ? t('sync.incoming.prefix.dropOffered', { to: prefix.gitPrefix, local: prefix.localPrefix })
              : t('sync.incoming.prefix.keepLocal', { local: prefix.localPrefix })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Whether the pull waits for a local prefix: the new prefix clashes here, and no valid one is typed. */
export function prefixUnanswered(preview: IncomingPreviewView, localPrefix: string): boolean {
  const prefix = preview.prefix;
  if (!prefix || prefix.clash === null || prefix.localPrefix !== null) return false;
  return prefix.answer?.prefix !== localPrefix || prefix.answer.problem !== null;
}

export function IncomingView({
  instance,
  preview,
  answers,
  onAnswers,
  onPull,
  busy,
  localPrefix = '',
  onLocalPrefix = () => {},
}: {
  instance: InstanceView;
  preview: IncomingPreviewView;
  answers: Answers;
  onAnswers: (answers: Answers) => void;
  onPull: (stash: boolean) => void;
  busy: boolean;
  /** The answer to the local-prefix question (Step 14), as typed. */
  localPrefix?: string;
  onLocalPrefix?: (value: string) => void;
}) {
  const { t } = useTranslation();
  const added = new Set(preview.skills.added);
  const removed = new Set(preview.skills.removed);
  const renamedTo = new Map(preview.skills.renamed.map((r) => [r.to, r.from]));
  const tooNew = preview.compatibility !== 'ok';
  // Pull waits for an app update, or for the local prefix a new git prefix needs here (Step 14).
  const blocked = tooNew || prefixUnanswered(preview, localPrefix);
  return (
    <div className="flex flex-col gap-6">
      {tooNew && (
        <p role="alert" className="text-sm font-medium">
          {t('sync.bar.blocked.update')}
        </p>
      )}
      {preview.prefix && (
        <PrefixSection
          prefix={preview.prefix}
          renamed={preview.skills.renamed.length}
          localPrefix={localPrefix}
          onLocalPrefix={onLocalPrefix}
          busy={busy}
        />
      )}
      {/* The questions first: the pull waits for their answers (PLAN.md §3.6 Days 8 and 12). */}
      {(preview.questions.tagsGone.length > 0 || preview.questions.becomesGlobal.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>{t('sync.incoming.questions')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {preview.questions.tagsGone.map((gone) => (
              <fieldset key={gone.tag} className="flex flex-col gap-2 text-sm">
                <legend className="mb-1 font-medium">
                  {t('sync.incoming.tagGone', { tag: gone.tag, repos: gone.repos.map((r) => r.name).join(', ') })}
                </legend>
                {gone.suggestions.map((tag) => (
                  <label key={tag} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`tag-${gone.tag}`}
                      className="accent-primary"
                      checked={answers.tags[gone.tag] === tag}
                      onChange={() => onAnswers({ ...answers, tags: { ...answers.tags, [gone.tag]: tag } })}
                    />
                    {t('sync.incoming.useTag', { tag })}
                  </label>
                ))}
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`tag-${gone.tag}`}
                    className="accent-primary"
                    checked={answers.tags[gone.tag] === null}
                    onChange={() => onAnswers({ ...answers, tags: { ...answers.tags, [gone.tag]: null } })}
                  />
                  {t('sync.incoming.removeRule')}
                </label>
              </fieldset>
            ))}
            {preview.questions.becomesGlobal.map((question) => (
              <label key={question.skill} className="flex flex-col gap-1 text-sm">
                <span className="font-medium">
                  {t('sync.incoming.becomesGlobal', {
                    skill: question.skill,
                    repos: question.repos.map((r) => r.name).join(', '),
                  })}
                </span>
                <select
                  className="h-9 w-fit rounded-md border border-input bg-background px-2"
                  aria-label={t('sync.incoming.change', { skill: question.skill })}
                  value={answers.skills[question.skill] ?? 'everywhere'}
                  onChange={(e) =>
                    onAnswers({ ...answers, skills: { ...answers.skills, [question.skill]: e.target.value } })
                  }
                >
                  <option value="everywhere">{t('sync.incoming.keepEverywhere')}</option>
                  {question.repos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {t('sync.incoming.onlyIn', { repo: repo.name })}
                    </option>
                  ))}
                  <option value="off">{t('sync.incoming.turnOff')}</option>
                </select>
              </label>
            ))}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('sync.incoming.commits', { count: preview.commits.length, library: instance.name })}</CardTitle>
          <CardDescription>{t('sync.incoming.commitsBody')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ol aria-label={t('sync.incoming.commitsLabel')} className="flex flex-col divide-y divide-border">
            {preview.commits.map((commit) => (
              <li key={commit.id} className="flex flex-col gap-1 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 font-medium">{commit.subject}</span>
                  <span className="text-muted-foreground">{commit.author}</span>
                  <EventTime ms={commit.authorDate} />
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {commit.skills.map((skill) => (
                    <span key={skill} className="rounded bg-muted px-1.5 py-0.5">
                      {skill}
                    </span>
                  ))}
                  {commit.scripts && (
                    <span className="inline-flex items-center gap-1 rounded border border-warning px-1.5 py-0.5">
                      <FileCode2 aria-hidden="true" className="size-3" />
                      {t('sync.flags.scripts')}
                    </span>
                  )}
                  {commit.allowedTools && (
                    <span className="inline-flex items-center gap-1 rounded border border-warning px-1.5 py-0.5">
                      <ShieldAlert aria-hidden="true" className="size-3" />
                      {t('sync.flags.allowedTools')}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('sync.incoming.skills')}</CardTitle>
          <CardDescription>{t('sync.incoming.skillsBody')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul aria-label={t('sync.incoming.skills')} className="flex flex-col gap-1 text-sm">
            {preview.moves.map((move) => (
              <li key={move.skill}>
                {added.has(move.skill)
                  ? t('sync.incoming.newSkill', { skill: move.skill, where: whereText(move.to, t) })
                  : renamedTo.has(move.skill)
                    ? t('sync.incoming.renamedMoves', {
                        from: renamedTo.get(move.skill) ?? '',
                        skill: move.skill,
                        where: whereText(move.to, t),
                      })
                    : t('sync.incoming.moves', {
                        skill: move.skill,
                        from: whereText(move.from, t),
                        where: whereText(move.to, t),
                      })}
              </li>
            ))}
            {preview.skills.renamed
              .filter((r) => !preview.moves.some((m) => m.skill === r.to))
              .map((r) => (
                <li key={r.to}>{t('sync.incoming.renamed', { from: r.from, to: r.to })}</li>
              ))}
            {[...removed].map((skill) => (
              <li key={skill}>{t('sync.incoming.removed', { skill })}</li>
            ))}
            {preview.skills.modified
              .filter((skill) => !preview.moves.some((m) => m.skill === skill))
              .map((skill) => (
                <li key={skill}>{t('sync.incoming.modified', { skill })}</li>
              ))}
          </ul>
          {preview.plan && (
            <p className="mt-3 text-sm text-muted-foreground">
              {t('sync.incoming.linkChanges', { count: preview.plan.changes.length })}
            </p>
          )}
        </CardContent>
      </Card>
      {preview.conflicts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Swords aria-hidden="true" className="size-5 text-warning" />
              {t('sync.incoming.conflicts')}
            </CardTitle>
            <CardDescription>{t('sync.incoming.conflictsBody')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {preview.conflicts.map((c) => (
                <li key={c.path} className="font-mono text-xs">
                  {c.path}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {preview.localChanges.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('sync.incoming.local')}</CardTitle>
            <CardDescription>
              {t(preview.mode === 'rebase' ? 'sync.incoming.localRebase' : 'sync.incoming.localBody')}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ul className="flex flex-col gap-1">
              {preview.localChanges.map((path) => (
                <li key={path} className="font-mono text-xs">
                  {path}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Link
                to="/library/$instanceId/changes"
                params={{ instanceId: instance.id }}
                className="inline-flex h-9 items-center rounded-md border border-border bg-secondary px-4 text-sm font-medium"
              >
                {t('sync.incoming.commitFirst')}
              </Link>
              <Button type="button" disabled={busy || blocked} onClick={() => onPull(true)}>
                {t('sync.incoming.stashPull')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div>
          <Button type="button" disabled={busy || blocked} onClick={() => onPull(false)}>
            <ArrowDownToLine aria-hidden="true" />
            {t('sync.incoming.pull', { count: preview.commits.length })}
          </Button>
        </div>
      )}
    </div>
  );
}

export function IncomingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { instanceId } = useParams({ from: '/library/$instanceId/changes/incoming' });
  const instances = useDeviceQuery('instances');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const [answers, setAnswers] = useState<Answers>({ tags: {}, skills: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [result, setResult] = useState<PullResultView | null>(null);
  // The local prefix for a new git prefix that clashes here (Step 14): the worker's suggestion until the user types,
  // and each valid one is checked with the preview.
  const [edited, setEdited] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const localPrefix = edited ?? suggestion ?? '';
  const typed = PrefixSchema.safeParse(localPrefix).success ? localPrefix : null;
  const plain = useInstanceQueryWith(instance?.status === 'ready' ? instanceId : undefined, 'incoming', {
    edits: [],
    localPrefix: typed,
  });
  const edits = answersToEdits(plain.data, answers);
  const answered = useInstanceQueryWith(instanceId, 'incoming', { edits, localPrefix: typed }, edits.length > 0);
  const offered = plain.data?.prefix?.clash ? plain.data.prefix.suggestion : null;
  if (suggestion === null && offered) setSuggestion(offered);
  const preview = edits.length > 0 ? (answered.data ?? plain.data) : plain.data;
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  const pull = (stash: boolean) => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    callInstance(instanceId, 'pull', { planHash: preview.hash, edits, stash, localPrefix: typed })
      .then((outcome) => {
        if (outcome.kind === 'conflicts' || outcome.kind === 'stashConflicts') {
          void navigate({ to: '/library/$instanceId/changes/conflicts', params: { instanceId } });
        } else setResult(outcome);
      })
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(false));
  };
  return (
    <SyncFrame instance={instance} title={t('sync.incoming.title', { name: instance.name })}>
      {error && <ErrorMessage error={error} />}
      {result?.kind === 'pulled' && (
        <p role="status" className="text-sm font-medium">
          {t('sync.incoming.pulled', { count: result.commits })}
        </p>
      )}
      {result?.kind === 'localChanges' && <p role="status">{t('sync.incoming.local')}</p>}
      {(plain.error ?? answered.error) && (
        <ErrorMessage error={(plain.error ?? answered.error) as unknown as ErrorView} />
      )}
      {preview?.state === 'none' && result === null && (
        <p className="text-sm text-muted-foreground">{t('sync.incoming.nothing')}</p>
      )}
      {preview?.state === 'ready' && (
        <IncomingView
          instance={instance}
          preview={preview}
          answers={answers}
          onAnswers={setAnswers}
          onPull={pull}
          busy={busy || (edits.length > 0 && answered.isFetching) || (preview.prefix !== null && plain.isFetching)}
          localPrefix={localPrefix}
          onLocalPrefix={setEdited}
        />
      )}
    </SyncFrame>
  );
}
