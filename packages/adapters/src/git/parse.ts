// Readers of git's machine-readable output (IMPLEMENTATION.md §2.9): NUL-separated formats only, so no path needs
// unquoting and no message depends on the user's settings. Each reader takes git's raw output and returns the port's
// types; golden tests pin them (§6 "Git output differs between versions").
import type {
  BranchStatus,
  ChangeCode,
  Commit,
  ConflictKind,
  FileChange,
  FileChangeStatus,
  GitTreeEntry,
  MergeTreeConflict,
  MergeTreeResult,
  RemoteRefs,
  Stash,
  StatusEntry,
  TreeEntryKind,
} from '@app/core';

const fields = (text: string): string[] => {
  const parts = text.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
};

// ---- status --porcelain=v2 --branch -z --------------------------------------------------------------------------

const changeCodes: Record<string, ChangeCode> = {
  '.': 'unmodified',
  M: 'modified',
  T: 'typeChanged',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
};

const conflictKinds: Record<string, ConflictKind> = {
  DD: 'bothDeleted',
  AU: 'addedByUs',
  UD: 'deletedByThem',
  UA: 'addedByThem',
  DU: 'deletedByUs',
  AA: 'bothAdded',
  UU: 'bothModified',
};

function changeCode(char: string | undefined): ChangeCode {
  return changeCodes[char ?? '.'] ?? 'modified';
}

/** Splits off the first `count` space-separated fields of a record; the rest (a path) may contain spaces. */
function splitFields(record: string, count: number): { head: string[]; rest: string } {
  const head: string[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const space = record.indexOf(' ', at);
    if (space < 0) throw new Error(`git status: malformed record "${record}"`);
    head.push(record.slice(at, space));
    at = space + 1;
  }
  return { head, rest: record.slice(at) };
}

export interface ParsedStatus extends BranchStatus {
  readonly entries: StatusEntry[];
}

export function parseStatus(output: string): ParsedStatus {
  const records = fields(output);
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: StatusEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    if (record.startsWith('# ')) {
      const [, key, ...values] = record.split(' ');
      const value = values.join(' ');
      if (key === 'branch.oid') head = value === '(initial)' ? null : value;
      else if (key === 'branch.head') branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        ahead = Number(match?.[1] ?? 0);
        behind = Number(match?.[2] ?? 0);
      }
      continue;
    }
    const type = record[0];
    if (type === '1') {
      const { head: f, rest } = splitFields(record, 8);
      const xy = f[1] ?? '..';
      entries.push({ kind: 'changed', path: rest, from: null, staged: changeCode(xy[0]), unstaged: changeCode(xy[1]) });
    } else if (type === '2') {
      const { head: f, rest } = splitFields(record, 9);
      const xy = f[1] ?? '..';
      // The original path is the next NUL-separated field.
      const from = records[++i] ?? null;
      entries.push({ kind: 'changed', path: rest, from, staged: changeCode(xy[0]), unstaged: changeCode(xy[1]) });
    } else if (type === 'u') {
      const { head: f, rest } = splitFields(record, 10);
      entries.push({ kind: 'conflicted', path: rest, conflict: conflictKinds[f[1] ?? 'UU'] ?? 'bothModified' });
    } else if (type === '?') {
      entries.push({ kind: 'untracked', path: record.slice(2) });
    }
    // `!` (ignored) records aren't requested.
  }
  return { branch, head, upstream, ahead, behind, entries };
}

// ---- log ---------------------------------------------------------------------------------------------------------

/** One commit: id, parents, author, its date, committer, its date, the message; each field ends with NUL. */
export const LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B%x00';
const LOG_FIELDS = 9;

