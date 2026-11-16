// The user's own folders in the tools' skills folders (PLAN.md §3.3 "Detection"): only the folder names are listed,
// and only whether a name starts with `<prefix>-` for one of the prefixes asked about is kept. No file is opened, no
// other name is kept, and nothing is sent anywhere (D8).
import type { FileSystem } from '../../ports/fs.ts';
import type { AbsPath } from '../../shared/brand.ts';
import type { PathFlavour } from '../../shared/paths.ts';

export async function prefixesUsedByFolders(
  fs: FileSystem,
  paths: PathFlavour,
  folders: readonly string[],
  prefixes: readonly string[],
  options: {
    /** The instance's own links, which never count as the user's folders. */
    readonly ours?: (folder: string, name: string) => boolean;
  } = {},
): Promise<Set<string>> {
  const used = new Set<string>();
  const wanted = [...new Set(prefixes)];
  for (const folder of new Set(folders.map((f) => paths.normalize(f)))) {
    if ((await fs.lstat(folder as AbsPath))?.kind !== 'dir') continue;
    for (const name of await fs.list(folder as AbsPath)) {
      const prefix = wanted.find((p) => name.startsWith(`${p}-`));
      if (prefix === undefined || used.has(prefix)) continue;
      if (options.ours?.(folder, name)) continue;
      used.add(prefix);
    }
  }
  return used;
}
