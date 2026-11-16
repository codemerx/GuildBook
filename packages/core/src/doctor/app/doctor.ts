// The Doctor view (PLAN.md §3.4, IMPLEMENTATION.md Step 7): the real state per enabled tool on this device. Each part
// is a check (IMPLEMENTATION.md §2.14 "Doctor checks"), and each reads only what PLAN.md §3.7 allows:
// - the link folders each tool reads, and whether SKILL.md can be read through each of the app's links there
// - the duplicate risk of Step 5's analysis, and the nested-repo warning of Step 6's
// - the room left in the instruction files with a limit
// - skills whose names may not load: the Agent Skills rules, the prefix, and Claude Code's reserved words
// - where company content doesn't reach, and where copies take it (copy mode, Step 16)
// The tools' version and list commands are device facts that main runs (the renderer asks for them).
import { SKILL_LINK_KIND, skillNameProblems, type SkillLinkRow, type SkillNameProblem } from '@app/schemas';
import { chooseLinkFolders, type ResolvedTool } from '../../catalog/index.ts';
import { defineQuery, type InstanceEngine } from '../../engine/index.ts';
import type { InstructionsState, InstructionToolView, RoomLeft } from '../../instructions/index.ts';
import { manualTools } from '../../instructions/index.ts';
import type { LibrarySnapshot } from '../../library/index.ts';
import { readRow } from '../../links/index.ts';
import type { NestedRepoWarning } from '../../placement/index.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Store } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import type { PathFlavour } from '../../shared/paths.ts';

export const DoctorQuery = defineQuery<Record<string, never>, DoctorReport>('Doctor');

export interface DoctorFolder {
  readonly path: string;
  /** The app's links there that should resolve; in a copy-mode folder, its copies. */
  readonly links: number;
  /** The skills whose SKILL.md can't be read through the link (or in the copy). */
  readonly unreadable: readonly string[];
  /** Copy mode (PLAN.md §3.4, Step 16): the skills go here as copies, which follow the library at each check. */
  readonly copy: boolean;
  /** Copies edited where they are, waiting in "Needs attention" to be brought into the library. */
  readonly changed: readonly string[];
}

export interface DoctorTool {
  readonly id: string;
  readonly name: string;
  readonly custom: boolean;
  readonly home: string | null;
  readonly folders: readonly DoctorFolder[];
  /** It reads two or more of the chosen folders: each company skill is there twice (PLAN.md §3.4). */
  readonly duplicate: {
    readonly folders: readonly string[];
    readonly handling: ResolvedTool['sameNameHandling'];
  } | null;
  /** Nested repos where it may list a skill twice (PLAN.md §3.6), by repo name. */
  readonly nested: ReadonlyArray<{ readonly outer: string; readonly inner: string; readonly lookup: string }>;
  readonly instructions: InstructionToolView['status'];
  readonly room: RoomLeft | null;
  readonly verified: { readonly version: string; readonly date: string } | null;
  readonly versionCommand: boolean;
  readonly listCommand: boolean;
  /** The skills linked for it, to compare with what its list command prints. */
  readonly linkedSkills: readonly string[];
}

export interface InvalidName {
  readonly folder: string;
  readonly name: string | null;
  /** `name.folder`: the `name:` line differs from the folder, so the skill isn't linked at all. */
  readonly problems: ReadonlyArray<SkillNameProblem | 'name.folder' | 'name.missing'>;
  /** The tools that may not load it, by name. */
  readonly tools: readonly string[];
}

export interface DoctorReport {
  readonly tools: readonly DoctorTool[];
  readonly invalidNames: readonly InvalidName[];
  /** Enabled tools whose instructions the app can't write: by hand (Cursor), or skills only. */
  readonly manual: readonly string[];
  readonly skillsOnly: readonly string[];
  /** Enabled tools that read no folder the app links into. */
  readonly uncovered: readonly string[];
  /** Enabled copy targets (Step 16), by name, with their folders: where copies take company content. */
  readonly copyTargets: ReadonlyArray<{ readonly tool: string; readonly folders: readonly string[] }>;
  readonly warnings: number;
}

export interface DoctorDeps {
  readonly engine: InstanceEngine;
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly store: Store;
  readonly snapshot: () => LibrarySnapshot | null;
  readonly tools: () => { tools: ResolvedTool[]; enabled: string[] };
  readonly nested: () => NestedRepoWarning[];
  readonly repoName: (id: string) => string | null;
  readonly instructions: () => Promise<InstructionsState>;
}

/** Tools that check names the Agent Skills way and refuse what doesn't fit (PLAN.md §1.2). */
const STRICT_TOOLS = ['claude-code', 'codex'];

export class DoctorService {
  readonly #deps: DoctorDeps;

  constructor(deps: DoctorDeps) {
    this.#deps = deps;
    deps.engine.handleQuery(DoctorQuery, () => this.report());
  }

