// The library's validation rules (IMPLEMENTATION.md Step 2), as pure functions over what the scanner found. Each
// returns its issues; the snapshot collects them. PLAN.md: Agent Skills rules and prefix rules (§1.1, §3.2), size
// limits (§3.12, §3.19), broken relative links (§3.14), links that point outside their skill (§3.15), paths that
// differ only in letter case, and paths too long for Windows (§1.5).
import {
  agentSkillNameProblems,
  COMPATIBILITY_MAX,
  DESCRIPTION_MAX,
  FILE_SIZE_MAX,
  FILE_SIZE_WARN,
  type SkillHeaderRead,
  skillNameProblems,
  splitTags,
  tagProblems,
} from '@app/schemas';
import type { EntryKind } from '../../ports/fs.ts';
import { type PathFlavour, win32Paths } from '../../shared/paths.ts';
import { type Issue, issue } from './issues.ts';
import { resolveLink } from './markdown-links.ts';

/** One entry found in a skill folder (or elsewhere in the library), relative to its folder. */
export interface EntryFacts {
  /** With forward slashes. */
  readonly path: string;
  readonly kind: EntryKind;
  readonly size: number;
  readonly executable: boolean;
  /** A link's target, as stored. */
  readonly target: string | null;
  /** A file's or link's blob id (fingerprint.ts). */
  readonly blob: string | null;
}

/** What the scanner found in `skills/<folder>`. */
export interface SkillFacts {
  readonly folder: string;
  /** What `skills/<folder>` is: a skill is a folder; anything else is an unexpected entry. */
  readonly kind: EntryKind;
  /** The SKILL.md header, or null when there's no SKILL.md file. */
  readonly header: SkillHeaderRead | null;
  readonly entries: readonly EntryFacts[];
  /** Relative links in the skill's Markdown files: the file, the line and the target as written. */
  readonly links: ReadonlyArray<{ readonly file: string; readonly line: number; readonly target: string }>;
  /** How many lines SKILL.md has; missing when there's no SKILL.md (or for facts made before Step 10). */
  readonly skillMdLines?: number;
}

/** Instruction files' size limits, from the tool catalog (PLAN.md §3.12): Codex 32 KiB, Windsurf 6,000 characters. */
export interface InstructionLimit {
  readonly tool: string;
  readonly amount: number;
  readonly unit: 'bytes' | 'characters';
}

/** How close to a limit the company text alone may come before the editor warns (PLAN.md §3.12). */
export const NEAR_LIMIT = 0.8;

/** Windows' MAX_PATH: 260 characters including the terminating NUL, so a path of 260 or more can't be opened by tools
 * that don't use long paths (PLAN.md §1.5). */
export const WINDOWS_MAX_PATH = 260;

const skillPath = (folder: string, path = '') => (path === '' ? `skills/${folder}` : `skills/${folder}/${path}`);

/** `skills/<x>` must be a folder holding a SKILL.md with a readable header. */
export function layoutIssues(skill: SkillFacts): Issue[] {
  const at = skillPath(skill.folder);
  if (skill.kind !== 'dir') return [issue('skills.unexpectedEntry', at, { kind: skill.kind }, skill.folder)];
  if (skill.header === null)
    return [issue('skill.skillMdMissing', skillPath(skill.folder, 'SKILL.md'), {}, skill.folder)];
  const file = skillPath(skill.folder, 'SKILL.md');
  switch (skill.header.status) {
    case 'none':
      return [issue('skill.headerMissing', file, {}, skill.folder)];
    case 'unclosed':
      return [issue('skill.headerUnclosed', file, {}, skill.folder)];
    case 'invalid':
      return [issue('skill.headerInvalid', file, { reason: skill.header.errors[0] ?? '' }, skill.folder)];
    case 'notMap':
      return [issue('skill.headerNotMap', file, {}, skill.folder)];
    case 'ok':
      return [];
  }
}

const stringField = (fields: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = fields[key];
  return typeof value === 'string' ? value : null;
};

