// Name fixing for imports (PLAN.md §3.18): an imported skill gets a name that follows the Agent Skills rules and starts
// with the library's prefix, e.g. `code-review` → `acme-code-review`, `Deploy_Helper` → `acme-deploy-helper`. The
// reviewer can still choose another name before [Add].
import { agentSkillNameProblems, RESERVED_WORDS, SKILL_NAME_MAX, skillNameProblems } from '@app/schemas';

export interface ImportedName {
  /** The name in the library: `<prefix>-<rest>`. */
  readonly name: string;
  /** The original didn't follow the Agent Skills rules and was changed to (PLAN.md §3.18 "name fixed"). */
  readonly fixed: boolean;
}

/**
 * The original name made to follow the Agent Skills rules: lowercase letters, digits and single hyphens, no reserved
 * word, at most 64 characters. Letters with accents lose them; anything else becomes a hyphen.
 */
export function standardName(original: string): string {
  let name = original
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  for (const word of RESERVED_WORDS) name = name.split(word).join('-');
  name = name.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return trimTo(name, SKILL_NAME_MAX);
}

/** The name an imported skill gets in a library with this prefix. */
export function importedName(original: string, prefix: string): ImportedName {
  const standard = standardName(original);
  const fixed = standard !== original.trim() || agentSkillNameProblems(original.trim()).length > 0;
  const rest = standard.startsWith(`${prefix}-`) ? standard.slice(prefix.length + 1) : standard;
  const name = trimTo(`${prefix}-${rest === '' ? 'skill' : rest}`, SKILL_NAME_MAX);
  return { name, fixed };
}

/** Whether a name the reviewer chose can be used in the library (PLAN.md §3.2). */
export function nameUsable(name: string, prefix: string): boolean {
  return skillNameProblems(name, prefix).length === 0;
}

function trimTo(name: string, max: number): string {
  return name.length <= max ? name : name.slice(0, max).replace(/-+$/, '');
}
