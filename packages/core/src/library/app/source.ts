// Where the scanner reads a library from (IMPLEMENTATION.md §2.5 "Dry runs can read a git tree"): the working tree, or
// a git tree, so previews can show what a pull would bring. Paths are relative to the library, with forward
// slashes; '' is the library itself.
import type { FileSystem } from '../../ports/fs.ts';
import type { GitRepo, GitTreeEntry, TreeEntryKind } from '../../ports/git.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import type { PathFlavour } from '../../shared/paths.ts';

export interface SourceEntry {
  readonly kind: 'file' | 'dir' | 'link' | 'other';
  readonly size: number;
  /** The owner's executable bit, which is what git records (always false on Windows, which has none). */
  readonly executable: boolean;
}

export interface LibrarySource {
  /** The names in a folder, sorted; undefined when it isn't a folder. */
  list(path: string): Promise<string[] | undefined>;
  /** The entry itself (a link is reported as a link), or undefined when nothing is there. */
  stat(path: string): Promise<SourceEntry | undefined>;
  readBytes(path: string): Promise<Uint8Array>;
  readLink(path: string): Promise<string>;
}

/** Reads a folder on disk through the (guarded) file system. */
export function workingTreeSource(fs: FileSystem, paths: PathFlavour, root: AbsPath): LibrarySource {
  const at = (path: string) => (path === '' ? root : (paths.join(root, ...path.split('/')) as AbsPath));
  return {
    async list(path) {
      const entry = await fs.lstat(at(path));
      if (entry?.kind !== 'dir') return undefined;
      try {
        return await fs.list(at(path));
      } catch (error) {
        // Removed between the two calls: the watcher reports it, and the next refresh sees it gone.
        if (isAppError(error) && error.code === 'fs.notFound') return undefined;
        throw error;
      }
    },
    async stat(path) {
      const entry = await fs.lstat(at(path));
      if (!entry) return undefined;
      return { kind: entry.kind, size: entry.size, executable: paths.name === 'posix' && (entry.mode & 0o100) !== 0 };
    },
    readBytes: (path) => fs.readBytes(at(path)),
    readLink: (path) => fs.readLink(at(path)),
  };
}

/**
 * Reads a git tree instead of the working tree (IMPLEMENTATION.md §2.5): a commit, or the tree a dry-run merge would
 * produce, so a preview can scan the library as a pull would leave it. The listing is read once, on first use.
 */
export function gitTreeSource(repo: Pick<GitRepo, 'listTree' | 'readBlob'>, treeish: string): LibrarySource {
  let listing: Promise<Map<string, GitTreeEntry>> | undefined;
  const children = new Map<string, string[]>([['', []]]);
  const load = () =>
    (listing ??= repo.listTree(treeish).then((entries) => {
      const byPath = new Map<string, GitTreeEntry>();
      for (const entry of entries) {
        byPath.set(entry.path, entry);
        const slash = entry.path.lastIndexOf('/');
        const parent = slash < 0 ? '' : entry.path.slice(0, slash);
        const names = children.get(parent) ?? [];
        names.push(entry.path.slice(slash + 1));
        children.set(parent, names);
        if (entry.kind === 'dir' && !children.has(entry.path)) children.set(entry.path, []);
      }
      for (const names of children.values()) names.sort();
      return byPath;
    }));
  // As on disk, `a//b/` names `a/b`.
  const clean = (path: string) =>
    path
      .split('/')
      .filter((part) => part !== '')
      .join('/');
  const blob = async (path: string, kinds: readonly TreeEntryKind[]) => {
    const entry = (await load()).get(clean(path));
    if (!entry || !kinds.includes(entry.kind)) throw new AppError('fs.notFound', { path });
    return repo.readBlob(entry.oid);
  };
  return {
    async list(path) {
      await load();
      const names = children.get(clean(path));
      return names ? [...names] : undefined;
    },
    async stat(path) {
      if (clean(path) === '') return { kind: 'dir', size: 0, executable: false };
      const entry = (await load()).get(clean(path));
      if (!entry) return undefined;
      const kind = entry.kind === 'executable' ? 'file' : entry.kind === 'submodule' ? 'other' : entry.kind;
      return { kind, size: entry.size, executable: entry.kind === 'executable' };
    },
    readBytes: (path) => blob(path, ['file', 'executable']),
    readLink: async (path) => new TextDecoder().decode(await blob(path, ['link'])),
  };
}

/**
 * A tree with this device's uncommitted changes laid over it (IMPLEMENTATION.md §2.5): the library as a pull would
 * leave it. `local` names each changed library path and whether it's on disk (`present`) or deleted; those paths read
 * from `top` (the working tree), everything else from `base` (the tree git's merge produces). Changes to files the pull
 * also changes aren't laid over: git refuses to pull over them (the "local changes" case).
 */
export function overlaySource(
  base: LibrarySource,
  top: LibrarySource,
  local: ReadonlyMap<string, 'present' | 'deleted'>,
): LibrarySource {
  const clean = (path: string) =>
    path
      .split('/')
      .filter((part) => part !== '')
      .join('/');
  // The folders that hold a file present only on this device.
  const folders = new Map<string, Set<string>>();
  for (const [path, state] of local) {
    if (state !== 'present') continue;
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const names = folders.get(parent) ?? new Set<string>();
      names.add(parts[i]!);
      folders.set(parent, names);
    }
  }
  const from = (path: string) => (local.has(clean(path)) ? top : base);
  return {
    async list(path) {
      const at = clean(path);
      const below = await base.list(at);
      const added = folders.get(at);
      if (below === undefined && added === undefined) return undefined;
      const names = new Set([...(below ?? []), ...(added ?? [])]);
      for (const name of [...names]) {
        const child = at === '' ? name : `${at}/${name}`;
        if (local.get(child) === 'deleted') names.delete(name);
      }
      return [...names].sort();
    },
    async stat(path) {
      const at = clean(path);
      const state = local.get(at);
      if (state === 'deleted') return undefined;
      if (state === 'present') return top.stat(at);
      const entry = await base.stat(at);
      if (entry === undefined && folders.has(at)) return { kind: 'dir', size: 0, executable: false };
      return entry;
    },
    readBytes: (path) => from(path).readBytes(clean(path)),
    readLink: (path) => from(path).readLink(clean(path)),
  };
}
