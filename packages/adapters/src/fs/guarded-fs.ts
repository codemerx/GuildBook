// The guarded file system (IMPLEMENTATION.md §2.10, ADR 0017): the only FileSystem core receives. It enforces the
// safety and privacy rules at one place:
// - writes only under the allowed write roots (and, in test mode, never outside the test root)
// - reads only under the allowed read roots
// - removing a whole tree only under the roots allowed for it, never through a link
// Paths are checked lexically and then by their real location, so a link inside an allowed root can't lead a write
// outside it. In test mode every read is recorded in the audit log (TESTING.md §9.4).
// The live exception (ADR 0033) lets test mode reach entries named `aisstest-*` in one real tool folder, nothing else.
import {
  type AbsPath,
  AppError,
  type Entry,
  type FileSystem,
  type Links,
  type PathFlavour,
  type WriteOptions,
} from '@app/core';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface GuardRoots {
  /** Where writes may go: e.g. the data folder and the library (Step 1); approved plan paths later. */
  readonly write: readonly string[];
  /** Where reads may go: the write roots plus what PLAN.md §3.7 allows. */
  readonly read: readonly string[];
  /** Where a whole tree may be removed: the data folder. */
  readonly removeTree: readonly string[];
  /**
   * Entries in folders the app doesn't own, with what's below them: the exact paths of an approved plan, such as a
   * skill link in a tool folder (IMPLEMENTATION.md §2.10). The entry itself is never resolved, so a link there is
   * removed, replaced or read as a link, and nothing is ever written through another program's link.
   */
  readonly entries?: { readonly write: readonly string[]; readonly read: readonly string[] };
  /** Single paths whose existence may be checked, and that may be created as a folder: tool and link folders. */
  readonly exact?: readonly string[];
  /**
   * Single folders whose names may be listed, and nothing below them: parent folders of code repos and link folders
   * (PLAN.md §3.7 rules 3 and 4). Core keeps only the names it may use.
   */
  readonly lists?: readonly string[];
  /**
   * Single folders the app made for its links in code repos (PLAN.md §3.6 "Worktrees"): their existence may be checked,
   * and each may be removed again while it's empty. Nothing below them is allowed by this.
   */
  readonly made?: readonly string[];
}

export interface AuditEntry {
  readonly op: 'lstat' | 'list' | 'read' | 'readLink';
  readonly path: string;
}

export interface GuardOptions {
  readonly inner: FileSystem;
  readonly paths: PathFlavour;
  /** Called for every check, so the roots can change as instances are added (e.g. a new library folder). */
  readonly roots: () => GuardRoots;
  /** Test mode: nothing outside it, ever (TESTING.md §3). */
  readonly testRoot?: string;
  /** Test mode: every read, for the privacy suites. */
  readonly audit?: (entry: AuditEntry) => void;
  /**
   * The live exception (ADR 0033), test mode only: the real home folder of a tool, e.g. `~/.claude`. Inside its `skills`
   * folder the guard reaches `aisstest-*` entries, at most `LIVE_CAP` at one time. Everything else stays refused.
   */
  readonly liveToolHome?: string;
}

const NONE: readonly string[] = [];

/**
 * What the live exception reaches in the real skills folder (ADR 0033): names that start with `aisstest`, then up to
 * eight letters, then a dash. A library's prefix is 3 to 16 letters (PLAN.md §3.2), so a scenario that changes the
 * prefix, or chooses a local prefix, can use `aisstestb-hello` and still stay inside our names.
 */
export const LIVE_PREFIX = 'aisstest';
/** At most this many live entries exist in the real skills folder at one time (ADR 0033). */
export const LIVE_CAP = 10;

const LIVE_NAME = /^aisstest[a-z]{0,8}-/;

/** Whether a name in the real skills folder is ours: `aisstest[letters]-*`, or the temporary link of a replacement. */
export function isLiveName(name: string): boolean {
  return LIVE_NAME.test(name) || (name.startsWith('.') && name.endsWith('.new') && LIVE_NAME.test(name.slice(1)));
}

