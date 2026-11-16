// The new-skill wizard (PLAN.md §3.14, A10.6): a template, the name with the fixed prefix part, the description and the
// tags. The skill is created in the library and linked by the next check. Under a local prefix the field shows the
// local prefix, and the folder in git gets the git prefix (PLAN.md §3.3).
import { DESCRIPTION_MAX, type ErrorView, tagProblems } from '@app/schemas';
import type { SkillTemplateView } from '@app/ipc';
import { useNavigate, useParams } from '@tanstack/react-router';
import { BookOpen, CheckSquare, FileText, ListOrdered } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { FieldError, Input, Label } from '../../ui/input.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { EditorFrame } from './editor-frame.tsx';
import { gitName, nameProblems, normalizeTag } from './skill-text.ts';
import { useEditorContext } from './skill-editor-page.tsx';

const TEMPLATES: ReadonlyArray<{ id: SkillTemplateView; icon: typeof FileText }> = [
  { id: 'blank', icon: FileText },
  { id: 'how-to', icon: ListOrdered },
  { id: 'checklist', icon: CheckSquare },
  { id: 'reference', icon: BookOpen },
];

export function NewSkillForm({
  gitPrefix,
  effectivePrefix,
  onCreate,
}: {
  gitPrefix: string;
  effectivePrefix: string;
  onCreate: (input: {
    name: string;
    description: string;
    tags: string[];
    template: SkillTemplateView;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [template, setTemplate] = useState<SkillTemplateView>('how-to');
  const [rest, setRest] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const problems = nameProblems(rest, gitPrefix, effectivePrefix);
  const tagList = tags
    .split(/[\s,]+/)
    .map(normalizeTag)
    .filter((tag) => tag !== '');
  const badTag = tagList.find((tag) => tagProblems(tag).length > 0);
  const length = [...description.trim()].length;
  const valid = problems.length === 0 && length > 0 && length <= DESCRIPTION_MAX && !badTag;
  return (
    <form
      aria-label={t('editor.wizard.title')}
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (!valid) return;
        setBusy(true);
        setError(null);
        onCreate({ name: gitName(rest, gitPrefix), description: description.trim(), tags: tagList, template })
          .catch((e: unknown) => setError(e as ErrorView))
          .finally(() => setBusy(false));
      }}
    >
      {error && <ErrorMessage error={error} />}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{t('editor.wizard.template')}</legend>
        <RadioGroup.Root
          value={template}
          onValueChange={(value) => setTemplate(value as SkillTemplateView)}
          aria-label={t('editor.wizard.template')}
          className="grid grid-cols-2 gap-3"
        >
          {TEMPLATES.map(({ id: value, icon: Icon }) => (
            <RadioGroup.Item
              key={value}
              value={value}
              className="flex items-start gap-3 rounded-md border border-input p-3 text-left data-[state=checked]:border-ring data-[state=checked]:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{t(`editor.templates.${value}.title`)}</span>
                <span className="text-xs text-muted-foreground">{t(`editor.templates.${value}.body`)}</span>
              </span>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-name`}>{t('editor.header.name')}</Label>
        <div className="flex items-stretch">
          <span
            aria-hidden="true"
            className="flex items-center rounded-l-md border border-r-0 border-input bg-muted px-2 font-mono text-sm text-muted-foreground"
          >
            {`${effectivePrefix}-`}
          </span>
          <Input
            id={`${id}-name`}
            value={rest}
            className="rounded-l-none font-mono"
            aria-invalid={(touched || rest !== '') && problems.length > 0}
            aria-describedby={`${id}-name-hint ${id}-name-error`}
            onChange={(event) => setRest(event.target.value)}
          />
        </div>
        <p id={`${id}-name-hint`} className="text-xs text-muted-foreground">
          {t('editor.wizard.nameHint', { prefix: `${effectivePrefix}-` })}
        </p>
        <FieldError
          id={`${id}-name-error`}
          message={(touched || rest !== '') && problems[0] ? t(problems[0], { prefix: effectivePrefix }) : undefined}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor={`${id}-description`}>{t('editor.header.description')}</Label>
          <span className="text-xs text-muted-foreground">
            {t('editor.header.count', { count: length, max: DESCRIPTION_MAX })}
          </span>
        </div>
        <textarea
          id={`${id}-description`}
          value={description}
          rows={3}
          aria-describedby={`${id}-description-hint ${id}-description-error`}
          aria-invalid={touched && (length === 0 || length > DESCRIPTION_MAX)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => setDescription(event.target.value)}
        />
        <p id={`${id}-description-hint`} className="text-xs text-muted-foreground">
          {t('editor.header.descriptionHint')}
        </p>
        <FieldError
          id={`${id}-description-error`}
          message={touched && length === 0 ? t('issues.skill.descriptionMissing') : undefined}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-tags`}>{t('editor.wizard.tags')}</Label>
        <Input
          id={`${id}-tags`}
          value={tags}
          aria-invalid={badTag !== undefined}
          aria-describedby={`${id}-tags-hint ${id}-tags-error`}
          onChange={(event) => setTags(event.target.value)}
        />
        <p id={`${id}-tags-hint`} className="text-xs text-muted-foreground">
          {t('editor.wizard.tagsHint')}
        </p>
        <FieldError id={`${id}-tags-error`} message={badTag ? t('issues.tag.invalid', { tag: badTag }) : undefined} />
      </div>
      <div>
        <Button type="submit" disabled={busy}>
          {t('editor.wizard.create')}
        </Button>
      </div>
    </form>
  );
}

export function NewSkillPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { instanceId } = useParams({ from: '/library/$instanceId/edit/new' });
  const context = useEditorContext(instanceId);
  if (!context.instance) return context.loading ? null : <p>{t('library.notFound')}</p>;
  const gitPrefix = context.snapshot?.config.prefix ?? null;
  return (
    <EditorFrame instance={context.instance} snapshot={context.snapshot} localPrefix={context.localPrefix}>
      <Card>
        <CardHeader>
          <CardTitle>{t('editor.wizard.title')}</CardTitle>
          <CardDescription>{t('editor.wizard.body')}</CardDescription>
        </CardHeader>
        <CardContent>
          {gitPrefix === null ? (
            <p className="text-sm text-muted-foreground">{t('editor.loading')}</p>
          ) : (
            <NewSkillForm
              gitPrefix={gitPrefix}
              effectivePrefix={context.localPrefix ?? gitPrefix}
              onCreate={async (input) => {
                const { folder } = await callInstance(instanceId, 'createSkill', input);
                await navigate({ to: '/library/$instanceId/edit/skill/$skill', params: { instanceId, skill: folder } });
              }}
            />
          )}
        </CardContent>
      </Card>
    </EditorFrame>
  );
}

export function EditorHomePage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId/edit' });
  const context = useEditorContext(instanceId);
  if (!context.instance) return context.loading ? null : <p>{t('library.notFound')}</p>;
  return (
    <EditorFrame instance={context.instance} snapshot={context.snapshot} localPrefix={context.localPrefix}>
      <p className="text-sm text-muted-foreground">{t('editor.home')}</p>
    </EditorFrame>
  );
}