/**
 * The header's fields: the Agent Skills rules (name, description, compatibility, metadata, allowed-tools), the name
 * equal to the folder, the prefix, and the tags. Without a valid git prefix only the Agent Skills rules apply.
 */
export function headerIssues(skill: SkillFacts, prefix: string | null): Issue[] {
  if (skill.header?.status !== 'ok') return [];
  const fields = skill.header.fields;
  const file = skillPath(skill.folder, 'SKILL.md');
  const at = (code: Parameters<typeof issue>[0], params: Record<string, string | number> = {}) =>
    issue(code, file, params, skill.folder);
  const issues: Issue[] = [];

  const name = stringField(fields, 'name');
  if (name === null || name.trim() === '') issues.push(at('skill.nameMissing'));
  else {
    const problems = prefix === null ? agentSkillNameProblems(name) : skillNameProblems(name, prefix);
    for (const problem of problems) {
      // An empty name is reported as missing above; 'skillName.empty' is for the forms.
      if (problem !== 'skillName.empty') issues.push(at(problem, { name, prefix: prefix ?? '' }));
    }
    if (name !== skill.folder) issues.push(at('skill.nameMismatch', { name, folder: skill.folder }));
  }

  const description = stringField(fields, 'description');
  if (description === null || description.trim() === '') issues.push(at('skill.descriptionMissing'));
  else if ([...description].length > DESCRIPTION_MAX) {
    issues.push(at('skill.descriptionTooLong', { length: [...description].length, max: DESCRIPTION_MAX }));
  }

  const compatibility = fields.compatibility;
  if (typeof compatibility === 'string' && [...compatibility].length > COMPATIBILITY_MAX) {
    issues.push(at('skill.compatibilityTooLong', { length: [...compatibility].length, max: COMPATIBILITY_MAX }));
  }

  const metadata = fields.metadata;
  const metadataIsMap = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata);
  if (metadata !== undefined && (!metadataIsMap || Object.values(metadata).some((v) => typeof v !== 'string'))) {
    // Agent Skills: metadata maps strings to strings. Tags written as a list are still read (tagsOf).
    issues.push(at('skill.metadataInvalid'));
  }
  if ('allowed-tools' in fields && typeof fields['allowed-tools'] !== 'string')
    issues.push(at('skill.allowedToolsInvalid'));

  const tags = metadataIsMap ? (metadata as Record<string, unknown>).tags : undefined;
  const words = typeof tags === 'string' ? splitTags(tags) : Array.isArray(tags) ? tags.map(String) : [];
  for (const tag of words) if (tagProblems(tag).length > 0) issues.push(at('tag.invalid', { tag }));
  return issues;
}

/** Relative links in Markdown that lead nowhere, or out of the skill (PLAN.md §3.14). */
export function markdownLinkIssues(skill: SkillFacts): Issue[] {
  const present = new Set(skill.entries.map((entry) => entry.path));
  const issues: Issue[] = [];
  for (const link of skill.links) {
    const resolved = resolveLink(link.file, link.target);
    const file = skillPath(skill.folder, link.file);
    const params = { target: link.target, line: link.line };
    if (resolved.kind === 'outside') issues.push(issue('link.outsideSkill', file, params, skill.folder));
    else if (resolved.kind === 'inside' && resolved.path !== '' && !present.has(resolved.path)) {
      issues.push(issue('link.broken', file, params, skill.folder));
    }
  }
  return issues;
}

/**
 * A symbolic link inside a skill must stay inside it (PLAN.md §3.15): otherwise a file such as ~/.aws/credentials
 * could end up in copies or in the library. Absolute targets are always outside.
 */
export function symlinkIssues(skill: SkillFacts): Issue[] {
  const issues: Issue[] = [];
  for (const entry of skill.entries) {
    if (entry.kind !== 'link' || entry.target === null) continue;
    const target = entry.target.replace(/\\/g, '/');
    const outside =
      target.startsWith('/') || /^[A-Za-z]:\//.test(target) || resolveLink(entry.path, target).kind !== 'inside';
    if (outside)
      issues.push(
        issue('symlink.outsideSkill', skillPath(skill.folder, entry.path), { target: entry.target }, skill.folder),
      );
  }
  return issues;
}

