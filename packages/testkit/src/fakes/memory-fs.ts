// An in-memory file system with links, in either path flavour, so Windows path rules run on every OS. It implements
// the FileSystem and Links ports; the contract suites keep it honest against the Node adapters (TESTING.md §2).
import {
  type AbsPath,
  AppError,
  type Entry,
  type FileSystem,
  type Links,
  type PathFlavour,
  posixPaths,
  type WriteOptions,
} from '@app/core';

type Node =
  | { kind: 'file'; name: string; data: Uint8Array; mtimeMs: number; mode: number }
  | { kind: 'dir'; name: string; mtimeMs: number }
  | { kind: 'link'; name: string; target: string; mtimeMs: number };

function osError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

export interface MemoryFsOptions {
  readonly paths?: PathFlavour;
  /** The time stamped on writes. */
  readonly now?: () => number;
}

export class MemoryFileSystem implements FileSystem {
  readonly paths: PathFlavour;
  readonly #nodes = new Map<string, Node>();
  readonly #now: () => number;
  /** Every path written, renamed onto or removed, for assertions. */
  readonly writes: string[] = [];
  /** Every file read and folder listed, for the privacy assertions (TESTING.md §9.4). */
  readonly reads: string[] = [];
  readonly #observers = new Set<(path: string, type: 'create' | 'update' | 'delete') => void>();

  constructor(options: MemoryFsOptions = {}) {
    this.paths = options.paths ?? posixPaths;
    this.#now = options.now ?? (() => 0);
  }

  /** Hears of every change, as a file watcher would: for the in-memory watcher (MemoryWatcher). */
  observe(listener: (path: string, type: 'create' | 'update' | 'delete') => void): () => void {
    this.#observers.add(listener);
    return () => this.#observers.delete(listener);
  }

  #changed(path: string, type: 'create' | 'update' | 'delete'): void {
    for (const listener of [...this.#observers]) listener(this.paths.normalize(path), type);
  }

  /** The stored paths below `dir` (on Windows paths, in lower case, as the keys are). */
  #pathsBelow(dir: string): string[] {
    const base = this.#key(dir);
    const prefix = base.endsWith(this.paths.sep) ? base : base + this.paths.sep;
    return [...this.#nodes.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => this.paths.join(dir, key.slice(prefix.length)));
  }

  #key(path: string): string {
    const normalized = this.paths.normalize(path);
    return this.paths.name === 'win32' ? normalized.toLowerCase() : normalized;
  }

