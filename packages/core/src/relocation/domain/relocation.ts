// Relocation's pure parts (PLAN.md §3.9, IMPLEMENTATION.md §2.6): the durable operation's steps and what they leave in
// the journal, the pre-flight problems besides the location check's, the changes an agent made in the old folder while
// it was copied (carried over at cleanup), and the summary the user sees.
import type { LocationProblem } from '../../onboarding/index.ts';

export const RELOCATION_OPERATION = 'relocation';

/**
 * The steps after the pre-flight check and the pause (PLAN.md §3.9 steps 3–7). The pause isn't a step: every step
 * pauses first, so a step resumed after a crash runs paused too.
 */
export const relocationSteps = ['move', 'pointer', 'rewrite', 'save', 'cleanup'] as const;
export type RelocationStep = (typeof relocationSteps)[number];

/**
 * - `rename`: the same disk, one atomic rename and a temporary pointer at the old place
 * - `copy`: another disk (or a rename Windows refused): copy, verify, rename the copy, and keep the old folder until
 *   the end
 * - `locate`: S9 [Locate folder…], the folder is at its new place already: only the links and the location change
 */
export type RelocationMethod = 'rename' | 'copy' | 'locate';

export type RelocationParams = {
  readonly from: string;
  readonly to: string;
  readonly method: RelocationMethod;
};

/** One link or owned file rewritten to the new place, with the tools that read it. */
export type RewrittenConnection = {
  readonly path: string;
  readonly tools: string[];
};

/** What the steps leave for the later ones and for the summary, kept in the journal. */
export type RelocationState = {
  /** How the move step moved it: a rename that crossed disks after all was a copy. Empty until it ran. */
  readonly moved: RelocationMethod | '';
  /** The library's files, without git's own folder. */
  readonly files: number;
  readonly connections: RewrittenConnection[];
  /** Links that weren't the app's or no longer pointed at the old place: left alone and reported (PLAN.md §3.8). */
  readonly skipped: string[];
  /** Files an agent changed in the old folder during the copy, copied over at cleanup (library paths). */
  readonly carried: string[];
  /** Files changed in both places during the copy: the new place keeps its version, the old one goes to the trash. */
  readonly keptBoth: string[];
};

export function initialRelocationState(): RelocationState {
  return { moved: '', files: 0, connections: [], skipped: [], carried: [], keptBoth: [] };
}

/** The problems relocation adds to the location check (PLAN.md §3.9 step 0). */
export type RelocationProblem =
  | LocationProblem
  /** The new location is the folder the library is in now. */
  | { readonly code: 'relocation.same' }
  /** A pull, a push, or an unfinished merge or rebase: the move waits until it ends. */
  | { readonly code: 'relocation.gitBusy'; readonly operation: string };

/** Fingerprints by path inside a folder, with forward slashes: a file's bytes, or a link's target. */
export type Manifest = Readonly<Record<string, string>>;

export interface CarryOver {
  /** Changed or added in the old folder only: copied to the new place. */
  readonly copy: readonly string[];
  /** Deleted in the old folder only: deleted in the new place too. */
  readonly remove: readonly string[];
  /** Changed in both places, differently: the new place keeps its version. */
  readonly keepBoth: readonly string[];
}

/**
 * PLAN.md §3.9 step 7: the old folder kept serving the links during a copy to another disk, so an agent may have
 * changed a file through a link that wasn't rewritten yet. `base` is what was copied, `old` and `now` what each place
 * holds at cleanup.
 */
export function carryOver(base: Manifest, old: Manifest, now: Manifest): CarryOver {
  const copy: string[] = [];
  const remove: string[] = [];
  const keepBoth: string[] = [];
  const all = [...new Set([...Object.keys(base), ...Object.keys(old)])].sort();
  for (const path of all) {
    const before = base[path];
    const there = old[path];
    if (there === before) continue;
    const here = now[path];
    if (here === there) continue;
    if (here !== before) keepBoth.push(path);
    else if (there === undefined) remove.push(path);
    else copy.push(path);
  }
  return { copy, remove, keepBoth };
}

/** The paths of a manifest that are git's own: they move with the folder, but aren't the library's files. */
export function isGitPath(path: string): boolean {
  return path === '.git' || path.startsWith('.git/');
}

export interface RelocationSummary {
  readonly from: string;
  readonly to: string;
  readonly method: RelocationMethod;
  readonly files: number;
  readonly connections: number;
  /** The connections by the tools that read them, e.g. Claude Code ×3 (PLAN.md §3.9 "What the user sees"). */
  readonly groups: ReadonlyArray<{ readonly tools: readonly string[]; readonly count: number }>;
  readonly skipped: readonly string[];
  readonly carried: readonly string[];
  readonly keptBoth: readonly string[];
}

export function summarize(params: RelocationParams, state: RelocationState): RelocationSummary {
  const groups = new Map<string, { tools: readonly string[]; count: number }>();
  for (const connection of state.connections) {
    const key = connection.tools.join('\u0000');
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { tools: connection.tools, count: 1 });
  }
  return {
    from: params.from,
    to: params.to,
    method: state.moved === '' ? params.method : state.moved,
    files: state.files,
    connections: state.connections.length,
    groups: [...groups.values()].sort((a, b) => b.count - a.count || (a.tools.join('/') < b.tools.join('/') ? -1 : 1)),
    skipped: state.skipped,
    carried: state.carried,
    keptBoth: state.keptBoth,
  };
}
