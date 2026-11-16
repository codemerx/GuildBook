// Which link folders the app uses (PLAN.md §3.4): the smallest set of folders that covers every enabled tool, so that
// each enabled tool reads at least one of them. Among the smallest sets, the app prefers the one that gives the fewest
// tools a company skill twice: first tools that list both copies (Codex), then tools not verified yet, then any. The
// duplicate analysis then reports every tool that still reads more than one chosen folder.
import type { PathFlavour } from '../../shared/paths.ts';
import type { ResolvedTool, SameNameHandling } from './tools.ts';

export interface LinkFolder {
  /** Absolute and normalized. */
  readonly path: string;
  /** The enabled tools that read it. */
  readonly enabledTools: readonly string[];
  /** Every known tool that reads it, enabled or not: a shared folder serves them all (PLAN.md §3.4). */
  readonly readers: readonly string[];
  /**
   * Copy mode (PLAN.md §3.4, Step 16): an enabled tool that reads it doesn't follow links, so the skills go there as
   * copies. A copy serves the tools that follow links as well.
   */
  readonly copy: boolean;
}

export interface DuplicateReport {
  readonly tool: string;
  readonly enabled: boolean;
  readonly handling: SameNameHandling;
  /** The chosen folders it reads, two or more. */
  readonly folders: readonly string[];
}

export interface LinkFolderChoice {
  readonly folders: readonly LinkFolder[];
  readonly duplicates: readonly DuplicateReport[];
  /** Enabled tools that read no folder at all (a custom tool without folders): nothing can reach them. */
  readonly uncovered: readonly string[];
}

interface Candidate {
  readonly set: readonly string[];
  readonly score: readonly number[];
}

function key(path: string, paths: PathFlavour): string {
  return paths.name === 'win32' ? paths.normalize(path).toLowerCase() : paths.normalize(path);
}

/** Every tool reading two or more of `chosen`, with how it treats a skill it sees twice. */
export function duplicateAnalysis(
  tools: readonly ResolvedTool[],
  enabled: ReadonlySet<string>,
  chosen: readonly string[],
  paths: PathFlavour,
): DuplicateReport[] {
  const chosenKeys = new Map(chosen.map((path) => [key(path, paths), path]));
  const reports: DuplicateReport[] = [];
  for (const tool of tools) {
    const seen = [...new Set(tool.skillDirs.map((dir) => key(dir, paths)))].filter((k) => chosenKeys.has(k));
    if (seen.length < 2) continue;
    reports.push({
      tool: tool.id,
      enabled: enabled.has(tool.id),
      handling: tool.sameNameHandling,
      folders: seen.map((k) => chosenKeys.get(k) as string),
    });
  }
  return reports;
}

function scoreOf(
  set: readonly string[],
  tools: readonly ResolvedTool[],
  enabled: ReadonlySet<string>,
  paths: PathFlavour,
): number[] {
  const reports = duplicateAnalysis(tools, enabled, set, paths).filter((r) => r.enabled);
  return [
    reports.filter((r) => r.handling === 'lists-both').length,
    reports.filter((r) => r.handling === 'unknown').length,
    reports.length,
  ];
}

function better(a: Candidate, b: Candidate): boolean {
  for (let i = 0; i < a.score.length; i++) {
    const x = a.score[i] as number;
    const y = b.score[i] as number;
    if (x !== y) return x < y;
  }
  return a.set.join('\0') < b.set.join('\0');
}

/**
 * The link folders for the enabled tools. Exact: a depth-first search over the folders of the first tool not yet
 * covered finds every smallest set, since each one must hold a folder of that tool.
 */
export function chooseLinkFolders(
  tools: readonly ResolvedTool[],
  enabledIds: readonly string[],
  paths: PathFlavour,
): LinkFolderChoice {
  const enabled = new Set(enabledIds);
  const enabledTools = tools.filter((tool) => enabled.has(tool.id));
  const uncovered = enabledTools.filter((tool) => tool.skillDirs.length === 0).map((tool) => tool.id);
  const needing = enabledTools
    .filter((tool) => tool.skillDirs.length > 0)
    .map((tool) => ({ id: tool.id, dirs: [...new Set(tool.skillDirs.map((dir) => key(dir, paths)))].sort() }));
  const original = new Map<string, string>();
  for (const tool of tools) {
    for (const dir of tool.skillDirs)
      if (!original.has(key(dir, paths))) original.set(key(dir, paths), paths.normalize(dir));
  }

  let best: Candidate | undefined;
  const search = (chosen: string[]) => {
    if (best && chosen.length > best.set.length) return;
    const open = needing.find((tool) => !tool.dirs.some((dir) => chosen.includes(dir)));
    if (!open) {
      const set = [...chosen].sort();
      const candidate = { set, score: scoreOf(set, tools, enabled, paths) };
      if (!best || set.length < best.set.length || (set.length === best.set.length && better(candidate, best))) {
        best = candidate;
      }
      return;
    }
    if (best && chosen.length + 1 > best.set.length) return;
    for (const dir of open.dirs) search([...chosen, dir]);
  };
  search([]);

  const set = (best?.set ?? []).map((k) => original.get(k) ?? k);
  const folders = set.map((path) => {
    const k = key(path, paths);
    const reading = tools.filter((tool) => tool.skillDirs.some((dir) => key(dir, paths) === k));
    const readers = reading.map((t) => t.id);
    const copy = reading.some((tool) => enabled.has(tool.id) && !tool.followsLinks);
    return { path, readers, enabledTools: readers.filter((id) => enabled.has(id)), copy };
  });
  return { folders, duplicates: duplicateAnalysis(tools, enabled, set, paths), uncovered };
}

/**
 * The link folders inside a code repo (PLAN.md §3.4 "Repo placement uses the same logic"): the smallest set of the
 * enabled tools' repo folders, relative to a checkout, e.g. `.claude/skills` and `.agents/skills`.
 */
export function chooseRepoLinkFolders(
  tools: readonly ResolvedTool[],
  enabledIds: readonly string[],
  paths: PathFlavour,
): LinkFolderChoice {
  const asRepo = tools.map((tool) => ({ ...tool, skillDirs: tool.repoSkillDirs }));
  return chooseLinkFolders(asRepo, enabledIds, paths);
}
