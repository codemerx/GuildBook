// The worker's side of the asset protocol (IMPLEMENTATION.md §2.8): a file from this library, and nothing outside
// it. The guarded file system also refuses a path that a link would lead outside the library.
import { type AbsPath, AppError, type FileSystem, type PathFlavour } from '@app/core';
import { mimeTypeFor } from '../shared/assets.ts';

export async function readAsset(
  deps: { fs: FileSystem; paths: PathFlavour; libraryPath: string },
  relative: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const segments = relative.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || /[\\:\0]/.test(s))) {
    throw new AppError('asset.outsideLibrary', { path: relative });
  }
  const file = deps.paths.join(deps.libraryPath, ...segments) as AbsPath;
  if (!deps.paths.isInside(deps.libraryPath, file)) throw new AppError('asset.outsideLibrary', { path: relative });
  let entry: Awaited<ReturnType<FileSystem['lstat']>>;
  try {
    entry = await deps.fs.lstat(file);
  } catch (error) {
    if (error instanceof AppError && error.code === 'fs.outsideAllowedRoots') {
      throw new AppError('asset.outsideLibrary', { path: relative });
    }
    throw error;
  }
  // A link is never served, wherever it points: links inside a skill are never followed (PLAN.md §3.15).
  if (entry?.kind === 'link') throw new AppError('asset.outsideLibrary', { path: relative });
  if (entry?.kind !== 'file') throw new AppError('asset.notFound', { path: relative });
  try {
    return { bytes: await deps.fs.readBytes(file), mimeType: mimeTypeFor(file) };
  } catch (error) {
    if (error instanceof AppError && error.code === 'fs.outsideAllowedRoots') {
      throw new AppError('asset.outsideLibrary', { path: relative });
    }
    throw error;
  }
}
