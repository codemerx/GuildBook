// The naming rules the UI checks while the user types (PLAN.md §3.2, IMPLEMENTATION.md §2.2): the prefix, skill names,
// tags and the description's length. Each rule exists once: core's value objects and the renderer's forms both use
// these. Every problem is a stable code; its message is the translation key `issues.<code>`.
import { z } from 'zod';

export const PREFIX_MIN = 3;
export const PREFIX_MAX = 16;
/** Agent Skills: a name has at most 64 characters (PLAN.md §1.1). */
export const SKILL_NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;
export const TAG_MAX = 32;

/** Reserved in Claude skill names; matched as a substring to be safe (PLAN.md §3.2). */
export const RESERVED_WORDS = ['claude', 'anthropic'] as const;

/**
 * Prefixes that are likely to clash with another company's library on someone's device, so the app warns about them
 * (PLAN.md §3.2: "dev, eng, team, app, skills, tools, …").
 */
export const GENERIC_PREFIXES = [
  'dev',
  'eng',
  'team',
  'app',
  'apps',
  'skill',
  'skills',
  'tool',
  'tools',
  'agent',
  'agents',
  'company',
  'corp',
  'work',
  'internal',
  'shared',
  'common',
  'core',
  'base',
  'main',
  'default',
  'test',
  'demo',
  'my',
  'org',
  'ops',
  'docs',
  'code',
] as const;

export type PrefixProblem =
  | 'prefix.tooShort'
  | 'prefix.tooLong'
  | 'prefix.uppercase'
  | 'prefix.digits'
  | 'prefix.punctuation'
  | 'prefix.nonAscii'
  | 'prefix.reserved';

export type PrefixWarning = 'prefix.generic';

export type SkillNameProblem =
  | 'skillName.empty'
  | 'skillName.tooLong'
  | 'skillName.characters'
  | 'skillName.hyphens'
  | 'skillName.reserved'
  | 'skillName.prefix';

export type TagProblem = 'tag.invalid';

/** The message key of a problem code. */
export function issueKey(code: string): string {
  return `issues.${code}`;
}

/**
 * Why a prefix isn't allowed, in the order PLAN.md §3.2's table gives them: 3–16 characters, lowercase `a–z` only
 * (no digits, hyphens, underscores, uppercase or Unicode), and no reserved word. Empty when it's valid.
 */
export function prefixProblems(value: string): PrefixProblem[] {
  const problems: PrefixProblem[] = [];
  const length = [...value].length;
  if (length < PREFIX_MIN) problems.push('prefix.tooShort');
  if (length > PREFIX_MAX) problems.push('prefix.tooLong');
  if (/[A-Z]/.test(value)) problems.push('prefix.uppercase');
  if (/[0-9]/.test(value)) problems.push('prefix.digits');
  // Any other ASCII character: hyphens, underscores, spaces, dots, control characters.
  // eslint-disable-next-line no-control-regex -- control characters are refused like any other non-letter
  if (/[\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]/.test(value)) problems.push('prefix.punctuation');
  // eslint-disable-next-line no-control-regex -- the range starts at NUL: everything outside ASCII
  if (/[^\x00-\x7f]/.test(value)) problems.push('prefix.nonAscii');
  if (RESERVED_WORDS.some((word) => value.toLowerCase().includes(word))) problems.push('prefix.reserved');
  return problems;
}

/** A valid prefix that's likely to clash with another company's (PLAN.md §3.2): a warning, not a refusal. */
export function prefixWarnings(value: string): PrefixWarning[] {
  return (GENERIC_PREFIXES as readonly string[]).includes(value) ? ['prefix.generic'] : [];
}

/**
 * The Agent Skills rules for a name, without the prefix: 1–64 characters, lowercase letters, digits and single
 * hyphens, not starting or ending with a hyphen, and no reserved word (PLAN.md §1.1, §3.2).
 */
export function agentSkillNameProblems(value: string): SkillNameProblem[] {
  if (value.length === 0) return ['skillName.empty'];
  const problems: SkillNameProblem[] = [];
  if ([...value].length > SKILL_NAME_MAX) problems.push('skillName.tooLong');
  if (/[^a-z0-9-]/.test(value)) problems.push('skillName.characters');
  if (value.startsWith('-') || value.endsWith('-') || value.includes('--')) problems.push('skillName.hyphens');
  if (RESERVED_WORDS.some((word) => value.includes(word))) problems.push('skillName.reserved');
  return problems;
}

/**
 * A company skill's name: the Agent Skills rules, and it starts with `<prefix>-` with something after it
 * (`^acme-[a-z0-9]+(-[a-z0-9]+)*$`, PLAN.md §3.2). The folder-name rule needs the folder, so the library's
 * validation checks it.
 */
export function skillNameProblems(value: string, prefix: string): SkillNameProblem[] {
  const problems = agentSkillNameProblems(value);
  if (problems.includes('skillName.empty')) return problems;
  if (!value.startsWith(`${prefix}-`) || value.length === prefix.length + 1) problems.push('skillName.prefix');
  return problems;
}

/** A tag: lowercase letters, digits and single hyphens, at most 32 characters (one word of `metadata.tags`). */
export function tagProblems(value: string): TagProblem[] {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) && value.length <= TAG_MAX ? [] : ['tag.invalid'];
}

/** The tags in a `metadata.tags` value: words separated by spaces (PLAN.md §3.6); commas are tolerated. */
export function splitTags(value: string): string[] {
  return value.split(/[\s,]+/).filter((word) => word.length > 0);
}

/** A title from a skill name without its prefix, for the editor's list (PLAN.md §3.14): `acme-code-review` → "Code review". */
export function friendlyTitle(name: string, prefix: string | null): string {
  const rest = prefix !== null && name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : name;
  const text = rest
    .split('-')
    .filter((word) => word.length > 0)
    .join(' ');
  return text.length === 0 ? name : text.charAt(0).toUpperCase() + text.slice(1);
}

/** How `metadata.tags` is written: the words, separated by single spaces. */
export function joinTags(tags: readonly string[]): string {
  return tags.join(' ');
}

function refineWith<T extends string>(problems: (value: string) => readonly T[]) {
  return (value: string, context: z.RefinementCtx) => {
    for (const code of problems(value)) context.addIssue({ code: 'custom', message: issueKey(code) });
  };
}

/** The prefix field: what the setup form checks as the admin types. */
export const PrefixSchema = z.string().superRefine(refineWith(prefixProblems));

/** A skill name under a prefix, e.g. in the editor's name field (the prefix part is shown fixed). */
export function skillNameSchema(prefix: string) {
  return z.string().superRefine(refineWith((value) => skillNameProblems(value, prefix)));
}

export const TagSchema = z.string().superRefine(refineWith(tagProblems));

export const DescriptionSchema = z
  .string()
  .trim()
  .min(1, { error: issueKey('skill.descriptionMissing') })
  .max(DESCRIPTION_MAX, { error: issueKey('skill.descriptionTooLong') });

/** A library id: `lib_` and 128 random bits as 32 lowercase hex digits (PLAN.md §3.2 library.yaml). */
export const LibraryIdSchema = z.string().regex(/^lib_[0-9a-f]{32}$/, { error: issueKey('library.idInvalid') });

/** Adding a file this large to a skill shows a warning: "Large files slow down every pull" (PLAN.md §3.19). */
export const FILE_SIZE_WARN = 10 * 1024 * 1024;
/** Files larger than this are refused (PLAN.md §3.19). */
export const FILE_SIZE_MAX = 50 * 1024 * 1024;