  #isRoot(path: string): boolean {
    return this.paths.dirname(path) === this.paths.normalize(path);
  }

  #get(path: string): Node | undefined {
    if (this.#isRoot(path)) return { kind: 'dir', name: '', mtimeMs: 0 };
    return this.#nodes.get(this.#key(path));
  }

  /** Follows links in every segment; the last one too when `followLast` is set. */
  #resolve(path: string, followLast: boolean): string {
    if (!this.paths.isAbsolute(path)) throw new Error(`not absolute: ${path}`);
    let current = this.paths.normalize(path);
    for (let hops = 0; hops < 40; hops++) {
      const parts = this.#segments(current);
      let rebuilt = parts.root;
      let changed = false;
      for (let i = 0; i < parts.segments.length; i++) {
        const next = this.paths.join(rebuilt, parts.segments[i] ?? '');
        const node = this.#nodes.get(this.#key(next));
        const isLast = i === parts.segments.length - 1;
        if (node?.kind === 'link' && (!isLast || followLast)) {
          const target = this.paths.isAbsolute(node.target) ? node.target : this.paths.join(rebuilt, node.target);
          current = this.paths.join(target, ...parts.segments.slice(i + 1));
          changed = true;
          break;
        }
        rebuilt = next;
      }
      if (!changed) return current;
    }
    throw osError('ELOOP', path);
  }

  #segments(path: string): { root: string; segments: string[] } {
    const segments: string[] = [];
    let current = this.paths.normalize(path);
    while (!this.#isRoot(current)) {
      segments.unshift(this.paths.basename(current));
      current = this.paths.dirname(current);
    }
    return { root: current, segments };
  }

  #parentDir(path: string): string {
    const resolvedParent = this.#resolve(this.paths.dirname(path), true);
    const parent = this.#get(resolvedParent);
    if (!parent) throw new AppError('fs.notFound', { path: this.paths.dirname(path) });
    if (parent.kind !== 'dir') throw osError('ENOTDIR', path);
    return resolvedParent;
  }

  #children(dir: string): string[] {
    const prefix = this.#key(dir);
    const separator = this.paths.sep;
    const base = prefix.endsWith(separator) ? prefix : prefix + separator;
    return [...this.#nodes.keys()].filter((key) => key.startsWith(base) && !key.slice(base.length).includes(separator));
  }

  #descendants(dir: string): string[] {
    const prefix = this.#key(dir);
    const base = prefix.endsWith(this.paths.sep) ? prefix : prefix + this.paths.sep;
    return [...this.#nodes.keys()].filter((key) => key.startsWith(base));
  }

  async lstat(path: AbsPath): Promise<Entry | undefined> {
    let resolved: string;
    try {
      resolved = this.paths.join(this.#resolve(this.paths.dirname(path), true), this.paths.basename(path));
      if (this.#isRoot(path)) resolved = path;
    } catch {
      return undefined;
    }
    const node = this.#get(resolved);
    if (!node) return undefined;
    return {
      kind: node.kind,
      size: node.kind === 'file' ? node.data.length : node.kind === 'link' ? node.target.length : 0,
      mtimeMs: node.mtimeMs,
      mode: node.kind === 'file' ? node.mode : node.kind === 'dir' ? 0o755 : 0o777,
    };
  }

  async list(dir: AbsPath): Promise<string[]> {
    this.reads.push(dir);
    const resolved = this.#resolve(dir, true);
    const node = this.#get(resolved);
    if (!node) throw new AppError('fs.notFound', { path: dir });
    if (node.kind !== 'dir') throw osError('ENOTDIR', dir);
    return this.#children(resolved)
      .map((key) => this.#nodes.get(key)?.name ?? '')
      .sort();
  }

  async readBytes(path: AbsPath): Promise<Uint8Array> {
    this.reads.push(path);
    const node = this.#get(this.#resolve(path, true));
    if (!node) throw new AppError('fs.notFound', { path });
    if (node.kind !== 'file') throw osError('EISDIR', path);
    return node.data.slice();
  }

  async readLink(path: AbsPath): Promise<string> {
    const node = this.#get(this.paths.join(this.#parentDir(path), this.paths.basename(path)));
    if (!node) throw new AppError('fs.notFound', { path });
    if (node.kind !== 'link') throw osError('EINVAL', path);
    return node.target;
  }

  /** Sets a file's permission bits, e.g. the executable bit: for test setup. */
  chmod(path: string, mode: number): void {
    const key = this.#key(this.#resolve(path, true));
    const node = this.#nodes.get(key);
    if (node?.kind !== 'file') throw new AppError('fs.notFound', { path });
    this.#nodes.set(key, { ...node, mode });
    this.#changed(path, 'update');
  }

  async readText(path: AbsPath): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }

  async writeBytesAtomic(path: AbsPath, bytes: Uint8Array, options: WriteOptions = {}): Promise<void> {
    const parent = this.#parentDir(path);
    const target = this.paths.join(parent, this.paths.basename(path));
    const existing = this.#get(target);
    if (existing?.kind === 'dir') throw osError('EISDIR', path);
    // Like temp file + rename: a link at the path is replaced by the file, not written through.
    this.#nodes.set(this.#key(target), {
      kind: 'file',
      name: this.paths.basename(path),
      data: bytes.slice(),
      mtimeMs: this.#now(),
      mode: options.mode !== undefined ? options.mode & 0o777 : existing?.kind === 'file' ? existing.mode : 0o644,
    });
    this.writes.push(target);
    this.#changed(target, existing ? 'update' : 'create');
  }

  async writeTextAtomic(path: AbsPath, text: string): Promise<void> {
    await this.writeBytesAtomic(path, new TextEncoder().encode(text));
  }

  async mkdirp(dir: AbsPath): Promise<void> {
    const { root, segments } = this.#segments(dir);
    let current = root;
    for (const segment of segments) {
      current = this.#resolve(this.paths.join(current, segment), true);
      const node = this.#get(current);
      if (!node) {
        this.#nodes.set(this.#key(current), { kind: 'dir', name: segment, mtimeMs: this.#now() });
        this.writes.push(current);
        this.#changed(current, 'create');
      } else if (node.kind !== 'dir') {
        throw osError('ENOTDIR', current);
      }
    }
  }

  async rename(from: AbsPath, to: AbsPath): Promise<void> {
    const source = this.paths.join(this.#parentDir(from), this.paths.basename(from));
    const node = this.#get(source);
    if (!node) throw new AppError('fs.notFound', { path: from });
    const target = this.paths.join(this.#parentDir(to), this.paths.basename(to));
    if (this.#key(source) === this.#key(target)) return;
    const existing = this.#get(target);
    if (existing?.kind === 'dir' && this.#children(target).length > 0) throw osError('ENOTEMPTY', to);
    if (existing && (existing.kind === 'dir') !== (node.kind === 'dir'))
      throw osError(node.kind === 'dir' ? 'ENOTDIR' : 'EISDIR', to);
    const before = node.kind === 'dir' ? this.#pathsBelow(source) : [];
    const moved: Array<[string, Node]> = [[target, { ...node, name: this.paths.basename(to) }]];
    if (node.kind === 'dir') {
      for (const key of this.#descendants(source)) {
        const child = this.#nodes.get(key);
        if (child) moved.push([this.paths.join(target, key.slice(this.#key(source).length)), child]);
      }
    }
    for (const key of [this.#key(source), ...(node.kind === 'dir' ? this.#descendants(source) : [])])
      this.#nodes.delete(key);
    this.#nodes.delete(this.#key(target));
    for (const [path, moving] of moved) this.#nodes.set(this.#key(path), moving);
    this.writes.push(target);
    for (const path of [source, ...before]) this.#changed(path, 'delete');
    this.#changed(target, existing ? 'update' : 'create');
    for (const path of this.#pathsBelow(target)) this.#changed(path, 'create');
  }

  async remove(path: AbsPath): Promise<void> {
    const target = this.paths.join(this.#parentDir(path), this.paths.basename(path));
    const node = this.#get(target);
    if (!node) throw new AppError('fs.notFound', { path });
    if (node.kind === 'dir' && this.#children(target).length > 0) throw osError('ENOTEMPTY', path);
    this.#nodes.delete(this.#key(target));
    this.writes.push(target);
    this.#changed(target, 'delete');
  }

  async removeEmptyFolder(dir: AbsPath): Promise<boolean> {
    let target: string;
    try {
      target = this.paths.join(this.#parentDir(dir), this.paths.basename(dir));
    } catch {
      return false;
    }
    if (this.#get(target)?.kind !== 'dir' || this.#children(target).length > 0) return false;
    this.#nodes.delete(this.#key(target));
    this.writes.push(target);
    this.#changed(target, 'delete');
    return true;
  }

  async removeTree(dir: AbsPath): Promise<void> {
    const target = this.paths.join(this.#parentDir(dir), this.paths.basename(dir));
    const node = this.#get(target);
    if (!node) return;
    const gone = node.kind === 'dir' ? this.#pathsBelow(target) : [];
    if (node.kind === 'dir') for (const key of this.#descendants(target)) this.#nodes.delete(key);
    this.#nodes.delete(this.#key(target));
    this.writes.push(target);
    for (const path of [...gone, target]) this.#changed(path, 'delete');
  }

  /** Like the Node adapter's: the copy gets the original's permission bits, a new file and an old one alike. */
  async copyFile(from: AbsPath, to: AbsPath): Promise<void> {
    const original = await this.lstat(from);
    await this.writeBytesAtomic(to, await this.readBytes(from), original ? { mode: original.mode & 0o777 } : {});
  }

  /** Links in the same tree, as the Links port sees them. */
  readonly links: Links = {
    create: async (target, link) => {
      const parent = this.#parentDir(link);
      const path = this.paths.join(parent, this.paths.basename(link));
      if (this.#get(path)) throw osError('EEXIST', link);
      this.#nodes.set(this.#key(path), { kind: 'link', name: this.paths.basename(link), target, mtimeMs: this.#now() });
      this.writes.push(path);
      this.#changed(path, 'create');
    },
    readTarget: async (link) => {
      const node = this.#get(this.paths.join(this.#parentDir(link), this.paths.basename(link)));
      return node?.kind === 'link' ? (node.target as AbsPath) : undefined;
    },
    retarget: async (link, newTarget) => {
      const path = this.paths.join(this.#parentDir(link), this.paths.basename(link));
      const node = this.#get(path);
      if (node?.kind !== 'link') throw new AppError('fs.notFound', { path: link });
      this.#nodes.set(this.#key(path), { ...node, target: newTarget, mtimeMs: this.#now() });
      this.writes.push(path);
      this.#changed(path, 'update');
    },
    remove: async (link) => {
      const path = this.paths.join(this.#parentDir(link), this.paths.basename(link));
      const node = this.#get(path);
      if (node?.kind !== 'link') throw new AppError('fs.notFound', { path: link });
      this.#nodes.delete(this.#key(path));
      this.writes.push(path);
      this.#changed(path, 'delete');
    },
  };

  /** Seeds a file, creating its folders: for test setup. */
  async put(path: string, text: string): Promise<void> {
    await this.mkdirp(this.paths.dirname(path) as AbsPath);
    await this.writeTextAtomic(path as AbsPath, text);
  }
}
