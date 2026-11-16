// The exclude entries in code repos (PLAN.md §3.6): one line in the repo's `.git/info/exclude` for each link the app
// makes there, so its links never show in `git status`, in the main checkout or in any worktree. A reconciler like the
// skill links' (IMPLEMENTATION.md §2.5): the registry keeps each entry, keyed by the file and the line.
// - The file is shared: by the repo's worktrees, and by every instance that links into the repo. So each change is one
//   read-modify-write under a device-wide lock (IMPLEMENTATION.md §2.13 rule 8), and only the app's own line changes.
// - A line that was in the file before the app added it is the user's: removing the app's entry then leaves it.
import { EXCLUDE_ENTRY_KIND, type ExcludeEntryRow, ExcludeEntryRowSchema } from '@app/schemas';
import type { PlanBody, Reconciler } from '../../engine/index.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { RegistryRecord } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import { addLine, hasLine, removeLine } from '../domain/exclude-file.ts';

export interface ExcludeEntry {
  readonly file: string;
  readonly line: string;
  readonly repo: string;
}

export interface ExcludeInputs {
  readonly entries: readonly ExcludeEntry[];
}

export interface ExcludeObserved {
  readonly key: string;
  readonly file: string;
  readonly line: string;
  readonly present: boolean;
  readonly row: ExcludeEntryRow | null;
}

export type ExcludeAction =
  /** Writes the line (unless it's there), and records the entry. */
  | { readonly op: 'add'; readonly key: string; readonly file: string; readonly line: string; readonly repo: string }
  /** Records an entry whose line the file already has: the user's own, kept when the entry goes. */
  | { readonly op: 'adopt'; readonly key: string; readonly file: string; readonly line: string; readonly repo: string }
  /** Removes the app's line and the entry. */
  | { readonly op: 'remove'; readonly key: string; readonly file: string; readonly line: string }
  /** Forgets the entry, leaving the line: it was the user's before, or the file is gone. */
  | { readonly op: 'forget'; readonly key: string };

export interface ExcludeReconcilerDeps {
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  /** Runs `fn` holding the device-wide lock for one file. */
  readonly locked: <T>(file: string, fn: () => Promise<T>) => Promise<T>;
}

export const excludeKey = (file: string, line: string) => `${file}\n${line}`;

export function readExcludeRow(record: RegistryRecord | undefined): ExcludeEntryRow | null {
  if (!record) return null;
  const parsed = ExcludeEntryRowSchema.safeParse(record.data);
  return parsed.success ? parsed.data : null;
}

/** Pure: the plan between the wanted entries and what the files and the registry hold. */
export function planExcludes(
  desired: readonly ExcludeEntry[],
  observed: readonly ExcludeObserved[],
  phase: 'before' | 'all',
): PlanBody<ExcludeAction> {
  const seen = new Map(observed.map((o) => [o.key, o]));
  const wanted = new Set<string>();
  const actions: ExcludeAction[] = [];
  for (const entry of desired) {
    const key = excludeKey(entry.file, entry.line);
    if (wanted.has(key)) continue;
    wanted.add(key);
    const o = seen.get(key);
    if (o?.row) {
      // The user took our line out: it goes back, the entry is ours.
      if (!o.present) actions.push({ op: 'add', key, ...entry });
      continue;
    }
    actions.push(o?.present ? { op: 'adopt', key, ...entry } : { op: 'add', key, ...entry });
  }
  if (phase === 'all') {
    for (const o of observed) {
      if (wanted.has(o.key) || !o.row) continue;
      if (o.row.preexisting || !o.present) actions.push({ op: 'forget', key: o.key });
      else actions.push({ op: 'remove', key: o.key, file: o.file, line: o.line });
    }
  }
  actions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { actions, conflicts: [] };
}

/**
 * The reconciler. `before` plans only the entries that must exist before links are made; `all` plans the removals too.
 */
export function excludeReconciler(
  deps: ExcludeReconcilerDeps,
  phase: 'before' | 'all' = 'all',
): Reconciler<ExcludeInputs, ExcludeEntry, ExcludeObserved, ExcludeAction> {
  const { fs } = deps;
  const read = async (file: string): Promise<string | null> => {
    const entry = await fs.lstat(file as AbsPath);
    return entry?.kind === 'file' ? fs.readText(file as AbsPath) : null;
  };
  return {
    kind: EXCLUDE_ENTRY_KIND,

    desired(inputs) {
      return inputs.entries;
    },

    async observe(desired, registry) {
      const rows = new Map(registry.map((record) => [record.key, readExcludeRow(record)]));
      const keys = new Map<string, { file: string; line: string }>();
      for (const entry of desired) keys.set(excludeKey(entry.file, entry.line), entry);
      for (const [key, row] of rows) if (row && !keys.has(key)) keys.set(key, { file: row.file, line: row.line });
      const texts = new Map<string, string | null>();
      const observed: ExcludeObserved[] = [];
      for (const [key, { file, line }] of [...keys].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (!texts.has(file)) texts.set(file, await read(file));
        const text = texts.get(file) ?? null;
        observed.push({ key, file, line, present: text !== null && hasLine(text, line), row: rows.get(key) ?? null });
      }
      return observed;
    },

    plan(desired, observed) {
      return planExcludes(desired, observed, phase);
    },

    async apply(action) {
      if (action.op === 'adopt' || action.op === 'forget') return;
      const file = action.file as AbsPath;
      await deps.locked(action.file, async () => {
        const text = await read(action.file);
        if (action.op === 'add') {
          const next = addLine(text ?? '', action.line);
          if (next === text) return;
          const dir = deps.paths.dirname(action.file) as AbsPath;
          if (!(await fs.lstat(dir))) await fs.mkdirp(dir);
          await fs.writeTextAtomic(file, next);
        } else if (text !== null) {
          const next = removeLine(text, action.line);
          if (next !== text) await fs.writeTextAtomic(file, next);
        }
      });
    },

    record(action, registry, now) {
      if (action.op === 'remove' || action.op === 'forget') {
        registry.delete(EXCLUDE_ENTRY_KIND, action.key);
        return;
      }
      const before = readExcludeRow(registry.get(EXCLUDE_ENTRY_KIND, action.key));
      const row: ExcludeEntryRow = {
        file: action.file,
        line: action.line,
        repo: action.repo,
        preexisting: before?.preexisting ?? action.op === 'adopt',
        createdAt: before?.createdAt ?? now,
      };
      registry.put(EXCLUDE_ENTRY_KIND, action.key, row, now);
    },
  };
}
