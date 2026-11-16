// The tools on this device (PLAN.md §3.4): the catalog's entries and the user's custom tools, with every folder made
// absolute. A tool's own folder (the first `detect` entry, e.g. `~/.codex`) can be moved: by the user on the tools page
// (kept in device.json), or by the environment variable the catalog names (`home_env`, e.g. CODEX_HOME). Paths inside
// that folder move with it; other paths (Codex's `~/.agents/skills`) stay where they are.
import type { Catalog, InstructionsLimit, InstructionsMethod, ToolEntry } from '@app/tools';
import type { PathFlavour } from '../../shared/paths.ts';

export type SameNameHandling = ToolEntry['same_name_handling'];

/** Where a tool's own folder comes from. */
export type ToolFolderSource = 'default' | 'env' | 'user';

/**
 * Where and how a tool reads the company's instructions (PLAN.md §3.12), with every path absolute. The catalog's
 * entry, or a custom tool's file and method.
 */
export interface ResolvedInstructions {
  readonly method: InstructionsMethod;
  /** The file for a block; the folder for an owned file. Empty for `manual`. */
  readonly path: string;
  readonly limit: InstructionsLimit | null;
  /** The owned file's name after the prefix, e.g. `.md`. */
  readonly fileSuffix: string;
  /** Gemini: the file whose marked block imports the owned copy. */
  readonly importFrom: string | null;
  /** Codex: the file read instead of `path` while it has text of its own. */
  readonly override: string | null;
  /** OpenCode: the config file whose `instructions` list points at an owned copy while `path` is missing. */
  readonly configEntry: string | null;
}

export interface ResolvedTool {
  readonly id: string;
  readonly name: string;
  /** A custom tool the user described (PLAN.md §3.4 "Custom tools"). */
  readonly custom: boolean;
  /** The tool's own folder, e.g. `/home/u/.codex`; null for a custom tool. */
  readonly home: string | null;
  readonly homeSource: ToolFolderSource;
  /** The environment variable that moved it, when it did. */
  readonly homeEnv: string | null;
  /** Folders whose existence means "installed". A custom tool has none: the user added it. */
  readonly detect: readonly string[];
  /** Every folder it reads skills from, in its order, absolute and normalized. */
  readonly skillDirs: readonly string[];
  /** The folders it reads inside a code repo, relative to the checkout and normalized (PLAN.md §3.6). */
  readonly repoSkillDirs: readonly string[];
  /** How far up it looks for repo skill folders (PLAN.md §3.6 "Nested repos are independent"). */
  readonly repoLookup: ToolEntry['repo_lookup'];
  readonly sameNameHandling: SameNameHandling;
  readonly followsLinks: boolean;
  readonly verified: ToolEntry['verified'];
  readonly versionCommand: string | null;
  readonly listCommand: string | null;
  /** null: the app has no way to reach its instructions, so it gets skills only (PLAN.md §3.4). */
  readonly instructions: ResolvedInstructions | null;
}

/** A custom tool's instructions: a file with a marked block, or a folder for an owned file (PLAN.md §3.4). */
export interface CustomToolInstructions {
  readonly method: 'marked-block' | 'owned-file';
  readonly path: string;
}

export interface CustomTool {
  readonly id: string;
  readonly name: string;
  readonly skillDirs: readonly string[];
  readonly instructions?: CustomToolInstructions | null;
  /** A copy target (Step 16): its folder gets copies instead of links (copy mode, PLAN.md §3.4). */
  readonly copy?: boolean;
}

export interface ToolSettings {
  /** Custom tools, kept once per device (device.json). */
  readonly customTools: readonly CustomTool[];
  /** Tool folders the user changed: tool id → folder, kept once per device. */
  readonly toolFolders: Readonly<Record<string, string>>;
  /** The `home_env` variables that are set, from the environment or the login shell (PLAN.md §3.4). */
  readonly homeEnv: Readonly<Record<string, string>>;
}

export const NO_TOOL_SETTINGS: ToolSettings = { customTools: [], toolFolders: {}, homeEnv: {} };

