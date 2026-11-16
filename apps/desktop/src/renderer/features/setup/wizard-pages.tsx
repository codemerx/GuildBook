// The wizard's pages after the download (PLAN.md §3.17, Step 15): for an Admin's new library the import, the
// instructions, the tags and the first push with the invite link; for everyone the tools, the code repos, the name
// check and the summary. Each answer is recorded in the instance's database; nothing outside the library changes
// before [Finish]. The views here only show what the worker says and report the user's actions.
import type { SetupSummaryView, SetupTakenNameView, SetupWizardView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { CheckCircle2, Copy, FolderOpen, FolderPlus, Info, Link2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { Input, Label } from '../../ui/input.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { formatBytes } from './steps.tsx';

export interface WizardActions {
  readonly go: (page: SetupWizardView['page']) => void;
  readonly openImport: () => void;
  readonly openInstructions: () => void;
  readonly openChanges: () => void;
  readonly setSkillTags: (skill: string, tags: string[]) => void;
  readonly setLibraryTags: (suggest: Record<string, string[]>, repoOnlyTags: string[]) => void;
  readonly publish: () => void;
  readonly copyInvite: (link: string) => void;
  readonly chooseTools: (enabled: string[]) => void;
  readonly addCustomTool: (name: string) => void;
  readonly addRepo: () => void;
  readonly addRoot: () => void;
  readonly tickTag: (repo: string, tag: string, on: boolean) => void;
  readonly answerName: (dest: string, choice: SetupTakenNameView['choice']) => void;
  readonly finish: (planHash: string) => void;
}

interface PageProps {
  readonly view: SetupWizardView;
  readonly home: string | undefined;
  readonly busy: boolean;
  readonly error: ErrorView | null;
  readonly actions: WizardActions;
}

/** The page after this one, in the wizard's order. */
function nextOf(view: SetupWizardView): SetupWizardView['page'] | null {
  const at = view.pages.indexOf(view.page);
  return view.pages[at + 1] ?? null;
}

function previousOf(view: SetupWizardView): SetupWizardView['page'] | null {
  const at = view.pages.indexOf(view.page);
  return at > 0 ? (view.pages[at - 1] ?? null) : null;
}

/** [Back] and [Continue] (or another label) at the bottom of a page. */
function PageButtons({
  view,
  busy,
  actions,
  label,
  disabled = false,
  skip = false,
}: {
  view: SetupWizardView;
  busy: boolean;
  actions: WizardActions;
  label?: string | undefined;
  disabled?: boolean;
  skip?: boolean;
}) {
  const { t } = useTranslation();
  const next = nextOf(view);
  const back = previousOf(view);
  return (
    <div className="flex flex-wrap gap-3">
      {back && (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => actions.go(back)}>
          {t('setup.wizard.back')}
        </Button>
      )}
      {next && (
        <Button type="button" disabled={busy || disabled} onClick={() => actions.go(next)}>
          {label ?? (skip ? t('setup.wizard.skip') : t('setup.wizard.continue'))}
        </Button>
      )}
    </div>
  );
}

export function ImportStep({ view, busy, error, actions }: PageProps) {
  const { t } = useTranslation();
  const count = view.library.skills.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.wizard.import.title')}</CardTitle>
        <CardDescription>{t('setup.wizard.import.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm">
          {count === 0 ? t('setup.wizard.import.none') : t('setup.wizard.import.count', { count })}
        </p>
        <div>
          <Button type="button" variant="secondary" disabled={busy} onClick={actions.openImport}>
            {t('setup.wizard.import.open')}
          </Button>
        </div>
        {error && <ErrorMessage error={error} />}
        <PageButtons view={view} busy={busy} actions={actions} skip={count === 0} />
      </CardContent>
    </Card>
  );
}

export function InstructionsStep({ view, busy, error, actions }: PageProps) {
  const { t } = useTranslation();
  const written = view.library.instructions;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.wizard.instructions.title')}</CardTitle>
        <CardDescription>{t('setup.wizard.instructions.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="flex items-center gap-2 text-sm">
          {written && <CheckCircle2 aria-hidden="true" className="size-4 text-success" />}
          {written
            ? t('setup.wizard.instructions.has', { size: formatBytes(written.bytes) })
            : t('setup.wizard.instructions.none')}
        </p>
        <div>
          <Button type="button" variant="secondary" disabled={busy} onClick={actions.openInstructions}>
            {t('setup.wizard.instructions.open')}
          </Button>
        </div>
        {error && <ErrorMessage error={error} />}
        <PageButtons view={view} busy={busy} actions={actions} skip={!written} />
      </CardContent>
    </Card>
  );
}

const splitTags = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);

function SkillTagsRow({
  skill,
  tags,
  busy,
  onSave,
}: {
  skill: string;
  tags: readonly string[];
  busy: boolean;
  onSave: (tags: string[]) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(tags.join(' '));
  const id = `tags-${skill}`;
  const changed = splitTags(text).join(' ') !== tags.join(' ');
  return (
    <li className="flex flex-wrap items-end gap-2">
      <div className="flex min-w-64 flex-1 flex-col gap-1">
        <Label htmlFor={id}>{t('setup.wizard.tags.skillTags', { skill })}</Label>
        <Input id={id} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
      </div>
      <Button type="button" variant="secondary" disabled={busy || !changed} onClick={() => onSave(splitTags(text))}>
        {t('setup.wizard.tags.save')}
      </Button>
    </li>
  );
}

export function TagsStep({ view, busy, error, actions }: PageProps) {
  const { t } = useTranslation();
  const [suggest, setSuggest] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(Object.entries(view.library.suggest).map(([tag, patterns]) => [tag, [...patterns]])),
  );
  const [tag, setTag] = useState('');
  const [patterns, setPatterns] = useState('');
  const [repoOnly, setRepoOnly] = useState(view.library.repoOnlyTags.join(' '));
  const libraryChanged =
    JSON.stringify(suggest) !== JSON.stringify(view.library.suggest) ||
    splitTags(repoOnly).join(' ') !== view.library.repoOnlyTags.join(' ');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.wizard.tags.title')}</CardTitle>
        <CardDescription>{t('setup.wizard.tags.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {view.library.skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('setup.wizard.tags.noSkills')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {view.library.skills.map((skill) => (
              <SkillTagsRow
                key={`${skill.skill}:${skill.tags.join(' ')}`}
                skill={skill.skill}
                tags={skill.tags}
                busy={busy}
                onSave={(tags) => actions.setSkillTags(skill.skill, tags)}
              />
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t('setup.wizard.tags.hint')}</p>
        <section className="flex flex-col gap-2" aria-labelledby="suggest-title">
          <h3 id="suggest-title" className="text-sm font-semibold">
            {t('setup.wizard.tags.suggestTitle')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('setup.wizard.tags.suggestDescription')}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {Object.entries(suggest).map(([name, list]) => (
              <li key={name} className="flex items-center gap-2">
                <span className="font-mono">
                  {name} → {list.join(', ')}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setSuggest(Object.fromEntries(Object.entries(suggest).filter(([k]) => k !== name)))}
                >
                  {t('setup.wizard.tags.removeSuggestion', { tag: name })}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="suggest-tag">{t('setup.wizard.tags.suggestTag')}</Label>
              <Input id="suggest-tag" value={tag} className="w-40" onChange={(e) => setTag(e.target.value)} />
            </div>
            <div className="flex min-w-56 flex-1 flex-col gap-1">
              <Label htmlFor="suggest-patterns">{t('setup.wizard.tags.suggestPatterns')}</Label>
              <Input
                id="suggest-patterns"
                value={patterns}
                spellCheck={false}
                placeholder={t('setup.wizard.tags.patternExample')}
                onChange={(e) => setPatterns(e.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={busy || tag.trim() === '' || splitTags(patterns).length === 0}
              onClick={() => {
                setSuggest({ ...suggest, [tag.trim()]: splitTags(patterns) });
                setTag('');
                setPatterns('');
              }}
            >
              {t('setup.wizard.tags.addSuggestion')}
            </Button>
          </div>
        </section>
        <div className="flex flex-col gap-1">
          <Label htmlFor="repo-only" className="font-semibold">
            {t('setup.wizard.tags.repoOnlyLabel')}
          </Label>
          <p id="repo-only-hint" className="text-sm text-muted-foreground">
            {t('setup.wizard.tags.repoOnlyDescription')}
          </p>
          <Input
            id="repo-only"
            value={repoOnly}
            spellCheck={false}
            aria-describedby="repo-only-hint"
            onChange={(e) => setRepoOnly(e.target.value)}
          />
        </div>
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !libraryChanged}
            onClick={() => actions.setLibraryTags(suggest, splitTags(repoOnly))}
          >
            {t('setup.wizard.tags.saveLibrary')}
          </Button>
        </div>
        {error && <ErrorMessage error={error} />}
        <PageButtons view={view} busy={busy} actions={actions} />
      </CardContent>
    </Card>
  );
}

export function PublishStep({
  view,
  busy,
  error,
  actions,
  host,
  outcome,
  copied,
}: PageProps & { host: string; outcome: 'checks' | 'rejected' | null; copied: boolean }) {
  const { t } = useTranslation();
  const { published, unpublished } = view.library;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.wizard.publish.title')}</CardTitle>
        <CardDescription>{t('setup.wizard.publish.description', { host })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!published && (
          <>
            <p className="text-sm">{t('setup.wizard.publish.changes', { count: unpublished })}</p>
            <div>
              <Button type="button" disabled={busy} onClick={actions.publish}>
                {t('setup.wizard.publish.push')}
              </Button>
            </div>
            {outcome && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-sm"
              >
                <Info aria-hidden="true" className="size-4" />
                <span>{t(outcome === 'checks' ? 'setup.wizard.publish.checks' : 'setup.wizard.publish.rejected')}</span>
                <Button type="button" size="sm" variant="secondary" onClick={actions.openChanges}>
                  {t('setup.wizard.publish.openChanges')}
                </Button>
              </div>
            )}
          </>
        )}
        {view.invite && (
          <section className="flex flex-col gap-2 rounded-md border border-border p-3" aria-labelledby="invite-title">
            <h3 id="invite-title" className="flex items-center gap-2 text-sm font-semibold">
              <Link2 aria-hidden="true" className="size-4" />
              {t('setup.wizard.publish.inviteTitle')}
            </h3>
            <p id="invite-description" className="text-sm text-muted-foreground">
              {t('setup.wizard.publish.inviteDescription')}
            </p>
            <Input
              id="invite-link"
              readOnly
              value={view.invite}
              aria-labelledby="invite-title"
              aria-describedby="invite-description"
              className="font-mono text-xs"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="secondary" onClick={() => view.invite && actions.copyInvite(view.invite)}>
                <Copy aria-hidden="true" />
                {t('setup.wizard.publish.copy')}
              </Button>
              {copied && (
                <span role="status" className="text-sm text-success">
                  {t('setup.wizard.publish.copied')}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{t('setup.wizard.publish.keys')}</p>
          </section>
        )}
        {error && <ErrorMessage error={error} />}
        <PageButtons view={view} busy={busy} actions={actions} disabled={!published} />
      </CardContent>
    </Card>
  );
}

export function ToolsStep({ view, home, busy, error, actions }: PageProps) {
  const { t } = useTranslation();
  const [custom, setCustom] = useState('');
  // The ticks show at once; the worker's answer follows (it records them).
  const [ticked, setTicked] = useState<{ base: string; ids: string[] } | null>(null);
  const found = view.tools.filter((tool) => tool.found);
  const recorded = view.tools.filter((tool) => tool.chosen).map((tool) => tool.id);
  const base = recorded.join(',');
  const chosen = ticked?.base === base ? ticked.ids : recorded;
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...chosen, id] : chosen.filter((other) => other !== id);
    setTicked({ base, ids: next });
    actions.chooseTools(next);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.wizard.tools.title')}</CardTitle>
        <CardDescription>
          {found.length > 0
            ? t('setup.wizard.tools.found', { tools: found.map((tool) => tool.name).join(', ') })
            : t('setup.wizard.tools.foundNone')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {(() => {
          const row = (tool: SetupWizardView['tools'][number]) => (
            <li key={tool.id} className="flex flex-col gap-0.5">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.includes(tool.id)}
                  onChange={(e) => toggle(tool.id, e.target.checked)}
                />
                <span className="font-medium">{tool.name}</span>
                {!tool.found && <span className="text-muted-foreground">({t('setup.wizard.tools.notFound')})</span>}
                {tool.custom && <span className="text-muted-foreground">({t('setup.wizard.tools.customTool')})</span>}
              </label>
              {chosen.includes(tool.id) && tool.folder && (
                <span className="ml-6 text-xs text-muted-foreground">
                  {t('setup.wizard.tools.folder', { folder: '' })}
                  <PathText path={tool.folder} home={home} />
                </span>
              )}
            </li>
          );
          // The tools found, and the ones ticked; the rest of the catalog is folded away.
          const shown = view.tools.filter((tool) => tool.found || tool.custom || chosen.includes(tool.id));
          const others = view.tools.filter((tool) => !shown.includes(tool));
          return (
            <>
              <ul className="flex flex-col gap-2">{shown.map(row)}</ul>
              {others.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer">
                    {t('setup.wizard.tools.others', { count: others.length })}
                  </summary>
                  <ul className="mt-2 flex flex-col gap-2">{others.map(row)}</ul>
                </details>
              )}
            </>
          );
        })()}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="custom-tool">{t('setup.wizard.tools.customName')}</Label>
            <Input id="custom-tool" value={custom} className="w-56" onChange={(e) => setCustom(e.target.value)} />
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || custom.trim() === ''}
            onClick={() => {
              actions.addCustomTool(custom.trim());
              setCustom('');
            }}
          >
            {t('setup.wizard.tools.custom')}
          </Button>
        </div>
        {error && <ErrorMessage error={error} />}
        <PageButtons view={view} busy={busy} actions={actions} />
      </CardContent>
    </Card>
  );
}

export function ReposStep({
  view,
  home,
  busy,
  error,
  actions,
  platform,
  tags,
}: PageProps & { platform: string | undefined; tags: readonly string[] }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.wizard.repos.title')}</CardTitle>
        <CardDescription>{t('setup.wizard.repos.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <Button type="button" variant="secondary" disabled={busy} onClick={actions.addRepo}>
            <FolderOpen aria-hidden="true" />
            {t('setup.wizard.repos.addRepo')}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={actions.addRoot}>
            <FolderPlus aria-hidden="true" />
            {t('setup.wizard.repos.addRoot')}
          </Button>
        </div>
        {platform === 'darwin' && <p className="text-xs text-muted-foreground">{t('setup.wizard.repos.macos')}</p>}
        {view.repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('setup.wizard.repos.none')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {view.repos.map((repo) => (
              <li key={repo.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
                <div className="flex flex-col">
                  <span className="font-medium">{repo.name}</span>
                  <span className="text-xs text-muted-foreground">
                    <PathText path={repo.path} home={home} />
                    {repo.remote && ` · ${repo.remote}`}
                  </span>
                </div>
                {repo.suggestions.map((tag) => (
                  <p key={tag} className="flex flex-wrap items-center gap-2 text-sm">
                    <Info aria-hidden="true" className="size-4" />
                    {t('setup.wizard.repos.suggestion', { repo: repo.name, tag })}
                    <Button type="button" size="sm" disabled={busy} onClick={() => actions.tickTag(repo.id, tag, true)}>
                      {t('setup.wizard.repos.tick', { tag })}
                    </Button>
                  </p>
                ))}
                <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <legend className="sr-only">{t('setup.wizard.repos.tagsOf', { repo: repo.name })}</legend>
                  {tags.length === 0 && <span className="text-muted-foreground">{t('setup.wizard.repos.noTags')}</span>}
                  {tags.map((tag) => (
                    <label key={tag} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={repo.ticked.includes(tag)}
                        disabled={busy}
                        onChange={(e) => actions.tickTag(repo.id, tag, e.target.checked)}
                      />
                      <span className="font-mono">{tag}</span>
                    </label>
                  ))}
                </fieldset>
              </li>
            ))}
          </ul>
        )}
        {error && <ErrorMessage error={error} />}
        <PageButtons
          view={view}
          busy={busy}
          actions={actions}
          label={view.repos.length === 0 ? t('setup.wizard.repos.skip') : undefined}
        />
      </CardContent>
    </Card>
  );
}

function TakenNameRow({
  item,
  home,
  busy,
  onAnswer,
}: {
  item: SetupTakenNameView;
  home: string | undefined;
  busy: boolean;
  onAnswer: (choice: SetupTakenNameView['choice']) => void;
}) {
  const { t } = useTranslation();
  const [moving, setMoving] = useState(false);
  const [name, setName] = useState(item.suggestion);
  const tools = item.tools.join(', ');
  if (item.reason === 'committed') {
    return (
      <li className="rounded-md border border-border p-3 text-sm">
        {t('setup.wizard.names.committed', { repo: item.repo ?? '', skill: item.skill })}
      </li>
    );
  }
  const choice = item.choice;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      <span className="font-medium">{item.skill}</span>
      <span className="text-xs text-muted-foreground">
        <PathText path={item.dest} home={home} />
        {tools && ` · ${tools}`}
      </span>
      {choice ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
          {choice.kind === 'move-aside'
            ? t('setup.wizard.names.movedTo', { name: choice.name })
            : choice.kind === 'overwrite'
              ? t('setup.wizard.names.overwritten')
              : t('setup.wizard.names.suppressed', { skill: item.skill })}
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onAnswer(null)}>
            {t('setup.wizard.names.change')}
          </Button>
        </p>
      ) : moving ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() !== '') onAnswer({ kind: 'move-aside', name: name.trim() });
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={`move-${item.dest}`}>{t('setup.wizard.names.newName')}</Label>
            <Input
              id={`move-${item.dest}`}
              value={name}
              spellCheck={false}
              className="w-64"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy || name.trim() === ''}>
            {t('setup.wizard.names.useName')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMoving(false)}>
            {t('setup.cancel')}
          </Button>
        </form>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t('setup.wizard.names.open', { skill: item.skill })}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setMoving(true)}>
              {t('setup.wizard.names.move')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onAnswer({ kind: 'overwrite' })}
            >
              {t('setup.wizard.names.overwrite')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onAnswer({ kind: 'suppress' })}
            >
              {t('setup.wizard.names.suppress')}
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

