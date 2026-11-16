// The layout scanner's rules (PLAN.md §3.18): where skills sit in the layouts companies already use, and what a
// source holds that isn't imported. A source is a git repo, a folder or an unpacked zip; paths are relative to it, with
// forward slashes, '' for the source itself. The scanner looks only in these places, so it never walks a whole code
// repo (PLAN.md §3.7 rule 5: only what's needed to show the skills for review).

/** Where a skill was found: the layouts of PLAN.md §3.18. */
export type LayoutKind =
  /** The source is one skill: SKILL.md at its top. */
  | 'single'
  /** A skill folder at the source's top, e.g. `code-review/SKILL.md`. */
  | 'root'
  /** `skills/<skill>/` (plain skills repos, `npx skills`). */
  | 'skills'
  /** `.agents/skills/<skill>/` (dotagents, code repos). */
  | 'agents'
  /** `.claude/skills/<skill>/` (code repos). */
  | 'claude'
  /** `plugins/<plugin>/skills/<skill>/` (Claude Code plugin marketplaces). */
  | 'plugin';

/** A folder whose subfolders may be skills, and the layout they belong to. */
export interface SkillPlace {
  readonly folder: string;
  readonly layout: Exclude<LayoutKind, 'single'>;
}

/** The fixed places (PLAN.md §3.18): repo root, `skills/`, `.agents/skills/`, `.claude/skills/`. */
export const FIXED_PLACES: readonly SkillPlace[] = [
  { folder: '', layout: 'root' },
  { folder: 'skills', layout: 'skills' },
  { folder: '.agents/skills', layout: 'agents' },
  { folder: '.claude/skills', layout: 'claude' },
];

/** `plugins/*` holds the plugins of a marketplace; each may have a `skills/` folder. */
export const PLUGINS_FOLDER = 'plugins';

export function pluginPlace(plugin: string): SkillPlace {
  return { folder: `${PLUGINS_FOLDER}/${plugin}/skills`, layout: 'plugin' };
}

/** Folder names never taken for skills at the source's top: git's own, and the other layouts' folders. */
const NOT_A_ROOT_SKILL = new Set(['.git', 'skills', 'plugins', '.agents', '.claude', '.claude-plugin', 'node_modules']);

/** Whether a folder at a place may be a skill (it still needs a SKILL.md). */
export function mayBeSkill(place: SkillPlace, name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (place.layout === 'root') return !NOT_A_ROOT_SKILL.has(name) && !name.startsWith('.');
  return name !== '.git';
}

/** What a source holds that isn't imported (PLAN.md §3.18): it's listed in the import report, by path only. */
export type NotImportedKind = 'command' | 'agent' | 'hook' | 'mcp';

export interface NotImported {
  readonly kind: NotImportedKind;
  readonly path: string;
}

/**
 * The folders whose files are listed as not imported, by kind, relative to a base: the source's top, `.claude/`, or a
 * plugin's folder. Nothing in them is opened.
 */
export const NOT_IMPORTED_FOLDERS: ReadonlyArray<{ readonly folder: string; readonly kind: NotImportedKind }> = [
  { folder: 'commands', kind: 'command' },
  { folder: 'agents', kind: 'agent' },
  { folder: 'hooks', kind: 'hook' },
];

/** The MCP server config of a source, `.claude/` or a plugin. */
export const MCP_FILE = '.mcp.json';

/** The bases the not-imported folders are looked for in: the top, `.claude/`, and each plugin. */
export function notImportedBases(plugins: readonly string[]): string[] {
  return ['', '.claude', ...plugins.map((plugin) => `${PLUGINS_FOLDER}/${plugin}`)];
}

export const joinPath = (base: string, name: string): string => (base === '' ? name : `${base}/${name}`);

/** The last part of a relative path, or `fallback` for the source itself. */
export function baseName(path: string, fallback: string): string {
  return path === '' ? fallback : (path.split('/').at(-1) ?? fallback);
}

/** A stable order for what the scanner found: by path. */
export const byPath = <T extends { readonly path: string }>(a: T, b: T): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
