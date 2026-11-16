// Validation issues (IMPLEMENTATION.md Step 2, A2.8): each rule produces issues with a stable code, a severity, the
// library path it's about, and parameters for its message. The message is the translation `issues.<code>`.
import { issueKey } from '@app/schemas';

export const issueSeverities = {
  // library.yaml (PLAN.md §3.2)
  'library.configMissing': 'error',
  'library.configInvalid': 'error',
  'library.idInvalid': 'error',
  'library.formatInvalid': 'error',
  'library.notSetUp': 'error',
  'library.minAppVersionInvalid': 'warning',
  'library.suggestInvalid': 'warning',
  'library.repoOnlyTagsInvalid': 'warning',
  'library.formatTooNew': 'error',
  'library.appTooOld': 'error',
  // The layout: skills/<name>/SKILL.md, instructions/AGENTS.md (PLAN.md §3.0)
  'skills.unexpectedEntry': 'warning',
  // Agent Skills rules (PLAN.md §1.1)
  'skill.skillMdMissing': 'error',
  'skill.headerMissing': 'error',
  'skill.headerUnclosed': 'error',
  'skill.headerInvalid': 'error',
  'skill.headerNotMap': 'error',
  'skill.nameMissing': 'error',
  'skill.nameMismatch': 'error',
  'skill.descriptionMissing': 'error',
  'skill.descriptionTooLong': 'error',
  'skill.compatibilityTooLong': 'warning',
  'skill.metadataInvalid': 'warning',
  'skill.allowedToolsInvalid': 'warning',
  'skill.tooLong': 'warning',
  // An imported skill's name is already used, in the library or by another skill of the import (PLAN.md §3.18).
  'skill.nameTaken': 'error',
  // Names and the prefix (PLAN.md §3.2)
  'skillName.tooLong': 'error',
  'skillName.characters': 'error',
  'skillName.hyphens': 'error',
  'skillName.reserved': 'error',
  'skillName.prefix': 'error',
  'tag.invalid': 'warning',
  // Links and files (PLAN.md §3.14, §3.15, §3.19)
  'link.broken': 'warning',
  'link.outsideSkill': 'warning',
  'symlink.outsideSkill': 'error',
  'file.large': 'warning',
  'file.tooLarge': 'error',
  // Paths (PLAN.md §1.5)
  'path.caseConflict': 'error',
  'path.tooLongForWindows': 'warning',
  // Instructions (PLAN.md §3.12)
  'instructions.nearLimit': 'warning',
  'instructions.overLimit': 'warning',
} as const;

export type IssueCode = keyof typeof issueSeverities;
export type IssueSeverity = 'error' | 'warning';
export type IssueParams = Readonly<Record<string, string | number>>;

export interface Issue {
  readonly code: IssueCode;
  readonly severity: IssueSeverity;
  /** The translation key of its message: `issues.<code>`. */
  readonly messageKey: string;
  /** The library path it's about, with forward slashes ('' for the library itself). */
  readonly path: string;
  /** The skill folder it belongs to, if any. */
  readonly skill: string | null;
  readonly params: IssueParams;
}

export const issueCodes = Object.keys(issueSeverities) as IssueCode[];

export function issue(code: IssueCode, path: string, params: IssueParams = {}, skill: string | null = null): Issue {
  return { code, severity: issueSeverities[code], messageKey: issueKey(code), path, skill, params };
}

/** A stable order: by path, then code, then parameters, so equal snapshots compare equal. */
export function compareIssues(a: Issue, b: Issue): number {
  return (
    compareText(a.path, b.path) ||
    compareText(a.code, b.code) ||
    compareText(JSON.stringify(a.params), JSON.stringify(b.params))
  );
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
