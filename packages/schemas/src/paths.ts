// Paths inside the library, as the window sends them (Step 17, TESTING.md §9.5): git's form, relative to the library
// folder, with `/` between the parts. A path that could leave the library is refused before any use case sees it:
// `..`, an absolute path, a drive or a share, a home folder (`~`), a backslash, or a NUL byte.
import { z } from 'zod';

/** Whether a path is a plain path inside the library, in git's form. */
export function isLibraryRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 4096) return false;
  if (/[\\\0]/.test(path) || path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** A path inside the library, e.g. `skills/acme-code-review/SKILL.md`. */
export const LibraryRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(isLibraryRelativePath, { message: 'a path inside the library' });

/** One file or folder name, never a path: e.g. a file added to a skill. */
export const FileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !name.includes('/') && isLibraryRelativePath(name), { message: 'a file name' });
