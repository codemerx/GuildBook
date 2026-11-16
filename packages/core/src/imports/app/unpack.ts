// Unpacking a `.zip` or `.skill` file into the import's temporary folder (PLAN.md §3.18 C). Every entry is checked
// first (domain/archive.ts), and one bad entry refuses the whole archive before anything is written. Then each file is
// written through the guarded file system, held to the size it declared, and the total is counted again.
import type { Archive } from '../../ports/archive.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import { ARCHIVE_TOTAL_MAX, archiveProblems, entryPath } from '../domain/archive.ts';

export async function unpackArchive(
  deps: { fs: FileSystem; paths: PathFlavour; archive: Archive },
  file: AbsPath,
  dest: AbsPath,
  signal?: AbortSignal,
): Promise<void> {
  const { fs, paths, archive } = deps;
  const found = await fs.lstat(file);
  if (found?.kind !== 'file') throw new AppError('import.sourceNotFound', {});
  // The archive itself is read whole: one larger than all it may unpack to is refused before that.
  if (found.size > ARCHIVE_TOTAL_MAX) throw new AppError('import.archiveTooLarge', {});
  const bytes = await fs.readBytes(file);
  const entries = await archive.entries(bytes);
  const [problem] = archiveProblems(entries);
  if (problem) throw new AppError('import.archiveRefused', { reason: problem.code, path: problem.path });
  await fs.mkdirp(dest);
  let total = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    const checked = entryPath(entry.path);
    if ('problem' in checked)
      throw new AppError('import.archiveRefused', { reason: checked.problem, path: entry.path });
    const target = paths.join(dest, ...checked.path.split('/')) as AbsPath;
    if (!paths.isInside(dest, target))
      throw new AppError('import.archiveRefused', { reason: 'parentPath', path: entry.path });
    if (entry.kind === 'dir') {
      await fs.mkdirp(target);
      continue;
    }
    const content = await archive.read(bytes, entry);
    total += content.length;
    if (total > ARCHIVE_TOTAL_MAX) throw new AppError('import.archiveRefused', { reason: 'tooLarge', path: '' });
    await fs.mkdirp(paths.dirname(target) as AbsPath);
    await fs.writeBytesAtomic(target, content);
  }
}
