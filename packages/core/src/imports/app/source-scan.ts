// The layout scanner (PLAN.md §3.18): finds the skills in a source folder (a clone, a picked folder, an unpacked zip)
// by looking only in the known layouts' places, and lists what isn't imported there by path. It reads each skill's
// SKILL.md and the names in its folder's top; nothing else, and no link is followed.
import { readSkillHeader } from '@app/schemas';
import type { FileSystem } from '../../ports/fs.ts';
import type { AbsPath } from '../../shared/brand.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import {
  byPath,
  FIXED_PLACES,
  joinPath,
  type LayoutKind,
  MCP_FILE,
  mayBeSkill,
  NOT_IMPORTED_FOLDERS,
  type NotImported,
  notImportedBases,
  pluginPlace,
  PLUGINS_FOLDER,
  type SkillPlace,
} from '../domain/layout.ts';

export interface FoundSkill {
  /** The skill's folder relative to the source, with forward slashes; '' when the source is the skill. */
  readonly path: string;
  readonly layout: LayoutKind;
  /** SKILL.md's text. */
  readonly text: string;
  /** The header's fields, or null when it has no readable header. */
  readonly header: Readonly<Record<string, unknown>> | null;
  /** The skill has a `scripts/` folder. */
  readonly scripts: boolean;
}

export interface ScanResult {
  readonly skills: FoundSkill[];
  readonly notImported: NotImported[];
}

/** SKILL.md files larger than this are not read: no real skill comes close (the editor warns at 500 lines). */
const SKILL_MD_READ_MAX = 5 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { ignoreBOM: false });

export async function scanSource(
  deps: { fs: FileSystem; paths: PathFlavour },
  root: AbsPath,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const { fs, paths } = deps;
  const at = (relative: string) => (relative === '' ? root : (paths.join(root, ...relative.split('/')) as AbsPath));
  const kind = async (relative: string) => (await fs.lstat(at(relative)))?.kind;
  /** The names in a folder of the source; the source itself may be a link the user picked. */
  const names = async (relative: string): Promise<string[]> => {
    const found = await kind(relative);
    return found === 'dir' || (relative === '' && found === 'link') ? fs.list(at(relative)) : [];
  };

  const skills: FoundSkill[] = [];
  const seen = new Set<string>();
  const take = async (relative: string, layout: LayoutKind) => {
    signal?.throwIfAborted();
    if (seen.has(relative)) return;
    const skillMd = joinPath(relative, 'SKILL.md');
    const entry = await fs.lstat(at(skillMd));
    if (entry?.kind !== 'file') return;
    seen.add(relative);
    const text = entry.size > SKILL_MD_READ_MAX ? '' : decoder.decode(await fs.readBytes(at(skillMd)));
    const read = readSkillHeader(text);
    skills.push({
      path: relative,
      layout,
      text,
      header: read.status === 'ok' ? read.fields : null,
      scripts: (await kind(joinPath(relative, 'scripts'))) === 'dir',
    });
  };

  await take('', 'single');
  const plugins = (await names(PLUGINS_FOLDER)).filter((name) => name !== '.git');
  const places: SkillPlace[] = [...FIXED_PLACES, ...plugins.map(pluginPlace)];
  for (const place of places) {
    for (const name of await names(place.folder)) {
      if (!mayBeSkill(place, name)) continue;
      const relative = joinPath(place.folder, name);
      // A skill folder is a real folder: a link in its place is never followed (PLAN.md §3.15).
      if ((await kind(relative)) === 'dir') await take(relative, place.layout);
    }
  }

  const notImported: NotImported[] = [];
  for (const base of notImportedBases(plugins)) {
    if (base !== '' && (await kind(base)) !== 'dir') continue;
    for (const { folder, kind: what } of NOT_IMPORTED_FOLDERS) {
      const dir = joinPath(base, folder);
      if (seen.has(dir)) continue;
      for (const name of await names(dir)) notImported.push({ kind: what, path: joinPath(dir, name) });
    }
    const mcp = joinPath(base, MCP_FILE);
    if ((await kind(mcp)) === 'file') notImported.push({ kind: 'mcp', path: mcp });
  }
  return { skills: skills.sort(byPath), notImported: notImported.sort(byPath) };
}
