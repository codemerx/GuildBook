// The YAML header as a form (PLAN.md §3.14): the name with its fixed prefix part, validated as the user types (A10.3);
// the description with a counter and the hint "say when to use it"; tags as chips with autocomplete from the tags the
// library uses; the advanced fields collapsed. Each edit changes only its own YAML lines (A10.2).
import { ADVANCED_FIELDS, type AdvancedField, DESCRIPTION_MAX, tagProblems } from '@app/schemas';
import { X } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { FieldError, Input, Label } from '../../ui/input.tsx';
import { advancedEdit, gitName, type HeaderValues, nameParts, nameProblems, normalizeTag } from './skill-text.ts';
import type { HeaderEdit } from '@app/schemas';

export interface HeaderFormProps {
  values: HeaderValues;
  gitPrefix: string;
  /** The prefix shown fixed: the local one under a local prefix (PLAN.md §3.3). */
  effectivePrefix: string;
  /** Tags the library already uses, for the autocomplete. */
  knownTags: readonly string[];
  /** A header edit; the form shows nothing else. */
  onEdit: (edit: HeaderEdit) => void;
  /** A valid new name, confirmed with Enter or by leaving the field: the skill is renamed. */
  onRename: (gitName: string) => Promise<void>;
}

const ADVANCED_LABELS: Record<AdvancedField, string> = {
  license: 'editor.header.license',
  compatibility: 'editor.header.compatibility',
  'allowed-tools': 'editor.header.allowedTools',
};

/** The page gives the form `key={values.name}`, so the name field starts again from a renamed skill's name. */
export function HeaderForm({ values, gitPrefix, effectivePrefix, knownTags, onEdit, onRename }: HeaderFormProps) {
  const { t } = useTranslation();
  const id = useId();
  const parts = nameParts(values.name, gitPrefix, effectivePrefix);
  const [rest, setRest] = useState(parts.rest);
  const [renaming, setRenaming] = useState(false);
  const problems = nameProblems(rest, gitPrefix, effectivePrefix);
  const renameIfChanged = () => {
    const wanted = gitName(rest, gitPrefix);
    if (problems.length > 0 || wanted === values.name || renaming) return;
    setRenaming(true);
    void onRename(wanted).finally(() => setRenaming(false));
  };
  const [tag, setTag] = useState('');
  const tagError = tag !== '' && tagProblems(normalizeTag(tag)).length > 0;
  const addTag = () => {
    const value = normalizeTag(tag);
    if (value === '' || tagProblems(value).length > 0) return;
    if (!values.tags.includes(value)) onEdit({ tags: [...values.tags, value] });
    setTag('');
  };
  const length = [...values.description].length;
  return (
    <form
      aria-label={t('editor.header.label')}
      className="flex flex-col gap-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-name`}>{t('editor.header.name')}</Label>
        <div className="flex items-stretch">
          <span
            aria-hidden="true"
            className="flex items-center rounded-l-md border border-r-0 border-input bg-muted px-2 font-mono text-sm text-muted-foreground"
          >
            {parts.shown}
          </span>
          <Input
            id={`${id}-name`}
            value={rest}
            className="rounded-l-none font-mono"
            aria-describedby={`${id}-name-prefix ${id}-name-error`}
            aria-invalid={problems.length > 0}
            disabled={renaming}
            onChange={(event) => setRest(event.target.value)}
            onBlur={renameIfChanged}
            onKeyDown={(event) => {
              if (event.key === 'Enter') renameIfChanged();
              if (event.key === 'Escape') setRest(parts.rest);
            }}
          />
        </div>
        <p id={`${id}-name-prefix`} className="text-xs text-muted-foreground">
          {t('editor.header.nameHint', { prefix: parts.shown })}
        </p>
        <FieldError
          id={`${id}-name-error`}
          message={problems[0] ? t(problems[0], { prefix: effectivePrefix }) : undefined}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor={`${id}-description`}>{t('editor.header.description')}</Label>
          <span
            id={`${id}-count`}
            className={length > DESCRIPTION_MAX ? 'text-xs text-danger' : 'text-xs text-muted-foreground'}
          >
            {t('editor.header.count', { count: length, max: DESCRIPTION_MAX })}
          </span>
        </div>
        <textarea
          id={`${id}-description`}
          value={values.description}
          rows={3}
          aria-describedby={`${id}-hint ${id}-count ${id}-description-error`}
          aria-invalid={length === 0 || length > DESCRIPTION_MAX}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onEdit({ description: event.target.value })}
        />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {t('editor.header.descriptionHint')}
        </p>
        <FieldError
          id={`${id}-description-error`}
          message={
            length === 0
              ? t('issues.skill.descriptionMissing')
              : length > DESCRIPTION_MAX
                ? t('issues.skill.descriptionTooLong', { length, max: DESCRIPTION_MAX })
                : undefined
          }
        />
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">{t('editor.header.tags')}</legend>
        <ul aria-label={t('editor.header.tags')} className="flex flex-wrap gap-1.5">
          {values.tags.map((value) => (
            <li
              key={value}
              className="flex items-center gap-1 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs"
            >
              {value}
              <button
                type="button"
                aria-label={t('editor.header.removeTag', { tag: value })}
                className="rounded-full p-0.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => onEdit({ tags: values.tags.filter((other) => other !== value) })}
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Input
            aria-label={t('editor.header.addTag')}
            list={`${id}-tags`}
            value={tag}
            aria-invalid={tagError}
            aria-describedby={`${id}-tag-error`}
            className="max-w-56"
            onChange={(event) => setTag(event.target.value.replace(/[\s,]/g, ''))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ',' || event.key === ' ') {
                event.preventDefault();
                addTag();
              }
            }}
          />
          <datalist id={`${id}-tags`}>
            {knownTags
              .filter((known) => !values.tags.includes(known))
              .map((known) => (
                <option key={known} value={known} />
              ))}
          </datalist>
          <Button type="button" variant="secondary" size="sm" disabled={tag === '' || tagError} onClick={addTag}>
            {t('editor.header.add')}
          </Button>
        </div>
        <FieldError id={`${id}-tag-error`} message={tagError ? t('issues.tag.invalid', { tag }) : undefined} />
      </fieldset>

      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">{t('editor.header.advanced')}</summary>
        <div className="mt-3 flex flex-col gap-3">
          {ADVANCED_FIELDS.map((key) => (
            <div key={key} className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-${key}`}>{t(ADVANCED_LABELS[key])}</Label>
              <Input
                id={`${id}-${key}`}
                value={values.advanced[key]}
                onChange={(event) => onEdit(advancedEdit(key, event.target.value))}
              />
            </div>
          ))}
        </div>
      </details>
    </form>
  );
}
