// The library's names as value objects (PLAN.md §3.2, IMPLEMENTATION.md §3.1 "Value objects and branded types"). The
// rules themselves are in schemas, where the renderer's forms use them too; a value of these types has passed them.
import {
  LibraryIdSchema,
  type PrefixProblem,
  prefixProblems,
  type SkillNameProblem,
  skillNameProblems,
  type TagProblem,
  tagProblems,
} from '@app/schemas';
import type { Random } from '../../ports/random.ts';
import type { Branded } from '../../shared/brand.ts';
import { randomHex } from '../../shared/ids.ts';
import { err, ok, type Result } from '../../shared/result.ts';

export type Prefix = Branded<string, 'Prefix'>;
export type SkillName = Branded<string, 'SkillName'>;
export type Tag = Branded<string, 'Tag'>;
export type LibraryId = Branded<string, 'LibraryId'>;

export function parsePrefix(value: string): Result<Prefix, PrefixProblem[]> {
  const problems = prefixProblems(value);
  return problems.length === 0 ? ok(value as Prefix) : err(problems);
}

/** A company skill's name under its prefix. The folder must carry the same name; the library's checks see to that. */
export function parseSkillName(value: string, prefix: Prefix): Result<SkillName, SkillNameProblem[]> {
  const problems = skillNameProblems(value, prefix);
  return problems.length === 0 ? ok(value as SkillName) : err(problems);
}

export function parseTag(value: string): Result<Tag, TagProblem[]> {
  const problems = tagProblems(value);
  return problems.length === 0 ? ok(value as Tag) : err(problems);
}

export function parseLibraryId(value: string): Result<LibraryId, 'library.idInvalid'> {
  return LibraryIdSchema.safeParse(value).success ? ok(value as LibraryId) : err('library.idInvalid');
}

/** A new library's id: 128 random bits (PLAN.md §3.2). It never changes afterwards. */
export function newLibraryId(random: Random): LibraryId {
  return `lib_${randomHex(random, 16)}` as LibraryId;
}

/**
 * The prefix this device uses for an instance's skills: the local prefix when one is set (PLAN.md §3.3), else the git
 * prefix from library.yaml. Link names, owned files and projected copies use it; git always keeps the git prefix.
 */
export function effectivePrefix(gitPrefix: Prefix, localPrefix: Prefix | null): Prefix {
  return localPrefix ?? gitPrefix;
}

/**
 * A skill's name under the effective prefix: `acme-code-review` becomes `acmelabs-code-review` with the local prefix
 * `acmelabs`. Undefined when the name doesn't start with the git prefix, which can't be given a local name
 * (PLAN.md §3.2 "Content arriving with invalid names").
 */
export function localName(name: string, gitPrefix: Prefix, localPrefix: Prefix | null): string | undefined {
  if (!name.startsWith(`${gitPrefix}-`)) return undefined;
  return localPrefix === null ? name : `${localPrefix}${name.slice(gitPrefix.length)}`;
}

/**
 * Skills that carry another prefix than the library's (PLAN.md §3.2 step 4): new in a request branch made under the
 * old prefix, for example. Validation flags them, and their authors rename them before the request is merged.
 */
export function withOtherPrefix(folders: readonly string[], prefix: string): string[] {
  return folders.filter((folder) => !folder.startsWith(`${prefix}-`)).sort();
}