export function NamesStep({ view, home, busy, error, actions }: PageProps) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.wizard.names.title')}</CardTitle>
        <CardDescription>
          {view.taken.length === 0 ? t('setup.wizard.names.none') : t('setup.wizard.names.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {view.taken.length > 0 && (
          <ul className="flex flex-col gap-3">
            {view.taken.map((item) => (
              <TakenNameRow
                key={`${item.dest}:${item.choice?.kind ?? ''}`}
                item={item}
                home={home}
                busy={busy}
                onAnswer={(choice) => actions.answerName(item.dest, choice)}
              />
            ))}
          </ul>
        )}
        {error && <ErrorMessage error={error} />}
        <PageButtons view={view} busy={busy} actions={actions} />
      </CardContent>
    </Card>
  );
}

function instructionsLine(
  t: ReturnType<typeof useTranslation>['t'],
  summary: SetupSummaryView,
  name: string,
  home: string | undefined,
): string {
  const { instructions } = summary;
  if (!instructions.exists) return t('setup.wizard.summary.noLibraryInstructions');
  if (!instructions.linked && instructions.linkedBy) {
    return t('setup.wizard.summary.notLinked', { name, other: instructions.linkedBy });
  }
  const tools = instructions.tools.filter((tool) => tool.method !== 'none');
  if (tools.length === 0) return t('setup.wizard.summary.noInstructions');
  const shown = (path: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path);
  const list = tools.map((tool) =>
    t(`setup.wizard.summary.method.${tool.method}`, {
      tool: tool.name,
      file: shown(tool.artifacts[0]?.key ?? ''),
    }),
  );
  return t('setup.wizard.summary.instructions', { list: list.join(', ') });
}