  async report(): Promise<DoctorReport> {
    const { tools, enabled } = this.#deps.tools();
    const { paths } = this.#deps;
    const on = tools.filter((tool) => enabled.includes(tool.id));
    const choice = chooseLinkFolders(tools, enabled, paths);
    const rows = this.#rows();
    const instructions = await this.#deps.instructions();
    const nested = this.#deps.nested();
    const readability = new Map<string, DoctorFolder>();
    for (const folder of choice.folders) {
      readability.set(folder.path, await this.#folder(folder.path, folder.copy, rows));
    }
    const doctorTools: DoctorTool[] = on.map((tool) => {
      const folders = choice.folders
        .filter((folder) => tool.skillDirs.some((dir) => paths.same(dir, folder.path)))
        .map((folder) => readability.get(folder.path) as DoctorFolder);
      const duplicate = choice.duplicates.find((report) => report.tool === tool.id);
      const view = instructions.tools.find((t) => t.id === tool.id);
      const linkedSkills = [
        ...new Set(
          rows
            .map(([, row]) => row)
            .filter((row) => row.status === 'linked' && folders.some((folder) => paths.same(folder.path, row.folder)))
            .map((row) => row.skill),
        ),
      ].sort();
      return {
        id: tool.id,
        name: tool.name,
        custom: tool.custom,
        home: tool.home,
        folders,
        duplicate: duplicate ? { folders: duplicate.folders, handling: duplicate.handling } : null,
        nested: nested
          .filter((warning) => warning.tool === tool.id)
          .map((warning) => ({
            outer: this.#deps.repoName(warning.outer) ?? warning.outer,
            inner: this.#deps.repoName(warning.inner) ?? warning.inner,
            lookup: warning.lookup,
          })),
        instructions: view?.status ?? 'none',
        room: view?.room ?? null,
        verified: tool.verified ? { version: tool.verified.version, date: tool.verified.date } : null,
        versionCommand: tool.versionCommand !== null,
        listCommand: tool.listCommand !== null,
        linkedSkills,
      };
    });
    const invalidNames = this.#invalidNames(on);
    const { manual, skillsOnly } = manualTools(tools, enabled);
    const names = new Map(tools.map((tool) => [tool.id, tool.name]));
    const warnings =
      doctorTools.reduce(
        (sum, tool) =>
          sum +
          tool.folders.reduce((n, folder) => n + folder.unreadable.length + folder.changed.length, 0) +
          (tool.duplicate && tool.duplicate.handling !== 'one-wins' ? 1 : 0) +
          tool.nested.length +
          (tool.room && tool.room.state !== 'ok' ? 1 : 0) +
          (tool.instructions === 'edited' || tool.instructions === 'damaged' ? 1 : 0),
        0,
      ) +
      invalidNames.length +
      choice.uncovered.length;
    return {
      tools: doctorTools,
      invalidNames,
      manual: manual.map((id) => names.get(id) ?? id),
      skillsOnly: skillsOnly.map((id) => names.get(id) ?? id),
      uncovered: choice.uncovered.map((id) => names.get(id) ?? id),
      copyTargets: on
        .filter((tool) => !tool.followsLinks)
        .map((tool) => ({ tool: tool.name, folders: [...tool.skillDirs] })),
      warnings,
    };
  }

  /** The registry's skill-link rows, by their path. */
  #rows(): Array<[string, SkillLinkRow]> {
    return this.#deps.store
      .read((tx) => tx.registry.list(SKILL_LINK_KIND))
      .flatMap((record) => {
        const row = readRow(record);
        return row ? [[record.key, row] as [string, SkillLinkRow]] : [];
      });
  }

  /**
   * Whether each of the app's links in a folder leads to a SKILL.md that can be read: through the link, as a tool
   * reads. In a copy-mode folder, the copies, and the ones edited where they are.
   */
  async #folder(path: string, copy: boolean, rows: ReadonlyArray<[string, SkillLinkRow]>): Promise<DoctorFolder> {
    const { fs, paths } = this.#deps;
    const inFolder = rows.filter(([, row]) => (row.checkout ?? null) === null && paths.same(row.folder, path));
    const here = inFolder.filter(([, row]) => row.status === 'linked');
    const unreadable: string[] = [];
    for (const [dest, row] of here) {
      // The link's own path: under a local prefix it has the local name (PLAN.md §3.3).
      const skillMd = paths.join(dest, 'SKILL.md') as AbsPath;
      try {
        await fs.readBytes(skillMd);
      } catch {
        unreadable.push(row.skill);
      }
    }
    const changed = inFolder.filter(([, row]) => row.status === 'copy-changed').map(([, row]) => row.skill);
    return { path, links: here.length, unreadable: unreadable.sort(), copy, changed: changed.sort() };
  }

  #invalidNames(enabled: readonly ResolvedTool[]): InvalidName[] {
    const snapshot = this.#deps.snapshot();
    const prefix = snapshot?.config.prefix ?? null;
    if (!snapshot || prefix === null) return [];
    const strict = enabled.filter((tool) => STRICT_TOOLS.includes(tool.id)).map((tool) => tool.name);
    const all = enabled.map((tool) => tool.name);
    const out: InvalidName[] = [];
    for (const skill of snapshot.skills) {
      const problems: InvalidName['problems'][number][] = [];
      if (skill.name === null) problems.push('name.missing');
      else {
        problems.push(...skillNameProblems(skill.name, prefix));
        if (skill.name !== skill.folder) problems.push('name.folder');
      }
      if (problems.length === 0) continue;
      // A name that differs from its folder isn't linked at all; the other problems may stop a strict tool.
      const tools = problems.some((p) => p === 'name.folder' || p === 'name.missing') ? all : strict;
      out.push({ folder: skill.folder, name: skill.name, problems, tools: [...tools].sort() });
    }
    return out.sort((a, b) => (a.folder < b.folder ? -1 : 1));
  }
}