/** A catalog or user path made absolute: `~` is the home folder; forward slashes work on every OS. */
export function expandPath(path: string, home: string, paths: PathFlavour): string {
  const trimmed = path.trim();
  if (trimmed === '~') return paths.normalize(home);
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return paths.normalize(paths.join(home, ...trimmed.slice(2).split(/[/\\]/)));
  }
  return paths.normalize(paths.name === 'win32' ? trimmed.replace(/\//g, '\\') : trimmed);
}

/** `path` with the folder `from` replaced by `to`, when it's inside `from`. */
function moved(path: string, from: string, to: string, paths: PathFlavour): string {
  const rest = paths.relative(from, path);
  if (rest === undefined) return path;
  return rest === '' ? to : paths.normalize(paths.join(to, rest));
}

function unique(list: readonly string[], paths: PathFlavour): string[] {
  const out: string[] = [];
  for (const item of list) if (!out.some((seen) => paths.same(seen, item))) out.push(item);
  return out;
}

function resolveEntry(entry: ToolEntry, home: string, settings: ToolSettings, paths: PathFlavour): ResolvedTool {
  const defaultHome = entry.detect[0] === undefined ? null : expandPath(entry.detect[0], home, paths);
  const userFolder = settings.toolFolders[entry.id];
  const envValue = entry.home_env ? settings.homeEnv[entry.home_env] : undefined;
  // A variable may name the folder above the tool's own (XDG_CONFIG_HOME for OpenCode).
  const envFolder =
    envValue !== undefined && envValue.trim() !== '' && entry.home_env_subdir
      ? paths.join(envValue.trim(), entry.home_env_subdir)
      : envValue;
  let toolHome = defaultHome;
  let source: ToolFolderSource = 'default';
  if (userFolder !== undefined && userFolder.trim() !== '') {
    toolHome = expandPath(userFolder, home, paths);
    source = 'user';
  } else if (envFolder !== undefined && envFolder.trim() !== '' && paths.isAbsolute(envFolder.trim())) {
    toolHome = expandPath(envFolder, home, paths);
    source = 'env';
  }
  const place = (path: string) => {
    const absolute = expandPath(path, home, paths);
    return defaultHome && toolHome ? moved(absolute, defaultHome, toolHome, paths) : absolute;
  };
  return {
    id: entry.id,
    name: entry.name,
    custom: false,
    home: toolHome,
    homeSource: source,
    homeEnv: source === 'env' ? entry.home_env : null,
    detect: unique(entry.detect.map(place), paths),
    skillDirs: unique(entry.user_skill_dirs.map(place), paths),
    repoSkillDirs: unique(
      entry.repo_skill_dirs.map((dir) => paths.normalize(paths.name === 'win32' ? dir.replace(/\//g, '\\') : dir)),
      paths,
    ),
    repoLookup: entry.repo_lookup,
    sameNameHandling: entry.same_name_handling,
    followsLinks: entry.follows_links,
    verified: entry.verified,
    versionCommand: entry.version_command,
    listCommand: entry.list_command,
    instructions: entry.instructions
      ? {
          method: entry.instructions.method,
          path: entry.instructions.method === 'manual' ? '' : place(entry.instructions.path),
          limit: entry.instructions.limit,
          fileSuffix: entry.instructions.file_suffix ?? '.md',
          importFrom: entry.instructions.import_from ? place(entry.instructions.import_from) : null,
          override: entry.instructions.override ? place(entry.instructions.override) : null,
          configEntry: entry.instructions.config_entry ? place(entry.instructions.config_entry) : null,
        }
      : null,
  };
}

/** Every tool this device knows: the catalog's, then the custom ones. A custom tool never hides a catalog tool. */
export function resolveTools(
  catalog: Catalog,
  home: string,
  settings: ToolSettings,
  paths: PathFlavour,
): ResolvedTool[] {
  const tools = catalog.tools.map((entry) => resolveEntry(entry, home, settings, paths));
  const ids = new Set(tools.map((tool) => tool.id));
  for (const custom of settings.customTools) {
    if (ids.has(custom.id)) continue;
    ids.add(custom.id);
    tools.push({
      id: custom.id,
      name: custom.name,
      custom: true,
      home: null,
      homeSource: 'user',
      homeEnv: null,
      detect: [],
      skillDirs: unique(
        custom.skillDirs.map((dir) => expandPath(dir, home, paths)),
        paths,
      ),
      // A custom tool names only the folder it reads skills from: nothing in code repos.
      repoSkillDirs: [],
      repoLookup: 'unknown',
      sameNameHandling: 'unknown',
      // A copy target reads copies: links don't reach into WSL, a container or a sandboxed app (PLAN.md §3.4).
      followsLinks: custom.copy !== true,
      verified: null,
      versionCommand: null,
      listCommand: null,
      instructions: custom.instructions
        ? {
            method: custom.instructions.method,
            path: expandPath(custom.instructions.path, home, paths),
            limit: null,
            fileSuffix: '.md',
            importFrom: null,
            override: null,
            configEntry: null,
          }
        : null,
    });
  }
  return tools;
}

/** A custom tool's id from its name: lower-case words joined by dashes, made unique among `taken`. */
export function customToolId(name: string, taken: readonly string[]): string {
  const base =
    `custom-${name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')}`.replace(/-$/, '') || 'custom';
  let id = base.slice(0, 60);
  for (let n = 2; taken.includes(id); n++) id = `${base.slice(0, 56)}-${n}`;
  return id;
}