/** A whole entry of ours, not the temporary link made while one is replaced. */
export function isLiveEntry(name: string): boolean {
  return LIVE_NAME.test(name);
}

/**
 * Whether the live exception allows `op` on `candidate`: the tool's home folder only for an existence check, its
 * `skills` folder for an existence check, a listing and creating, and below it only the entries `isLiveName` accepts.
 * `candidate` and `toolHome` are normalized and both lexical, or both real.
 */
export function liveAllows(paths: PathFlavour, toolHome: string, op: string, candidate: string): boolean {
  if (paths.same(toolHome, candidate)) return op === 'lstat';
  const rest = paths.relative(paths.join(toolHome, 'skills'), candidate);
  if (rest === undefined) return false;
  if (rest === '') return op === 'lstat' || op === 'list' || op === 'mkdir';
  const first = rest.split(/[\\/]/)[0] ?? '';
  return isLiveName(first);
}

type Op =
  'read' | 'list' | 'lstat' | 'write' | 'mkdir' | 'rename' | 'remove' | 'removeEmptyFolder' | 'removeTree' | 'copy';

/** For these the last part is the entry itself: only its folder is resolved. */
const ENTRY_OPS = new Set<Op>(['lstat', 'remove', 'removeEmptyFolder', 'rename', 'removeTree']);

export class GuardedFileSystem implements FileSystem {
  readonly #inner: FileSystem;
  readonly #paths: PathFlavour;
  readonly #roots: () => GuardRoots;
  readonly #testRoot: string | undefined;
  readonly #audit: ((entry: AuditEntry) => void) | undefined;
  readonly #liveToolHome: string | undefined;

  constructor(options: GuardOptions) {
    if (options.liveToolHome !== undefined) {
      if (options.testRoot === undefined) throw new Error('the live exception needs test mode');
      if (!options.paths.isAbsolute(options.liveToolHome)) throw new Error('the live tool home must be absolute');
    }
    this.#liveToolHome = options.liveToolHome === undefined ? undefined : options.paths.normalize(options.liveToolHome);
    this.#inner = options.inner;
    this.#paths = options.paths;
    this.#roots = options.roots;
    this.#testRoot = options.testRoot;
    this.#audit = options.audit;
  }

  async lstat(target: AbsPath): Promise<Entry | undefined> {
    await this.#check('lstat', target, 'read');
    this.#audit?.({ op: 'lstat', path: target });
    return this.#inner.lstat(target);
  }

  async list(dir: AbsPath): Promise<string[]> {
    await this.#check('list', dir, 'read');
    this.#audit?.({ op: 'list', path: dir });
    return this.#inner.list(dir);
  }

  async readText(target: AbsPath): Promise<string> {
    await this.#check('read', target, 'read');
    this.#audit?.({ op: 'read', path: target });
    return this.#inner.readText(target);
  }

  async readBytes(target: AbsPath): Promise<Uint8Array> {
    await this.#check('read', target, 'read');
    this.#audit?.({ op: 'read', path: target });
    return this.#inner.readBytes(target);
  }

  async readLink(target: AbsPath): Promise<string> {
    // The link itself is read, never what it points to: only its folder must be inside the read roots.
    await this.#check('lstat', target, 'read');
    this.#audit?.({ op: 'readLink', path: target });
    return this.#inner.readLink(target);
  }

  async writeTextAtomic(target: AbsPath, text: string): Promise<void> {
    await this.#check('write', target, 'write');
    return this.#inner.writeTextAtomic(target, text);
  }

  async writeBytesAtomic(target: AbsPath, bytes: Uint8Array, options?: WriteOptions): Promise<void> {
    await this.#check('write', target, 'write');
    return this.#inner.writeBytesAtomic(target, bytes, options);
  }

  async mkdirp(dir: AbsPath): Promise<void> {
    await this.#check('mkdir', dir, 'write');
    return this.#inner.mkdirp(dir);
  }

  async rename(from: AbsPath, to: AbsPath): Promise<void> {
    await this.#check('rename', from, 'write');
    await this.#check('rename', to, 'write');
    return this.#inner.rename(from, to);
  }

