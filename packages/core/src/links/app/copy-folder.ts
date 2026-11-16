// Copying a folder without following links (IMPLEMENTATION.md §2.10, PLAN.md §3.15): a link inside a skill stays a
// link in the copy, and nothing it points to is read. S4's "Bring my changes into the library" makes the library's
// folder equal to the user's changed copy with it; projected copies (Step 8), copy mode (16) and imports (13) reuse it.
import type { FileSystem } from '../../ports/fs.ts';
import type { Links } from '../../ports/links.ts';
import type { AbsPath } from '../../shared/brand.ts';
import type { PathFlavour } from '../../shared/paths.ts';

interface Walked {
  readonly dirs: string[];
  readonly files: string[];
  readonly links: string[];
}

async function walk(fs: FileSystem, paths: PathFlavour, root: AbsPath): Promise<Walked> {
  const out: Walked = { dirs: [], files: [], links: [] };
  const visit = async (relative: string) => {
    const dir = (relative === '' ? root : paths.join(root, relative)) as AbsPath;
    for (const name of await fs.list(dir)) {
      const child = relative === '' ? name : paths.join(relative, name);
      const entry = await fs.lstat(paths.join(root, child) as AbsPath);
      if (entry?.kind === 'dir') {
        out.dirs.push(child);
        await visit(child);
      } else if (entry?.kind === 'link') out.links.push(child);
      else if (entry?.kind === 'file') out.files.push(child);
    }
  };
  await visit('');
  return out;
}

export interface MirrorOptions {
  /**
   * Paths (relative, with the platform's separator) left alone on both sides: never copied, never removed. Projected
   * copies leave the files the library's ignore rules match (PLAN.md §3.3).
   */
  readonly leave?: (path: string) => boolean;
  /** A file's bytes as `to` gets them, e.g. SKILL.md with another `name:` line; undefined copies them as they are. */
  readonly transform?: (path: string, bytes: Uint8Array) => Uint8Array | undefined;
}

/**
 * Makes `to` hold exactly what `from` holds: files copied, links recreated as links, everything else removed. Files
 * that are already equal aren't written again, so the watchers of `to` see only real changes.
 */
export async function mirrorFolder(
  deps: { fs: FileSystem; links: Links; paths: PathFlavour },
  from: AbsPath,
  to: AbsPath,
  options: MirrorOptions = {},
): Promise<void> {
  const { fs, links, paths } = deps;
  const leave = options.leave ?? (() => false);
  const source = await walk(fs, paths, from);
  await fs.mkdirp(to);
  // A folder is made for what goes in it: one that holds only left files isn't made at all.
  const made = new Set<string>();
  const folderOf = async (path: string) => {
    const dir = paths.dirname(paths.join(to, path));
    if (made.has(dir)) return;
    await fs.mkdirp(dir as AbsPath);
    made.add(dir);
  };
  const emptyDirs = source.dirs.filter(
    (dir) => !leave(dir) && ![...source.files, ...source.links].some((p) => p.startsWith(`${dir}${paths.sep}`)),
  );
  for (const dir of emptyDirs) await fs.mkdirp(paths.join(to, dir) as AbsPath);
  for (const file of source.files.filter((f) => !leave(f))) {
    const at = paths.join(to, file) as AbsPath;
    await folderOf(file);
    const there = await fs.lstat(at);
    // A link where the copy has a file is replaced, never written through.
    if (there?.kind === 'link') await fs.remove(at);
    if (there?.kind === 'dir') await fs.removeTree(at);
    const original = paths.join(from, file) as AbsPath;
    // A script keeps its executable bit in the copy; a file that is equal in every way is not written again.
    const mode = (await fs.lstat(original))?.mode;
    const equalPlace =
      there?.kind === 'file' && mode !== undefined && isExecutable(there.mode) === isExecutable(mode)
        ? there
        : undefined;
    const bytes = options.transform?.(file, await fs.readBytes(original));
    if (bytes === undefined && !options.transform) {
      if (equalPlace && (await sameBytes(fs, original, at))) continue;
      await fs.copyFile(original, at);
      continue;
    }
    const content = bytes ?? (await fs.readBytes(original));
    if (equalPlace && equalBytes(await fs.readBytes(at), content)) continue;
    await fs.writeBytesAtomic(at, content, mode === undefined ? {} : { mode });
  }
  for (const link of source.links.filter((l) => !leave(l))) {
    const at = paths.join(to, link) as AbsPath;
    await folderOf(link);
    const target = await fs.readLink(paths.join(from, link) as AbsPath);
    const there = await fs.lstat(at);
    if (there?.kind === 'link' && (await fs.readLink(at)) === target) continue;
    if (there?.kind === 'dir') await fs.removeTree(at);
    else if (there) await fs.remove(at);
    await links.create(target as AbsPath, at);
  }
  const kept = new Set([...source.dirs, ...source.files, ...source.links]);
  const existing = await walk(fs, paths, to);
  for (const path of [...existing.files, ...existing.links].filter((p) => !kept.has(p) && !leave(p))) {
    await fs.remove(paths.join(to, path) as AbsPath);
  }
  // Deepest folders first, so each is empty when it's removed; one that still holds a left file stays.
  for (const dir of existing.dirs.filter((p) => !kept.has(p) && !leave(p)).sort((a, b) => b.length - a.length)) {
    await fs.removeEmptyFolder(paths.join(to, dir) as AbsPath);
  }
}

/** What git records of a file's permissions: whether it is executable (the owner's bit). */
function isExecutable(mode: number): boolean {
  return (mode & 0o100) !== 0;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function sameBytes(fs: FileSystem, a: AbsPath, b: AbsPath): Promise<boolean> {
  return equalBytes(await fs.readBytes(a), await fs.readBytes(b));
}