/**
 * The Agent Skills specification: "Keep your main SKILL.md under 500 lines", because an agent loads the whole file when
 * it uses the skill; longer material goes into referenced files. It holds for every tool, so it's the editor's size
 * check for skills (PLAN.md §3.14).
 */
export const SKILL_MD_MAX_LINES = 500;

export function skillLengthIssues(skill: SkillFacts): Issue[] {
  const lines = skill.skillMdLines;
  if (lines === undefined || lines <= SKILL_MD_MAX_LINES) return [];
  return [
    issue('skill.tooLong', skillPath(skill.folder, 'SKILL.md'), { lines, max: SKILL_MD_MAX_LINES }, skill.folder),
  ];
}

/** Files over 10 MB get a warning; over 50 MB they're refused (PLAN.md §3.19). */
export function fileSizeIssues(skill: SkillFacts): Issue[] {
  return skill.entries.flatMap((entry) => {
    if (entry.kind !== 'file' || entry.size <= FILE_SIZE_WARN) return [];
    const code = entry.size > FILE_SIZE_MAX ? 'file.tooLarge' : 'file.large';
    return [issue(code, skillPath(skill.folder, entry.path), { size: entry.size }, skill.folder)];
  });
}

/** The skill folder an issue path belongs to, if any. */
function skillOf(path: string): string | null {
  const match = /^skills\/([^/]+)/.exec(path);
  return match?.[1] ?? null;
}

/**
 * Paths that differ only in letter case (PLAN.md §1.5): macOS and Windows can hold only one of them. One issue per
 * path of each such group, naming the others.
 */
export function caseConflictIssues(paths: readonly string[]): Issue[] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = path.normalize('NFC').toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), path]);
  }
  const issues: Issue[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const path of group) {
      const others = group.filter((other) => other !== path).join(', ');
      issues.push(issue('path.caseConflict', path, { others }, skillOf(path)));
    }
  }
  return issues;
}

/**
 * On Windows, a file whose full path, in the library or in its projected copy, has 260 characters or more (PLAN.md
 * §1.5). `projection` is set when the instance has a local prefix (PLAN.md §3.3): the copy of `skills/<folder>/<path>`
 * is `<projection root>\<local name>\<path>`.
 */
export function windowsPathIssues(
  paths: readonly string[],
  libraryRoot: string,
  projection: { readonly root: string; readonly localNames: ReadonlyMap<string, string> } | null,
  flavour: PathFlavour = win32Paths,
): Issue[] {
  const issues: Issue[] = [];
  for (const path of paths) {
    const full = flavour.join(libraryRoot, ...path.split('/'));
    const folder = skillOf(path);
    const local = folder === null ? undefined : projection?.localNames.get(folder);
    const copy =
      projection && folder !== null && local !== undefined
        ? flavour.join(projection.root, local, ...path.split('/').slice(2))
        : null;
    const longest = copy !== null && copy.length > full.length ? copy : full;
    if (longest.length >= WINDOWS_MAX_PATH) {
      issues.push(
        issue(
          'path.tooLongForWindows',
          path,
          { length: longest.length, where: longest === full ? 'library' : 'copy' },
          folder,
        ),
      );
    }
  }
  return issues;
}

/** The company instructions alone near or over a tool's limit (PLAN.md §3.12). */
export function instructionIssues(
  file: { readonly path: string; readonly bytes: number; readonly characters: number } | null,
  limits: readonly InstructionLimit[],
): Issue[] {
  if (file === null) return [];
  const issues: Issue[] = [];
  for (const limit of limits) {
    const size = limit.unit === 'bytes' ? file.bytes : file.characters;
    const params = { tool: limit.tool, size, limit: limit.amount, unit: limit.unit };
    if (size > limit.amount) issues.push(issue('instructions.overLimit', file.path, params));
    else if (size >= limit.amount * NEAR_LIMIT) issues.push(issue('instructions.nearLimit', file.path, params));
  }
  return issues;
}
