// A SKILL.md as the editor shows it (PLAN.md §3.14): the header as a form, the body in the rich editor. The form's
// edits go through the format-preserving edits of `schemas` (A10.2), so they change only their own YAML lines; the body
// is joined back after the header exactly as it was.
import {
  ADVANCED_FIELDS,
  type AdvancedField,
  editSkillMd,
  type HeaderEdit,
  readSkillHeader,
  SKILL_NAME_MAX,
  skillNameProblems,
  splitSkillMd,
  tagsOf,
} from '@app/schemas';

export interface HeaderValues {
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly advanced: Readonly<Record<AdvancedField, string>>;
}

/** The form's values, or null when the header can't be read (the form then asks to fix it in source mode). */
export function headerValues(text: string): HeaderValues | null {
  const header = readSkillHeader(text);
  if (header.status !== 'ok') return null;
  const field = (key: string) => {
    const value = header.fields[key];
    return typeof value === 'string' ? value : '';
  };
  return {
    name: field('name'),
    description: field('description'),
    tags: tagsOf(header.fields),
    advanced: Object.fromEntries(ADVANCED_FIELDS.map((key) => [key, field(key)])) as Record<AdvancedField, string>,
  };
}

/** The body that the rich editor holds. */
export function bodyOf(text: string): string {
  return splitSkillMd(text).body;
}

/** The file with a new body after the unchanged header (byte order mark and marker lines included). */
export function withBody(text: string, body: string): string {
  return text.slice(0, text.length - bodyOf(text).length) + body;
}

/** The file after a form edit; null when the header can't take it (the form shows why). */
export function withHeaderEdit(text: string, edit: HeaderEdit): string | null {
  const result = editSkillMd(text, edit);
  return result.ok ? result.text : null;
}

/** An advanced field's form value as an edit: empty removes the field. */
export function advancedEdit(key: AdvancedField, value: string): HeaderEdit {
  return { advanced: { [key]: value.trim() === '' ? null : value } };
}

/**
 * The name field (PLAN.md §3.2, §3.3): the effective prefix is shown fixed (the local one under a local prefix), the user
 * types the rest, and the name in git gets the git prefix.
 */
export interface NameParts {
  /** What's shown fixed before the field, e.g. `acmelabs-`. */
  readonly shown: string;
  /** The part the user types. */
  readonly rest: string;
}

export function nameParts(gitName: string, gitPrefix: string, effectivePrefix: string): NameParts {
  const own = `${gitPrefix}-`;
  return { shown: `${effectivePrefix}-`, rest: gitName.startsWith(own) ? gitName.slice(own.length) : gitName };
}

export function gitName(rest: string, gitPrefix: string): string {
  return `${gitPrefix}-${rest}`;
}

/**
 * The problems of a name as typed, as translation keys (`issues.<code>`); empty when it's valid. Under a local prefix
 * the name on this device must fit 64 characters too (PLAN.md §3.3).
 */
export function nameProblems(rest: string, gitPrefix: string, effectivePrefix: string = gitPrefix): string[] {
  if (rest.length === 0) return ['issues.skillName.empty'];
  const problems: string[] = skillNameProblems(gitName(rest, gitPrefix), gitPrefix);
  const local = `${effectivePrefix}-${rest}`;
  if (!problems.includes('skillName.tooLong') && [...local].length > SKILL_NAME_MAX) problems.push('skillName.tooLong');
  return problems.map((code) => `issues.${code}`);
}

/** A tag as typed: lowercase, spaces and commas end it. */
export function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}
