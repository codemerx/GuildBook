// The editor's part of the worker (IMPLEMENTATION.md Step 10): the library's files, version history and "What the agent
// sees", wired to the link engine: a created or renamed skill gets its links, and a rename moves its placement choices.
import {
  AddSkillFile,
  type AbsPath,
  agentView,
  AgentViewQuery,
  CreateSkill,
  DeleteSkillFile,
  editablePath,
  FileHistory,
  type FileSystem,
  type GitRepo,
  HistoryQuery,
  type InstanceEngine,
  INSTRUCTIONS_PATH,
  type LibrarySnapshot,
  LibraryFiles,
  type Logger,
  type PathFlavour,
  ReadLibraryFile,
  RenameSkill,
  RestoreVersion,
  SaveLibraryFile,
  SkillFilesQuery,
  VersionTextQuery,
} from '@app/core';
import type { Handlers, InstanceApi } from '@app/ipc';
import type { WorkerLinks } from './links.ts';

export interface WorkerEditingDeps {
  readonly engine: InstanceEngine;
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly logger: Logger;
  readonly libraryRoot: () => string;
  readonly snapshot: () => LibrarySnapshot | null;
  readonly repo: GitRepo;
  readonly links: WorkerLinks;
}

type EditorQueries = 'libraryFile' | 'skillFiles' | 'history' | 'versionText' | 'agentView';
type EditorCommands =
  'saveFile' | 'createSkill' | 'addSkillFile' | 'deleteSkillFile' | 'renameSkill' | 'restoreVersion';

/** History is kept of a skill's folder or of the instructions file. */
function historyPath(path: string): boolean {
  if (path === INSTRUCTIONS_PATH) return true;
  const target = editablePath(`${path}/SKILL.md`);
  return target?.kind === 'skill' && path.split('/').length === 2;
}

export class WorkerEditing {
  readonly files: LibraryFiles;
  readonly history: FileHistory;
  readonly #deps: WorkerEditingDeps;

  constructor(deps: WorkerEditingDeps) {
    this.#deps = deps;
    const { engine, fs, paths, links } = deps;
    this.files = new LibraryFiles({
      engine,
      fs,
      paths,
      logger: deps.logger,
      root: deps.libraryRoot,
      snapshot: deps.snapshot,
      renamed: (from, to) => links.service.skillRenamed(from, to),
      skillsChanged: (reason) => links.check(reason),
      record: (entry) => links.activity.append([entry]),
    });
    this.history = new FileHistory({
      engine,
      repo: () => deps.repo,
      // A skill's folder or the instructions for the history; one of their files for a past version's text.
      allowed: (path) => historyPath(path) || editablePath(path) !== null,
      removeFile: async (path) => {
        const file = paths.join(deps.libraryRoot(), ...path.split('/')) as AbsPath;
        if ((await fs.lstat(file))?.kind === 'file') await fs.remove(file);
      },
      restored: () => links.check('version restored'),
      record: (entry) => links.activity.append([entry]),
    });
    engine.handleQuery(AgentViewQuery, ({ skill }) => {
      const { tools, enabled } = links.service.toolsSnapshot();
      const on = new Set(enabled);
      return agentView(
        {
          fs,
          paths,
          tools: () => tools.filter((tool) => on.has(tool.id)).map((tool) => tool.name),
          links: (name) => links.service.linksOf(name),
        },
        skill,
      );
    });
  }

  handlers(): {
    queries: Pick<Handlers<InstanceApi>['queries'], EditorQueries>;
    commands: Pick<Handlers<InstanceApi>['commands'], EditorCommands>;
  } {
    const { engine } = this.#deps;
    return {
      queries: {
        libraryFile: ({ path }) => engine.query(ReadLibraryFile, { path }),
        skillFiles: async ({ skill }) => [...(await engine.query(SkillFilesQuery, { skill }))],
        history: async ({ path }) => [...(await engine.query(HistoryQuery, { path }))],
        versionText: ({ commit, path }) => engine.query(VersionTextQuery, { commit, path }),
        agentView: async ({ skill }) =>
          (await engine.query(AgentViewQuery, { skill })).map((view) => ({
            tool: view.tool,
            places: view.places.map((place) => ({ ...place })),
            seen: view.seen && { ...view.seen },
          })),
      },
      commands: {
        saveFile: ({ path, text, base }) => engine.execute(SaveLibraryFile, { path, text, base }),
        createSkill: (input) => engine.execute(CreateSkill, { ...input }),
        addSkillFile: (input) => engine.execute(AddSkillFile, input),
        deleteSkillFile: async ({ path }) => {
          await engine.execute(DeleteSkillFile, { path });
          return {};
        },
        renameSkill: ({ from, to }) => engine.execute(RenameSkill, { from, to }),
        restoreVersion: async ({ path, commit }) => {
          await engine.execute(RestoreVersion, { path, commit });
          return {};
        },
      },
    };
  }
}
