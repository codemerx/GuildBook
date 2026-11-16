// The prefix lock and the prefix change (PLAN.md §3.2 "Locking"), as pure rules. Until the first skill is pushed,
// anyone who can push to the company branch can correct the prefix; after that it's locked, and only an Admin changes
// it. A change renames every skill that starts with the old prefix: its folder and its `name:` line, in one commit.
import {
  prefixProblems,
  type PrefixProblem,
  prefixWarnings,
  type PrefixWarning,
  skillNameProblems,
} from '@app/schemas';
import type { RoleActions } from '../../review/index.ts';

/** What the prefix card offers: the correction before the lock, the Admin's change after it. */
export type PrefixAction = 'correct' | 'change';

/** Why the user can't change the prefix here, or null when they can. */
export type PrefixRefusal =
  /** Before the lock: only someone who can push to the company branch corrects it. */
  | 'push-needed'
  /** After the lock: only an Admin changes it. */
  | 'admin-needed';

/**
 * Which action the library's state gives, and whether the user's role allows it (PLAN.md §3.2, §3.11). `actions` is
 * null for a library without a sign-in (a test library): nothing is gated there, as for every other action.
 */
export function prefixAction(
  locked: boolean,
  actions: RoleActions | null,
): { readonly action: PrefixAction; readonly refusal: PrefixRefusal | null } {
  if (!locked) {
    const allowed = actions === null || actions.companyBranch === 'push';
    return { action: 'correct', refusal: allowed ? null : 'push-needed' };
  }
  return { action: 'change', refusal: actions === null || actions.admin ? null : 'admin-needed' };
}

/** Why a new prefix can't be used for this library. */
export type NewPrefixProblem = { readonly code: 'rules'; readonly problem: PrefixProblem } | { readonly code: 'same' };

export function newPrefixProblem(prefix: string, current: string): NewPrefixProblem | null {
  const [problem] = prefixProblems(prefix);
  if (problem) return { code: 'rules', problem };
  return prefix === current ? { code: 'same' } : null;
}

export function newPrefixWarnings(prefix: string): PrefixWarning[] {
  return prefixProblems(prefix).length > 0 ? [] : prefixWarnings(prefix);
}

export interface PrefixRename {
  readonly from: string;
  readonly to: string;
}

/** A skill the change can't rename: its new name breaks the rules, or another folder has it already. */
export interface RenameProblem {
  readonly skill: string;
  readonly name: string;
  readonly code: 'tooLong' | 'invalid' | 'taken';
}

export interface RenamePlan {
  /** Every skill that starts with the old prefix, by folder, with its new name. */
  readonly renames: readonly PrefixRename[];
  /** Skills whose folder doesn't start with the old prefix (pushed with another git tool): left as they are. */
  readonly untouched: readonly string[];
  readonly problems: readonly RenameProblem[];
}

/** The renames a prefix change makes (PLAN.md §3.2 step 2): `acme-code-review` → `newco-code-review`. */
export function renamePlan(folders: readonly string[], from: string, to: string): RenamePlan {
  const renames: PrefixRename[] = [];
  const untouched: string[] = [];
  const problems: RenameProblem[] = [];
  const sorted = [...folders].sort();
  const renamed = new Set<string>();
  for (const folder of sorted) {
    if (!folder.startsWith(`${from}-`)) {
      untouched.push(folder);
      continue;
    }
    const name = `${to}${folder.slice(from.length)}`;
    renames.push({ from: folder, to: name });
    renamed.add(folder.toLowerCase());
    const rules = skillNameProblems(name, to);
    if (rules.includes('skillName.tooLong')) problems.push({ skill: folder, name, code: 'tooLong' });
    else if (rules.length > 0) problems.push({ skill: folder, name, code: 'invalid' });
  }
  // A new name that a folder which stays already has, in any letter case (macOS and Windows see one folder).
  const staying = new Set(sorted.filter((folder) => !renamed.has(folder.toLowerCase())).map((f) => f.toLowerCase()));
  for (const rename of renames) {
    if (staying.has(rename.to.toLowerCase())) problems.push({ skill: rename.from, name: rename.to, code: 'taken' });
  }
  return { renames, untouched, problems };
}