export function SummaryStep({
  view,
  home,
  busy,
  error,
  actions,
  summary,
}: PageProps & { summary: SetupSummaryView | undefined }) {
  const { t } = useTranslation();
  const back = previousOf(view);
  const shown = (path: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.wizard.summary.title', { name: view.libraryName })}</CardTitle>
        <CardDescription>{t('setup.wizard.summary.nothingYet')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {summary && (
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm" aria-label={t('setup.steps.summary')}>
            <li>
              <span className="font-semibold">{t('setup.wizard.summary.skills', { count: summary.skills.total })}</span>{' '}
              {[
                t('setup.wizard.summary.everywhere', { count: summary.skills.everywhere }),
                ...summary.skills.inRepos.map(
                  (group) =>
                    `${t('setup.wizard.summary.inRepos', { count: group.skills.length, repos: group.repos.join(', ') })}${
                      group.tags.length > 0
                        ? ` ${t('setup.wizard.summary.viaTags', { tags: group.tags.join(', ') })}`
                        : ''
                    }`,
                ),
                ...(summary.skills.nowhere.length > 0
                  ? [t('setup.wizard.summary.nowhere', { count: summary.skills.nowhere.length })]
                  : []),
              ].join(', ')}
            </li>
            <li>
              {summary.tools.length > 0
                ? t('setup.wizard.summary.tools', { tools: summary.tools.join(', ') })
                : t('setup.wizard.summary.noTools')}
            </li>
            <li>{instructionsLine(t, summary, view.libraryName, home)}</li>
            {summary.notInstalled.map((item) => (
              <li key={`${item.skill}:${item.why}`}>
                {t(`setup.wizard.summary.${item.why}`, { skill: item.skill, tools: item.tools.join(', ') })}
              </li>
            ))}
            {summary.moved.map((move) => (
              <li key={move.from}>{t('setup.wizard.summary.moved', { from: shown(move.from), to: shown(move.to) })}</li>
            ))}
            {summary.overwritten.map((path) => (
              <li key={path}>{t('setup.wizard.summary.overwritten', { path: shown(path) })}</li>
            ))}
            <li className="font-semibold">{t('setup.wizard.summary.untouched')}</li>
          </ul>
        )}
        {error && <ErrorMessage error={error} />}
        <div className="flex flex-wrap gap-3">
          {back && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => actions.go(back)}>
              {t('setup.wizard.back')}
            </Button>
          )}
          <Button type="button" disabled={busy || !summary} onClick={() => summary && actions.finish(summary.hash)}>
            {t('setup.wizard.summary.finish')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
