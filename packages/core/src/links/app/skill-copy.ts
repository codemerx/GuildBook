// A skill folder's copies (PLAN.md §3.3, §3.4): the one place that reads, fingerprints and writes them. Projected
// copies (Step 8) and copy-mode copies (Step 16) both use it:
// - a side is read without following links: a link inside a skill stays a link (PLAN.md §3.15)
// - the files the library's ignore rules match are never copied, written back or removed, and don't count
// - a copy's SKILL.md may have another `name:` line; its fingerprint is taken with the git name restored, so a copy and
//   the library compare equal exactly when they differ in nothing else
import { editSkillMd } from '@app/schemas';
import { blobId, isFingerprintJunk, linkBlobId } from '../../library/index.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Links } from '../../ports/links.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { hashValue } from '../../shared/hash.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import { mirrorFolder } from './copy-folder.ts';

/** One file or link of a folder, by its path relative to the folder with forward slashes. */
export type CopyEntry =
  | { readonly kind: 'file'; readonly bytes: Uint8Array; readonly executable: boolean }
  | { readonly kind: 'link'; readonly target: string };

export interface SkillCopyDeps {
  readonly fs: FileSystem;
  /** The guarded Links port: links inside a skill are made again as links. */
  readonly links: Links;
  readonly paths: PathFlavour;
  /** Which of these library paths (`skills/<folder>/…`, forward slashes) the library's ignore rules match. */
  readonly ignored: (paths: readonly string[]) => Promise<ReadonlySet<string>>;
}

export interface SkillCopies {
  /** Every file and link below a folder (none when it's missing), junk and `skip` left out. Links are never followed. */
  readonly read: (root: AbsPath, skip?: (relative: string) => boolean) => Promise<Map<string, CopyEntry>>;
  /** The paths of these sides that the library's ignore rules match, for the skill `skill`. */
  readonly ignoredOf: (skill: string, ...sides: ReadonlyArray<Map<string, CopyEntry>>) => Promise<Set<string>>;
  /** A side's fingerprint: ignored files left out, SKILL.md read with `gitName` as its `name:` line when given. */
  readonly fingerprint: (
    entries: Map<string, CopyEntry>,
    ignored: ReadonlySet<string>,
    gitName: string | null,
  ) => string;
  /**
   * Makes `to` equal `from`, the ignored files and `leave` left alone on both sides, with SKILL.md's `name:` line set
   * to `name` (null: SKILL.md as it is). When `from` is gone, `to` loses its files too (PLAN.md §3.8 S8).
   */
  readonly mirror: (
    from: AbsPath,
    to: AbsPath,
    name: string | null,
    ignored: ReadonlySet<string>,
    leave?: (relative: string) => boolean,
  ) => Promise<void>;
  /** Removes every file and link below `root`, then the folders below it that are empty; `leave` stays in place. */
  readonly clear: (root: AbsPath, leave?: (relative: string) => boolean) => Promise<void>;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** SKILL.md with another `name:` line, byte for byte otherwise; undefined when its header can't be edited. */
export function renamedSkillMd(bytes: Uint8Array, name: string): Uint8Array | undefined {
  const edited = editSkillMd(decoder.decode(bytes), { name });
  return edited.ok ? encoder.encode(edited.text) : undefined;
}

export function skillCopies(deps: SkillCopyDeps): SkillCopies {
  const { fs, paths } = deps;
  const item = (skill: string, relative: string) => `skills/${skill}/${relative}`;
  const native = (relative: string) => relative.split('/').join(paths.sep);
  const forward = (relative: string) => relative.split(paths.sep).join('/');

  const read = async (root: AbsPath, skip?: (relative: string) => boolean): Promise<Map<string, CopyEntry>> => {
    const out = new Map<string, CopyEntry>();
    if ((await fs.lstat(root))?.kind !== 'dir') return out;
    const visit = async (relative: string): Promise<void> => {
      const dir = (relative === '' ? root : paths.join(root, ...relative.split('/'))) as AbsPath;
      for (const name of await fs.list(dir)) {
        if (isFingerprintJunk(name)) continue;
        const child = relative === '' ? name : `${relative}/${name}`;
        if (skip?.(child)) continue;
        const at = paths.join(root, ...child.split('/')) as AbsPath;
        const entry = await fs.lstat(at);
        if (entry?.kind === 'dir') await visit(child);
        else if (entry?.kind === 'file') {
          // Whether it is executable counts as content, as in git: a script must stay one in the copy the tool reads.
          out.set(child, { kind: 'file', bytes: await fs.readBytes(at), executable: (entry.mode & 0o100) !== 0 });
        } else if (entry?.kind === 'link') out.set(child, { kind: 'link', target: await fs.readLink(at) });
      }
    };
    await visit('');
    return out;
  };

  const clear = async (root: AbsPath, leave?: (relative: string) => boolean): Promise<void> => {
    const there = await read(root);
    for (const relative of there.keys()) {
      if (!leave?.(relative)) await fs.remove(paths.join(root, native(relative)) as AbsPath);
    }
    if ((await fs.lstat(root))?.kind !== 'dir') return;
    // Empty folders, deepest first; one that still holds a file left in place stays.
    const dirs = new Set<string>();
    for (const relative of there.keys()) {
      const parts = relative.split('/');
      for (let i = parts.length - 1; i > 0; i--) dirs.add(parts.slice(0, i).join('/'));
    }
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
      await fs.removeEmptyFolder(paths.join(root, native(dir)) as AbsPath);
    }
  };

  return {
    read,
    clear,

    ignoredOf: async (skill, ...sides) => {
      const relatives = [...new Set(sides.flatMap((side) => [...side.keys()]))];
      const matched = await deps.ignored(relatives.map((relative) => item(skill, relative)));
      return new Set(relatives.filter((relative) => matched.has(item(skill, relative))));
    },

    fingerprint: (entries, ignored, gitName) => {
      const parts: string[][] = [];
      // Paths are unique: no two compare equal.
      for (const [relative, entry] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (ignored.has(relative)) continue;
        if (entry.kind === 'link') {
          parts.push([relative, 'link', linkBlobId(entry.target)]);
          continue;
        }
        const bytes =
          relative === 'SKILL.md' && gitName !== null
            ? (renamedSkillMd(entry.bytes, gitName) ?? entry.bytes)
            : entry.bytes;
        parts.push([relative, entry.executable ? 'executable' : 'file', blobId(bytes)]);
      }
      return hashValue(parts);
    },

    mirror: async (from, to, name, ignored, leave) => {
      const left = (relative: string) => ignored.has(forward(relative)) || (leave?.(forward(relative)) ?? false);
      if ((await fs.lstat(from))?.kind === 'dir') {
        await mirrorFolder({ fs, links: deps.links, paths }, from, to, {
          leave: left,
          ...(name === null
            ? {}
            : {
                transform: (relative: string, bytes: Uint8Array) =>
                  forward(relative) === 'SKILL.md' ? renamedSkillMd(bytes, name) : undefined,
              }),
        });
        return;
      }
      // The side it comes from is gone (deleted through a link): the other side loses its files too.
      await clear(to, (relative) => left(relative));
    },
  };
}
