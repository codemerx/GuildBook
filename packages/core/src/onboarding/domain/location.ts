// The location check for a library folder (PLAN.md §3.17 step 3, §3.9), shared with relocation (Step 9): a local
// disk, writable, empty or new, enough space, not inside a tool folder or another library; and a warning for folders
// that iCloud Drive, OneDrive or Dropbox sync, and (Step 6) not inside an added code repo. The facts come from the file
// system and the Volumes port; the rules here are pure.
import type { Platform } from '../../ports/env.ts';
import type { PathFlavour } from '../../shared/paths.ts';

export interface LocationFacts {
  /** What is at the path now. */
  readonly entry: 'missing' | 'emptyFolder' | 'folder' | 'file' | 'link';
  /** Whether the app could create a file in the folder, or in its nearest existing parent when it's new. */
  readonly writable: boolean;
  readonly volume: { readonly kind: 'local' | 'network' | 'unknown'; readonly freeBytes: number | null };
}

export interface LocationContext {
  readonly platform: Platform;
  readonly paths: PathFlavour;
  readonly home: string;
  /** Every tool's folders from the catalog (`detect` and `user_skill_dirs`), with `~` already expanded. */
  readonly toolFolders: ReadonlyArray<{ readonly tool: string; readonly path: string }>;
  /** The other libraries on this device. */
  readonly libraries: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  /** Every instance's added code repos (Step 6): a library folder can't go inside one. */
  readonly repos?: readonly string[];
  /** How much free space the library needs, in bytes. */
  readonly neededBytes: number;
}

export type LocationProblem =
  | { readonly code: 'location.notAbsolute' }
  | { readonly code: 'location.networkDrive' }
  | { readonly code: 'location.readOnly' }
  | { readonly code: 'location.notEmpty' }
  | { readonly code: 'location.notAFolder' }
  | { readonly code: 'location.tooLittleSpace'; readonly neededBytes: number; readonly freeBytes: number }
  | { readonly code: 'location.insideToolFolder'; readonly tool: string; readonly folder: string }
  | { readonly code: 'location.insideLibrary'; readonly library: string }
  | { readonly code: 'location.containsLibrary'; readonly library: string }
  | { readonly code: 'location.insideRepo'; readonly repo: string };

export type CloudService = 'iCloud Drive' | 'OneDrive' | 'Dropbox';

export type LocationWarning = { readonly code: 'location.cloudFolder'; readonly service: CloudService };

export interface LocationCheck {
  readonly path: string;
  readonly problems: readonly LocationProblem[];
  readonly warnings: readonly LocationWarning[];
}

/** The space a library needs when the host doesn't say how big it is (100 MB). */
export const DEFAULT_NEEDED_BYTES = 100 * 1024 * 1024;

/** Room for the clone and the working tree: twice the repository's size, plus 50 MB, and never less than the default. */
export function neededBytes(repoBytes: number | null): number {
  if (repoBytes === null) return DEFAULT_NEEDED_BYTES;
  return Math.max(DEFAULT_NEEDED_BYTES, 2 * repoBytes + 50 * 1024 * 1024);
}

export function checkLocation(path: string, facts: LocationFacts, context: LocationContext): LocationCheck {
  const { paths } = context;
  if (!paths.isAbsolute(path)) return { path, problems: [{ code: 'location.notAbsolute' }], warnings: [] };
  const folder = paths.normalize(path);
  const problems: LocationProblem[] = [];
  if (facts.entry === 'file' || facts.entry === 'link') problems.push({ code: 'location.notAFolder' });
  if (facts.entry === 'folder') problems.push({ code: 'location.notEmpty' });
  if (facts.volume.kind === 'network') problems.push({ code: 'location.networkDrive' });
  if (!facts.writable) problems.push({ code: 'location.readOnly' });
  const free = facts.volume.freeBytes;
  if (free !== null && free < context.neededBytes) {
    problems.push({ code: 'location.tooLittleSpace', neededBytes: context.neededBytes, freeBytes: free });
  }
  const tool = context.toolFolders.find((t) => paths.isInside(t.path, folder));
  if (tool) problems.push({ code: 'location.insideToolFolder', tool: tool.tool, folder: tool.path });
  for (const library of context.libraries) {
    if (paths.isInside(library.path, folder)) problems.push({ code: 'location.insideLibrary', library: library.name });
    else if (paths.isInside(folder, library.path)) {
      problems.push({ code: 'location.containsLibrary', library: library.name });
    }
  }
  const repo = (context.repos ?? []).find((path) => paths.isInside(path, folder));
  if (repo !== undefined) problems.push({ code: 'location.insideRepo', repo });
  const service = cloudService(folder, context);
  return { path: folder, problems, warnings: service ? [{ code: 'location.cloudFolder', service }] : [] };
}

/** The service that syncs this folder, from where those services keep their folders by default. */
export function cloudService(
  folder: string,
  context: Pick<LocationContext, 'platform' | 'paths' | 'home'>,
): CloudService | null {
  const { paths, home } = context;
  const below = paths.relative(home, folder);
  if (below === undefined || below === '') return null;
  const parts = below.split(paths.sep).map((part) => part.toLowerCase());
  const [first = '', second = '', third = ''] = parts;
  if (context.platform === 'darwin' && first === 'library') {
    // iCloud Drive keeps its files in ~/Library/Mobile Documents; OneDrive and Dropbox use File Provider folders.
    if (second === 'mobile documents') return 'iCloud Drive';
    if (second === 'cloudstorage') {
      if (third.startsWith('onedrive')) return 'OneDrive';
      if (third.startsWith('dropbox')) return 'Dropbox';
      if (third.startsWith('icloud')) return 'iCloud Drive';
    }
    return null;
  }
  if (first === 'dropbox' || first.startsWith('dropbox (')) return 'Dropbox';
  if (first === 'onedrive' || first.startsWith('onedrive - ') || first.startsWith('onedrive-')) return 'OneDrive';
  // iCloud for Windows keeps its folder in %USERPROFILE%\iCloudDrive.
  if (context.platform === 'win32' && first === 'iclouddrive') return 'iCloud Drive';
  return null;
}

/** A tool folder path from the catalog (`~/.claude/skills`) as an absolute path in this home folder. */
export function expandHome(folder: string, home: string, paths: PathFlavour): string {
  if (folder === '~') return paths.normalize(home);
  if (folder.startsWith('~/') || folder.startsWith('~\\')) return paths.join(home, ...folder.slice(2).split(/[\\/]/));
  return paths.normalize(folder);
}
