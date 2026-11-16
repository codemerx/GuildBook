// The changes screen's model (PLAN.md §3.10 "The changes screen"): `git status` grouped by skill, and the checks a
// commit runs before it starts (IMPLEMENTATION.md Step 11 "The commit pipeline"): deletions to confirm (S8), paths
// that differ only in letter case, large files, and new scripts that need the executable bit.
import type { StatusEntry } from '../../ports/git.ts';

export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'typeChanged' | 'untracked' | 'conflicted';

export interface ChangedFile {
  /** The library path, with forward slashes. */
  readonly path: string;
  /** Where a rename came from. */
  readonly from: string | null;
  readonly change: FileChangeKind;
}

export type ChangeGroupKind = 'skill' | 'instructions' | 'library';

export interface ChangeGroup {
  /** `skill:<folder>`, `instructions` or `library` (library.yaml and every other file). */
  readonly key: string;
  readonly kind: ChangeGroupKind;
  readonly skill: string | null;
  readonly files: readonly ChangedFile[];
  /** Every path a commit of this group takes: the files, and where renamed ones came from. */
  readonly paths: readonly string[];
  /** The whole skill is deleted on this device: committing it asks first (PLAN.md §3.8 S8). */
  readonly deleted: boolean;
}

const SKILLS = 'skills/';
const INSTRUCTIONS = 'instructions/';

/** The group a library path belongs to. */
export function groupOf(path: string): { key: string; kind: ChangeGroupKind; skill: string | null } {
  if (path.startsWith(SKILLS)) {
    const skill = path.slice(SKILLS.length).split('/', 1)[0]!;
    if (skill !== '' && path.length > SKILLS.length + skill.length)
      return { key: `skill:${skill}`, kind: 'skill', skill };
  }
  if (path.startsWith(INSTRUCTIONS)) return { key: 'instructions', kind: 'instructions', skill: null };
  return { key: 'library', kind: 'library', skill: null };
}

function fileOf(entry: StatusEntry): ChangedFile {
  if (entry.kind === 'untracked') return { path: entry.path, from: null, change: 'untracked' };
  if (entry.kind === 'conflicted') return { path: entry.path, from: null, change: 'conflicted' };
  const code = entry.staged !== 'unmodified' ? entry.staged : entry.unstaged;
  // A copy is an addition for the user; an unmodified code can't come with a changed entry.
  const change: FileChangeKind = code === 'copied' || code === 'unmodified' ? 'added' : code;
  return { path: entry.path, from: entry.from, change };
}

/** For lists without duplicates. */
const byText = (a: string, b: string) => (a < b ? -1 : 1);
const ORDER: Readonly<Record<ChangeGroupKind, number>> = { instructions: 0, skill: 1, library: 2 };

/**
 * `git status` grouped by skill: instructions first, then the skills by name, then the library's other files.
 * `presentSkills` are the skill folders that still have files on disk: a skill with none left is deleted.
 */
export function groupChanges(entries: readonly StatusEntry[], presentSkills: ReadonlySet<string>): ChangeGroup[] {
  const groups = new Map<string, { key: string; kind: ChangeGroupKind; skill: string | null; files: ChangedFile[] }>();
  for (const entry of entries) {
    const file = fileOf(entry);
    const group = groupOf(file.path);
    const list = groups.get(group.key) ?? { ...group, files: [] };
    list.files.push(file);
    groups.set(group.key, list);
  }
  return [...groups.values()]
    .map((group) => {
      const files = [...group.files].sort((a, b) => byText(a.path, b.path));
      const paths = [...new Set(files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])))].sort(byText);
      const deleted =
        group.skill !== null &&
        !presentSkills.has(group.skill) &&
        files.length > 0 &&
        files.every((f) => f.change === 'deleted');
      return { ...group, files, paths, deleted };
    })
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || byText(a.key, b.key));
}

/** Pairs of paths that differ only in letter case: git on macOS and Windows can't check out both (PLAN.md §1.5). */
export function caseClashes(paths: readonly string[]): Array<readonly [string, string]> {
  const seen = new Map<string, string>();
  const clashes: Array<readonly [string, string]> = [];
  for (const path of [...new Set(paths)].sort(byText)) {
    const folded = path.toLowerCase();
    const other = seen.get(folded);
    if (other !== undefined) clashes.push([other, path]);
    else seen.set(folded, path);
  }
  return clashes;
}

/**
 * Every folder of a path set, so a clash between two folder names (`Scripts/` and `scripts/`) is found too, and only
 * the clashes that involve a path being committed.
 */
export function clashesWith(
  committing: readonly string[],
  tracked: readonly string[],
): Array<readonly [string, string]> {
  const expand = (path: string) => {
    const parts = path.split('/');
    return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  };
  const all = [...new Set([...committing, ...tracked].flatMap(expand))];
  const mine = new Set(committing.flatMap(expand));
  return caseClashes(all).filter(([a, b]) => mine.has(a) || mine.has(b));
}

/** Adding a file this large to the library asks first; larger than LARGE_FILE_REFUSED is refused (PLAN.md §3.19). */
export const LARGE_FILE_WARNING = 10 * 1024 * 1024;
export const LARGE_FILE_REFUSED = 50 * 1024 * 1024;

/** A new script in a skill that starts with `#!` but can't be run: the commit gives it the executable bit. */
export function needsExecutableBit(file: { path: string; bytes: Uint8Array; executable: boolean }): boolean {
  if (file.executable) return false;
  return file.bytes.length >= 2 && file.bytes[0] === 0x23 && file.bytes[1] === 0x21;
}
