// Safe unpacking of a `.zip` or `.skill` file (PLAN.md §3.18 C, §3.19): before anything is written, every entry is
// checked, and one bad entry refuses the whole archive. Refused: absolute paths and `..`, symbolic links, a file over
// 50 MB, more than 200 MB in total, encrypted entries, and names that a file system would read differently (a drive,
// a backslash, a control character, two entries that would land on the same path). While unpacking, each entry is held
// to the size it declared, so an archive can't lie its way past the limits.
import { FILE_SIZE_MAX } from '@app/schemas';
import type { ArchiveEntry } from '../../ports/archive.ts';

export const ARCHIVE_FILE_MAX = FILE_SIZE_MAX;
export const ARCHIVE_TOTAL_MAX = 200 * 1024 * 1024;
/** More entries than any skill bundle has; far below what would slow the review down. */
export const ARCHIVE_ENTRIES_MAX = 10_000;

export type ArchiveProblemCode =
  | 'absolutePath'
  | 'parentPath'
  | 'badName'
  | 'link'
  | 'encrypted'
  | 'unsupported'
  | 'duplicate'
  | 'fileTooLarge'
  | 'tooLarge'
  | 'tooManyEntries';

export interface ArchiveProblem {
  readonly code: ArchiveProblemCode;
  /** The entry's name as the archive gives it; '' for the archive as a whole. */
  readonly path: string;
}

/**
 * An entry's name as a relative path with forward slashes and no empty, `.` or `..` parts, or the reason it can't be
 * one. Zip names use `/`; a backslash, a drive letter or a control character is never accepted.
 */
export function entryPath(name: string): { path: string } | { problem: ArchiveProblemCode } {
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return { problem: 'absolutePath' };
  // eslint-disable-next-line no-control-regex -- control characters are refused
  if (name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || name.includes(':')) return { problem: 'badName' };
  const parts = name.split('/').filter((part, index, all) => !(part === '' && index === all.length - 1));
  if (parts.some((part) => part === '..')) return { problem: 'parentPath' };
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.')) return { problem: 'badName' };
  // Names a Windows file system would change (a trailing dot or space) could land on another entry's path.
  if (parts.some((part) => /[. ]$/.test(part))) return { problem: 'badName' };
  return { path: parts.join('/') };
}

/** Every problem of an archive's listing; none means it may be unpacked. */
export function archiveProblems(entries: readonly ArchiveEntry[]): ArchiveProblem[] {
  const problems: ArchiveProblem[] = [];
  if (entries.length > ARCHIVE_ENTRIES_MAX) problems.push({ code: 'tooManyEntries', path: '' });
  const seen = new Map<string, 'file' | 'dir'>();
  let total = 0;
  for (const entry of entries) {
    const checked = entryPath(entry.path);
    if ('problem' in checked) {
      problems.push({ code: checked.problem, path: entry.path });
      continue;
    }
    if (entry.kind === 'link') problems.push({ code: 'link', path: entry.path });
    if (entry.encrypted) problems.push({ code: 'encrypted', path: entry.path });
    if (!entry.supported) problems.push({ code: 'unsupported', path: entry.path });
    if (entry.kind === 'file' && entry.size > ARCHIVE_FILE_MAX)
      problems.push({ code: 'fileTooLarge', path: entry.path });
    if (entry.kind === 'file') total += entry.size;
    // Two entries on one path (in any letter case: macOS and Windows would see one) make the result depend on order.
    const key = checked.path.toLowerCase();
    const kind = entry.kind === 'dir' ? 'dir' : 'file';
    const before = seen.get(key);
    if (before !== undefined && (before === 'file' || kind === 'file'))
      problems.push({ code: 'duplicate', path: entry.path });
    seen.set(key, before === 'file' ? 'file' : kind);
  }
  // A file whose folder is a file in the same archive.
  for (const key of seen.keys()) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.get(parts.slice(0, i).join('/')) === 'file') {
        problems.push({ code: 'duplicate', path: key });
        break;
      }
    }
  }
  if (total > ARCHIVE_TOTAL_MAX) problems.push({ code: 'tooLarge', path: '' });
  return problems;
}