export function parseLog(output: string): Commit[] {
  // `-z` puts one more NUL between commits.
  const parts = output.split('\0');
  const commits: Commit[] = [];
  let i = 0;
  while (i + LOG_FIELDS <= parts.length) {
    // Skip the separator NUL between commits; a commit starts with its (never empty) id.
    while (i < parts.length && parts[i] === '') i++;
    if (i + LOG_FIELDS > parts.length) break;
    const [id, parents, an, ae, at, cn, ce, ct, message] = parts.slice(i, i + LOG_FIELDS) as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    i += LOG_FIELDS;
    const body = message.replace(/\n+$/, '');
    commits.push({
      id,
      parents: parents === '' ? [] : parents.split(' '),
      author: { name: an, email: ae },
      authorDate: Number(at) * 1000,
      committer: { name: cn, email: ce },
      commitDate: Number(ct) * 1000,
      subject: body.split('\n', 1)[0] ?? '',
      message: body,
    });
  }
  return commits;
}

// ---- diff --name-status -M -z ------------------------------------------------------------------------------------

const fileStatuses: Record<string, FileChangeStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typeChanged',
};

export function parseNameStatus(output: string): FileChange[] {
  const parts = fields(output);
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++] ?? '';
    const status = fileStatuses[code[0] ?? ''];
    if (!status) continue;
    if (status === 'renamed' || status === 'copied') {
      const from = parts[i++] ?? '';
      const path = parts[i++] ?? '';
      const similarity = Number.parseInt(code.slice(1), 10);
      changes.push({ status, path, from, similarity: Number.isNaN(similarity) ? null : similarity });
    } else {
      changes.push({ status, path: parts[i++] ?? '', from: null, similarity: null });
    }
  }
  return changes;
}

// ---- ls-tree -r -t -z -l -------------------------------------------------------------------------------------------

export function treeEntryKind(mode: string): TreeEntryKind | undefined {
  switch (mode) {
    case '040000':
      return 'dir';
    case '100644':
    case '100664':
      return 'file';
    case '100755':
      return 'executable';
    case '120000':
      return 'link';
    case '160000':
      return 'submodule';
    default:
      return undefined;
  }
}

export function parseLsTree(output: string): GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  for (const record of fields(output)) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode = '', , oid = '', size = '-'] = record.slice(0, tab).split(/ +/);
    const kind = treeEntryKind(mode);
    if (!kind) continue;
    entries.push({ path: record.slice(tab + 1), kind, oid, size: size === '-' ? 0 : Number(size) });
  }
  return entries;
}

// ---- merge-tree --write-tree -z -----------------------------------------------------------------------------------

export function parseMergeTree(output: string, exitCode: number): MergeTreeResult {
  const parts = output.split('\0');
  const tree = parts[0] ?? '';
  if (exitCode === 0) return { tree, clean: true, conflicts: [] };
  // Conflicted file info (`<mode> <oid> <stage>\t<path>`) up to an empty field, then the informational messages:
  // `<count>`, that many paths, the type, the message.
  const conflicted: string[] = [];
  let i = 1;
  for (; i < parts.length && parts[i] !== ''; i++) {
    const record = parts[i] ?? '';
    const tab = record.indexOf('\t');
    const path = tab < 0 ? record : record.slice(tab + 1);
    if (!conflicted.includes(path)) conflicted.push(path);
  }
  const types = new Map<string, string>();
  for (i++; i < parts.length;) {
    const count = Number.parseInt(parts[i++] ?? '', 10);
    if (Number.isNaN(count)) break;
    const paths = parts.slice(i, i + count);
    i += count;
    const type = parts[i++] ?? '';
    i++; // the message
    if (!type.startsWith('CONFLICT')) continue;
    for (const path of paths) if (!types.has(path)) types.set(path, type);
  }
  // A conflict without a stage (e.g. a rename/rename to the same name) still has its message.
  for (const path of types.keys()) if (!conflicted.includes(path)) conflicted.push(path);
  const conflicts: MergeTreeConflict[] = conflicted.map((path) => ({ path, type: types.get(path) ?? 'CONFLICT' }));
  return { tree, clean: false, conflicts };
}