  async remove(target: AbsPath): Promise<void> {
    await this.#check('remove', target, 'write');
    return this.#inner.remove(target);
  }

  async removeEmptyFolder(dir: AbsPath): Promise<boolean> {
    await this.#check('removeEmptyFolder', dir, 'write');
    return this.#inner.removeEmptyFolder(dir);
  }

  async removeTree(dir: AbsPath): Promise<void> {
    await this.#check('removeTree', dir, 'removeTree');
    // Never delete recursively through a link: the link itself goes, never what it points to (ADR 0017).
    const entry = await this.#inner.lstat(dir);
    if (entry?.kind === 'link') throw new AppError('fs.throughLink', { path: dir, op: 'removeTree' });
    return this.#inner.removeTree(dir);
  }

  async copyFile(from: AbsPath, to: AbsPath): Promise<void> {
    await this.#check('read', from, 'read');
    this.#audit?.({ op: 'read', path: from });
    await this.#check('copy', to, 'write');
    return this.#inner.copyFile(from, to);
  }

  /** The Links port behind the same guard: a link is created, replaced or removed only where a write may go. */
  links(inner: Links): Links {
    return {
      create: async (target, link) => {
        await this.#check('rename', link, 'write');
        return inner.create(target, link);
      },
      readTarget: async (link) => {
        await this.#check('lstat', link, 'read');
        this.#audit?.({ op: 'readLink', path: link });
        return inner.readTarget(link);
      },
      retarget: async (link, newTarget) => {
        await this.#check('rename', link, 'write');
        return inner.retarget(link, newTarget);
      },
      remove: async (link) => {
        await this.#check('remove', link, 'write');
        return inner.remove(link);
      },
    };
  }

