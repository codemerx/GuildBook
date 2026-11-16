// An lstat-based listing of a folder tree (TESTING.md §6 `tree(path)`): folders, files with their SHA-256, and links
// with their targets. Links are reported, never followed.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface TreeItem {
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'link' | 'other';
  readonly size?: number;
  readonly sha256?: string;
  readonly target?: string;
}

export async function treeOf(root: string, options: { maxEntries?: number } = {}): Promise<TreeItem[]> {
  const items: TreeItem[] = [];
  const max = options.maxEntries ?? 10_000;
  async function walk(dir: string): Promise<void> {
    for (const name of (await fs.readdir(dir)).sort()) {
      if (items.length >= max) return;
      const full = path.join(dir, name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      const stats = await fs.lstat(full);
      if (stats.isSymbolicLink()) items.push({ path: relative, kind: 'link', target: await fs.readlink(full) });
      else if (stats.isDirectory()) {
        items.push({ path: relative, kind: 'dir' });
        await walk(full);
      } else if (stats.isFile()) {
        const sha256 = createHash('sha256')
          .update(await fs.readFile(full))
          .digest('hex');
        items.push({ path: relative, kind: 'file', size: stats.size, sha256 });
      } else items.push({ path: relative, kind: 'other' });
    }
  }
  try {
    await walk(root);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  return items;
}

/** The last lines of a text file, or none when it doesn't exist. */
export async function tailLines(file: string, count: number): Promise<string[]> {
  try {
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter((line) => line.length > 0);
    return lines.slice(-count);
  } catch {
    return [];
  }
}
