// Creating a library (PLAN.md §3.17 "Admin: setting up a new library"): the repo must be empty, apart from the files
// hosts offer when a repo is created (a README, a LICENSE, a .gitignore), which are kept. The first commit holds
// library.yaml, .gitattributes and .gitignore (PLAN.md §3.0); an existing .gitignore gets the app's entries appended.
import { LIBRARY_FILE, LIBRARY_FORMAT, writeLibraryYaml } from '@app/schemas';

export interface RootEntry {
  readonly name: string;
  readonly kind: 'file' | 'dir' | 'other';
}

export type EmptyCheck =
  | { readonly kind: 'empty'; readonly kept: readonly string[] }
  /** library.yaml is there: someone set the library up already, so joining is offered. */
  | { readonly kind: 'setUp' }
  | { readonly kind: 'notEmpty'; readonly examples: readonly string[] };

const ALLOWED = [/^readme(\.[^.]+)?$/i, /^licen[cs]e(\.[^.]+)?$/i, /^\.gitignore$/];

/** Whether a repo whose top folder holds these entries counts as empty for a new library. */
export function checkEmptyRepo(root: readonly RootEntry[]): EmptyCheck {
  if (root.some((entry) => entry.name === LIBRARY_FILE)) return { kind: 'setUp' };
  const kept: string[] = [];
  const other: string[] = [];
  for (const entry of root) {
    if (entry.kind === 'file' && ALLOWED.some((pattern) => pattern.test(entry.name))) kept.push(entry.name);
    else other.push(entry.name);
  }
  return other.length === 0 ? { kind: 'empty', kept } : { kind: 'notEmpty', examples: other.slice(0, 5) };
}

/** Line endings (PLAN.md §3.0, A4.16): LF in the repo and on every OS, except Windows batch files, which need CRLF. */
export const GITATTRIBUTES = '* text=auto eol=lf\n*.bat text eol=crlf\n*.cmd text eol=crlf\n';

/** Runtime junk that scripts in skills leave behind (PLAN.md §3.0). */
export const GITIGNORE_ENTRIES = ['node_modules/', '__pycache__/', '.venv/', '.DS_Store', 'Thumbs.db'] as const;

/** The .gitignore to commit: the app's entries, appended to an existing file's own lines when they're missing. */
export function mergeGitignore(existing: string | null): string {
  if (existing === null) return `${GITIGNORE_ENTRIES.join('\n')}\n`;
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return existing;
  const base = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
  return `${base}${base === '' ? '' : '\n'}${missing.join('\n')}\n`;
}

export interface NewLibraryFiles {
  readonly [path: string]: string;
}

/** The files of the first commit. */
export function newLibraryFiles(input: {
  readonly id: string;
  readonly prefix: string;
  readonly existingGitignore: string | null;
}): NewLibraryFiles {
  return {
    [LIBRARY_FILE]: writeLibraryYaml({ id: input.id, prefix: input.prefix, format: LIBRARY_FORMAT }),
    '.gitattributes': GITATTRIBUTES,
    '.gitignore': mergeGitignore(input.existingGitignore),
  };
}

export const FIRST_COMMIT_MESSAGE = 'Set up the library';
