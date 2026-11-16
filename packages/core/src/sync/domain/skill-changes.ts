// How the skills changed between two commits (PLAN.md §3.10 "Adjusting links"): added, deleted, modified and renamed
// skill folders, from git's file-level diff with rename detection and the two trees. git pairs files by content, so a
// short SKILL.md whose `name:` line changed with its folder can fall below its similarity threshold (A3.7). A deleted
// and an added skill therefore also pair up when most of their files are the same: the same blob at the same place,
// a rename git found between them, or a SKILL.md that's equal apart from its `name:` line.
import type { FileChange, Oid } from '../../ports/git.ts';

/** A skill folder's files: path inside the skill → blob id. */
export type SkillFiles = ReadonlyMap<string, Oid>;

export interface SkillSide {
  /** Folder name → git's tree id of the folder (its fingerprint). */
  readonly skills: ReadonlyMap<string, Oid>;
  /** The files of the skills that may pair as renames (deleted ones before, added ones after). */
  readonly files: ReadonlyMap<string, SkillFiles>;
  /** SKILL.md's text for those skills, when it could be read. */
  readonly skillMd: ReadonlyMap<string, string>;
}

export interface SkillRename {
  readonly from: string;
  readonly to: string;
  /** Anything changed besides the folder name and the `name:` line. */
  readonly modified: boolean;
}

export interface SkillChanges {
  readonly added: readonly string[];
  readonly deleted: readonly string[];
  readonly modified: readonly string[];
  readonly renamed: readonly SkillRename[];
}

export const NO_SKILL_CHANGES: SkillChanges = { added: [], deleted: [], modified: [], renamed: [] };

/** At least this share of the larger skill's files must match for a deleted and an added skill to be one rename. */
export const RENAME_SHARE = 0.5;

const SKILL_MD = 'SKILL.md';

/** The skill folder a library path is in (`skills/<folder>/…`), and the path inside it. */
export function skillPath(path: string, skillsDir = 'skills'): { folder: string; inner: string } | undefined {
  const prefix = `${skillsDir}/`;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { folder: rest.slice(0, slash), inner: rest.slice(slash + 1) };
}

/** SKILL.md without its header's `name:` line, so a rename's own edit doesn't count as a change. */
export function withoutNameLine(text: string): string {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return normalized;
  // The header up to and including the newline before its closing `---`.
  const end = normalized.indexOf('\n---', 3);
  const header = end < 0 ? normalized : normalized.slice(0, end + 1);
  const body = end < 0 ? '' : normalized.slice(end + 1);
  return header.replace(/^name[ \t]*:.*(\n|$)/m, '') + body;
}

interface Score {
  readonly matched: number;
  readonly exact: boolean;
}

function score(
  from: string,
  to: string,
  before: SkillSide,
  after: SkillSide,
  gitRenames: ReadonlyMap<string, string>,
): Score {
  const fromFiles = before.files.get(from) ?? new Map<string, Oid>();
  const toFiles = after.files.get(to) ?? new Map<string, Oid>();
  const sameSkillMd = () => {
    const a = before.skillMd.get(from);
    const b = after.skillMd.get(to);
    return a !== undefined && b !== undefined && withoutNameLine(a) === withoutNameLine(b);
  };
  const taken = new Set<string>();
  let matched = 0;
  let exactly = 0;
  for (const [inner, oid] of fromFiles) {
    // The same file at the same place, or SKILL.md changed only in its name line: unchanged by the rename.
    if (
      !taken.has(inner) &&
      (toFiles.get(inner) === oid || (inner === SKILL_MD && toFiles.has(inner) && sameSkillMd()))
    ) {
      taken.add(inner);
      matched++;
      exactly++;
      continue;
    }
    // A rename git found into the other skill: the same file, changed or moved inside the skill.
    const renamedTo = gitRenames.get(`${from}/${inner}`);
    const target = renamedTo?.startsWith(`${to}/`) ? renamedTo.slice(to.length + 1) : undefined;
    if (target !== undefined && toFiles.has(target) && !taken.has(target)) {
      taken.add(target);
      matched++;
    }
  }
  return { matched, exact: exactly === fromFiles.size && exactly === toFiles.size };
}

/**
 * The skill-level changes between `before` and `after`. `changes` is git's diff of the two commits with renames
 * detected; only its renames are used, to pair skills.
 */
export function skillChanges(
  changes: readonly FileChange[],
  before: SkillSide,
  after: SkillSide,
  skillsDir = 'skills',
): SkillChanges {
  const deleted = [...before.skills.keys()].filter((name) => !after.skills.has(name)).sort();
  const added = [...after.skills.keys()].filter((name) => !before.skills.has(name)).sort();
  const modified = [...before.skills.keys()]
    .filter((name) => after.skills.has(name) && after.skills.get(name) !== before.skills.get(name))
    .sort();

  // git's renames between skill folders, as `<folder>/<inner>` → `<folder>/<inner>`.
  const gitRenames = new Map<string, string>();
  for (const change of changes) {
    if (change.status !== 'renamed' || change.from === null) continue;
    const from = skillPath(change.from, skillsDir);
    const to = skillPath(change.path, skillsDir);
    if (from && to) gitRenames.set(`${from.folder}/${from.inner}`, `${to.folder}/${to.inner}`);
  }

  const candidates: Array<{ from: string; to: string; share: number; exact: boolean }> = [];
  for (const from of deleted) {
    for (const to of added) {
      const { matched, exact } = score(from, to, before, after, gitRenames);
      const size = Math.max(before.files.get(from)?.size ?? 0, after.files.get(to)?.size ?? 0);
      const share = size === 0 ? 0 : matched / size;
      if (share >= RENAME_SHARE) candidates.push({ from, to, share, exact });
    }
  }
  // The best pairs first; a skill takes part in one rename at most.
  candidates.sort((a, b) => b.share - a.share || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const renamed: SkillRename[] = [];
  const paired = new Set<string>();
  for (const candidate of candidates) {
    if (paired.has(`-${candidate.from}`) || paired.has(`+${candidate.to}`)) continue;
    paired.add(`-${candidate.from}`);
    paired.add(`+${candidate.to}`);
    renamed.push({ from: candidate.from, to: candidate.to, modified: !candidate.exact });
  }
  renamed.sort((a, b) => a.from.localeCompare(b.from));
  return {
    added: added.filter((name) => !paired.has(`+${name}`)),
    deleted: deleted.filter((name) => !paired.has(`-${name}`)),
    modified,
    renamed,
  };
}

export function hasSkillChanges(changes: SkillChanges): boolean {
  return changes.added.length + changes.deleted.length + changes.modified.length + changes.renamed.length > 0;
}
