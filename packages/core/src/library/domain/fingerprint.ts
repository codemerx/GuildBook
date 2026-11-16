// Fingerprints (PLAN.md §3.8): git's own object ids for a folder's content, so a folder can be compared with a library
// item, or with an older company version from git's history (S4). Files are blobs, links are blobs of their target,
// folders are trees, exactly as git hashes them (SHA-1 object format). `.DS_Store` and `Thumbs.db` are left out, and
// so are empty folders, which git doesn't keep. Content is hashed as it is on disk, without git's line-ending filters.
import { sha1Bytes, toHex } from '../../shared/hash.ts';

export type FileMode = '100644' | '100755' | '120000';

export interface TreeFile {
  /** Inside the fingerprinted folder, with forward slashes. */
  readonly path: string;
  readonly mode: FileMode;
  /** The blob's id: 40 hex digits. */
  readonly blob: string;
}

/** git's id of the empty tree. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const encoder = new TextEncoder();

/** Left out of fingerprints wherever they are (PLAN.md §3.8). */
export function isFingerprintJunk(name: string): boolean {
  return name === '.DS_Store' || name.toLowerCase() === 'thumbs.db';
}

function object(type: 'blob' | 'tree', content: Uint8Array): Uint8Array {
  const header = encoder.encode(`${type} ${content.length}\0`);
  const bytes = new Uint8Array(header.length + content.length);
  bytes.set(header);
  bytes.set(content, header.length);
  return sha1Bytes(bytes);
}

/** A file's blob id (`git hash-object --no-filters`). */
export function blobId(content: Uint8Array): string {
  return toHex(object('blob', content));
}

/** A link's blob id: git stores a symbolic link as a blob holding its target. */
export function linkBlobId(target: string): string {
  return blobId(encoder.encode(target));
}

interface Dir {
  readonly files: Map<string, TreeFile>;
  readonly dirs: Map<string, Dir>;
}

/** The tree id of these files (`git write-tree` of an index holding exactly them). */
export function treeId(files: readonly TreeFile[]): string {
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    if (parts.some(isFingerprintJunk)) continue;
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.set(parts.at(-1) ?? '', file);
  }
  return toHex(writeTree(root) ?? object('tree', new Uint8Array()));
}

/** Writes a tree object; undefined for a folder without files, which git leaves out. */
function writeTree(dir: Dir): Uint8Array | undefined {
  const entries: Array<{ name: string; sortKey: Uint8Array; mode: string; id: Uint8Array }> = [];
  for (const [name, file] of dir.files) {
    entries.push({ name, sortKey: encoder.encode(name), mode: file.mode, id: hexBytes(file.blob) });
  }
  for (const [name, sub] of dir.dirs) {
    const id = writeTree(sub);
    // git sorts a folder as if its name ended with a slash.
    if (id) entries.push({ name, sortKey: encoder.encode(`${name}/`), mode: '40000', id });
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => compareBytes(a.sortKey, b.sortKey));
  const parts = entries.flatMap((entry) => [encoder.encode(`${entry.mode} ${entry.name}\0`), entry.id]);
  const content = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    content.set(part, offset);
    offset += part.length;
  }
  return object('tree', content);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function hexBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`not a git object id: ${hex}`);
  return new Uint8Array(hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
}
