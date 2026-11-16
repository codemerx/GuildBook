// The folder page (PLAN.md §3.17 step 3): the facts about the chosen folder, from the guarded file system and the
// Volumes port, checked by the pure rules of domain/location.ts. Relocation (Step 9) reuses it.
import type { FileSystem } from '../../ports/fs.ts';
import type { Volumes } from '../../ports/volumes.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { checkLocation, type LocationCheck, type LocationContext, type LocationFacts } from '../domain/location.ts';

export interface FolderCheckDeps {
  readonly fs: FileSystem;
  readonly volumes: Volumes;
}

export async function folderFacts(path: AbsPath, deps: FolderCheckDeps): Promise<LocationFacts> {
  const entry = await deps.fs.lstat(path);
  let kind: LocationFacts['entry'] = 'missing';
  if (entry?.kind === 'dir') kind = (await deps.fs.list(path)).length === 0 ? 'emptyFolder' : 'folder';
  else if (entry?.kind === 'link') kind = 'link';
  else if (entry) kind = 'file';
  const volume = await deps.volumes.info(path);
  return { entry: kind, writable: volume.writable, volume: { kind: volume.kind, freeBytes: volume.freeBytes } };
}

export async function checkFolder(
  path: string,
  context: LocationContext,
  deps: FolderCheckDeps,
): Promise<LocationCheck> {
  if (!context.paths.isAbsolute(path)) return checkLocation(path, missing, context);
  const folder = context.paths.normalize(path) as AbsPath;
  return checkLocation(folder, await folderFacts(folder, deps), context);
}

const missing: LocationFacts = { entry: 'missing', writable: true, volume: { kind: 'unknown', freeBytes: null } };