// ---- worktree list --porcelain -z ---------------------------------------------------------------------------------

export function parseWorktrees(output: string): Array<{ path: string; branch: string | null }> {
  const worktrees: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | undefined;
  for (const field of output.split('\0')) {
    if (field === '') {
      if (current) worktrees.push(current);
      current = undefined;
    } else if (field.startsWith('worktree ')) {
      current = { path: field.slice('worktree '.length), branch: null };
    } else if (field.startsWith('branch ') && current) {
      current.branch = field.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

// ---- ls-remote --symref -------------------------------------------------------------------------------------------

export function parseLsRemote(output: string): RemoteRefs {
  let head: string | null = null;
  const branches: Array<{ name: string; head: string }> = [];
  for (const line of output.split('\n')) {
    const symref = /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line);
    if (symref) {
      head = symref[1] ?? null;
      continue;
    }
    const ref = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/.exec(line);
    if (ref) branches.push({ name: ref[2] ?? '', head: ref[1] ?? '' });
  }
  return { head, branches };
}

// ---- fetch --porcelain, push --porcelain --------------------------------------------------------------------------

/** The remote-tracking refs a fetch moved, e.g. `origin/main`. */
export function parseFetch(output: string): string[] {
  const updated: string[] = [];
  for (const line of output.split('\n')) {
    const match = /^([ +*t-]) [0-9a-f]+ [0-9a-f]+ refs\/remotes\/(.+)$/.exec(line);
    if (match?.[2] && match[1] !== '-') updated.push(match[2]);
  }
  return updated;
}

export interface PushedRef {
  readonly flag: string;
  readonly from: string;
  readonly to: string;
  readonly summary: string;
}

export function parsePush(output: string): PushedRef[] {
  const refs: PushedRef[] = [];
  for (const line of output.split('\n')) {
    const match = /^([ +\-*!=])\t([^:\t]*):([^\t]+)\t(.*)$/.exec(line);
    if (match) refs.push({ flag: match[1] ?? '', from: match[2] ?? '', to: match[3] ?? '', summary: match[4] ?? '' });
  }
  return refs;
}

// ---- stash list, for-each-ref -------------------------------------------------------------------------------------

export const STASH_FORMAT = '%H%x00%gd%x00%gs';

export function parseStashList(output: string): Stash[] {
  const parts = fields(output);
  const stashes: Stash[] = [];
  for (let i = 0; i + 3 <= parts.length; i += 3) {
    const index = /^stash@\{(\d+)\}$/.exec(parts[i + 1] ?? '');
    if (!index) continue;
    stashes.push({ id: parts[i] ?? '', index: Number(index[1]), message: parts[i + 2] ?? '' });
  }
  return stashes;
}

export const BRANCH_FORMAT = '%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(symref)';

export interface RefRecord {
  readonly ref: string;
  readonly head: string;
  readonly current: boolean;
  readonly upstream: string | null;
  readonly symbolic: boolean;
}

export function parseRefs(output: string): RefRecord[] {
  return output
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [ref = '', head = '', current = '', upstream = '', symref = ''] = line.split('\0');
      return {
        ref,
        head,
        current: current === '*',
        upstream: upstream === '' ? null : upstream,
        symbolic: symref !== '',
      };
    });
}

// ---- progress -----------------------------------------------------------------------------------------------------

/** git's progress lines (`Receiving objects:  45% (9/20)`), as written to stderr with `--progress`. */
export function parseProgress(chunk: string): Array<{ phase: string; percent: number | null }> {
  const out: Array<{ phase: string; percent: number | null }> = [];
  for (const line of chunk.split(/[\r\n]+/)) {
    const match = /^(?:remote: )?([A-Za-z][A-Za-z ]*?):\s+(\d{1,3})%/.exec(line.trim());
    if (match?.[1]) out.push({ phase: match[1], percent: Number(match[2]) });
  }
  return out;
}