  /** Paths as the OS compares them: case-insensitively on Windows. */
  #key(path: string): string {
    return this.#keyOfNormal(this.#paths.normalize(path));
  }

  /** The key of a path that is normalized already: e.g. a folder of a normalized path (Step 17, A17.1). */
  #keyOfNormal(normalized: string): string {
    return this.#paths.name === 'win32' ? normalized.toLowerCase() : normalized;
  }

  /**
   * A list of paths as a lookup from key to path, made once per list: the link engine's lists hold every link path
   * of a library (27,000 in the `large` world), and every file operation is checked.
   */
  #lookup(list: readonly string[]): Map<string, string> {
    let map = this.#lookups.get(list);
    if (!map) {
      map = new Map(list.map((path) => [this.#key(path), this.#paths.normalize(path)]));
      this.#lookups.set(list, map);
    }
    return map;
  }

  readonly #lookups = new WeakMap<readonly string[], Map<string, string>>();

  /** The entry roots that hold `path` (normalized): the path itself or one of its folders, found by key, not a scan. */
  #entriesHolding(list: readonly string[], path: string): string[] {
    const lookup = this.#lookup(list);
    const found: string[] = [];
    let current = path;
    for (;;) {
      const hit = lookup.get(this.#keyOfNormal(current));
      if (hit !== undefined) found.push(hit);
      const parent = this.#paths.dirname(current);
      if (parent === current) return found;
      current = parent;
    }
  }

  async #check(op: Op, target: string, access: 'read' | 'write' | 'removeTree'): Promise<void> {
    const refuse = () => new AppError('fs.outsideAllowedRoots', { op, path: target });
    if (!this.#paths.isAbsolute(target)) throw refuse();
    const roots = this.#roots();
    const allowed = roots[access];
    const entries = access === 'removeTree' ? [] : (roots.entries?.[access] ?? []);
    const normalized = this.#paths.normalize(target);
    const inside = (list: readonly string[], candidate: string) =>
      list.some((root) => this.#paths.isInside(this.#paths.normalize(root), candidate));
    const live = this.#liveToolHome !== undefined && liveAllows(this.#paths, this.#liveToolHome, op, normalized);
    if (this.#testRoot !== undefined && !live && !inside([this.#testRoot], normalized)) throw refuse();
    const keepLast = ENTRY_OPS.has(op);
    // A single path: its existence, or creating it as a folder (a tool's or a link folder, PLAN.md §3.7 rule 3); a
    // folder the app made, removed again while it's empty (§3.6 "Worktrees").
    const key = this.#keyOfNormal(normalized);
    const made = this.#lookup(roots.made ?? NONE).has(key);
    const exact =
      ((op === 'lstat' || op === 'mkdir') && (made || this.#lookup(roots.exact ?? NONE).has(key))) ||
      (op === 'list' && this.#lookup(roots.lists ?? NONE).has(key)) ||
      (op === 'removeEmptyFolder' && made);
    const holdingAllowed = allowed.filter((root) => this.#paths.isInside(this.#paths.normalize(root), normalized));
    const holdingEntries = this.#entriesHolding(entries, normalized);
    if (!exact && holdingAllowed.length === 0 && holdingEntries.length === 0) throw refuse();
    // The real location must be inside too: a link inside an allowed root mustn't lead outside it. For lstat and
    // removal the last part is the entry itself, so only its folder is resolved. Entry roots are never resolved
    // themselves: what a link there points to isn't allowed by it. The roots that hold the path come first; the
    // others only when those don't hold its real location.
    const real = await realLocation(normalized, keepLast || exact);
    // A root that is the entry itself (e.g. relocation's pointer, a link at the library's old place) is taken as an
    // entry too: its own link isn't followed when the link itself is removed or read.
    const rootAt = (root: string) =>
      realLocation(this.#paths.normalize(root), keepLast && this.#paths.same(this.#paths.normalize(root), normalized));
    const realRootsOf = async (rootsAllowed: readonly string[], rootsEntries: readonly string[]) => [
      ...(await Promise.all(rootsAllowed.map(rootAt))),
      ...(await Promise.all(rootsEntries.map((root) => realLocation(this.#paths.normalize(root), true)))),
      ...(exact ? [await realLocation(normalized, true)] : []),
    ];
    if (!inside(await realRootsOf(holdingAllowed, holdingEntries), real)) {
      if (!inside(await realRootsOf(allowed, entries), real)) throw refuse();
    }
    if (this.#testRoot !== undefined && !inside([await realLocation(this.#testRoot, false)], real)) {
      if (!(await this.#liveRealAllows(op, real))) throw refuse();
    }
    if (live) await this.#checkLiveCap(op, normalized, refuse);
  }

  /** The live exception for a real location: the tool home may be a link, so both of its real forms count. */
  async #liveRealAllows(op: Op, real: string): Promise<boolean> {
    const home = this.#liveToolHome;
    if (home === undefined) return false;
    const reals = new Set([await realLocation(home, false), await realLocation(home, true)]);
    return [...reals].some((realHome) => liveAllows(this.#paths, this.#paths.normalize(realHome), op, real));
  }

  /** A new live entry is refused when `LIVE_CAP` of them exist already (ADR 0033). */
  async #checkLiveCap(op: Op, target: string, refuse: () => AppError): Promise<void> {
    const home = this.#liveToolHome;
    if (home === undefined || !(op === 'write' || op === 'mkdir' || op === 'rename' || op === 'copy')) return;
    const skills = this.#paths.join(home, 'skills');
    const name = this.#paths.relative(skills, target);
    // Only the entry itself counts, not what is below it, and not the temporary link of a replacement.
    if (name === undefined || name === '' || /[\\/]/.test(name) || !isLiveEntry(name)) return;
    if (await this.#inner.lstat(target as AbsPath)) return;
    const existing = (await this.#inner.list(skills as AbsPath)).filter(isLiveEntry);
    if (existing.length >= LIVE_CAP) throw refuse();
  }
}

/** The real path of `target`: its deepest existing ancestor resolved through links, plus the rest. */
async function realLocation(target: string, keepLast: boolean): Promise<string> {
  const tail: string[] = [];
  let current = keepLast ? path.dirname(target) : target;
  if (keepLast) tail.unshift(path.basename(target));
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}
