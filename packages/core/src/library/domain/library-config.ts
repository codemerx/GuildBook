// What library.yaml says, and whether this app can work with it (PLAN.md §3.2). A library whose `format` is newer than
// this app knows, or whose `minAppVersion` is higher than this app's version, is reported: the app keeps showing it
// but stops pulling, pushing and changing links until it's updated (Steps 4, 5 and 11 act on this).
import { LIBRARY_FILE, LIBRARY_FORMAT, type LibraryYaml, prefixProblems, readLibraryYaml } from '@app/schemas';
import { type Issue, issue } from './issues.ts';
import { compareVersions } from './versions.ts';

export type Compatibility = 'ok' | 'formatTooNew' | 'appTooOld' | 'unknown';

export interface LibraryConfig {
  /** What could be read. A field that failed its check is left out. */
  readonly value: Partial<LibraryYaml>;
  /** The git prefix, when library.yaml has a valid one. */
  readonly prefix: string | null;
  readonly compatibility: Compatibility;
  readonly issues: readonly Issue[];
}

/** Reads library.yaml's text (null when the file is missing) for an app of the given version. */
export function readLibraryConfig(text: string | null, appVersion: string): LibraryConfig {
  if (text === null) {
    return {
      value: {},
      prefix: null,
      compatibility: 'unknown',
      issues: [issue('library.configMissing', LIBRARY_FILE)],
    };
  }
  const read = readLibraryYaml(text);
  const issues: Issue[] = [];
  for (const problem of read.problems) {
    // A missing or bad prefix means the library isn't set up (PLAN.md §3.2), checked below.
    if (problem !== 'library.prefixMissing') issues.push(issue(problem, LIBRARY_FILE));
  }
  const format = read.value.format;
  const minAppVersion = read.value.minAppVersion;
  let compatibility: Compatibility = format === undefined ? 'unknown' : 'ok';
  if (format !== undefined && format > LIBRARY_FORMAT) {
    compatibility = 'formatTooNew';
    issues.push(issue('library.formatTooNew', LIBRARY_FILE, { format, supported: LIBRARY_FORMAT }));
  } else if (minAppVersion !== undefined && compareVersions(appVersion, minAppVersion) < 0) {
    compatibility = 'appTooOld';
    issues.push(issue('library.appTooOld', LIBRARY_FILE, { minAppVersion, appVersion }));
  }
  const rawPrefix = read.value.prefix;
  const prefix = rawPrefix !== undefined && prefixProblems(rawPrefix).length === 0 ? rawPrefix : null;
  // An unreadable file is reported as such; "not set up" is about a readable file without a valid prefix.
  if (prefix === null && !read.problems.includes('library.configInvalid')) {
    issues.push(issue('library.notSetUp', LIBRARY_FILE));
  }
  return { value: read.value, prefix, compatibility, issues };
}
