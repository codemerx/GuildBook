// Imports in the worker (IMPLEMENTATION.md Step 13, PLAN.md §3.18): the import service wired to the guarded file
// system, git (a URL is cloned with the library's sign-in, an SSH URL with the user's agent), the zip reader, the trash
// and the link check, and the instance API's import calls.
import {
  AddImportedSkills,
  type ActivityLog,
  type Archive,
  CancelImport,
  type Clock,
  type FileSystem,
  type Git,
  type GitRepo,
  type HostCredentials,
  ImportFileQuery,
  ImportOffersQuery,
  ImportService,
  ImportSessionQuery,
  type InstanceEngine,
  type InstanceTrash,
  KeepOriginal,
  type LibrarySnapshot,
  type Links,
  type Logger,
  type PathFlavour,
  type Random,
  RenameImportSkill,
  ReplaceOriginal,
  ReviewImportSkill,
  SaveImportFile,
  StartImport,
  type Store,
} from '@app/core';
import type { Handlers, InstanceApi } from '@app/ipc';

/** Core's results are deeply readonly; the contracts' views are the same shapes without the modifier. */
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
const view = <T>(value: T): Mutable<T> => value as Mutable<T>;

export interface WorkerImportsDeps {
  readonly engine: InstanceEngine;
  readonly fs: FileSystem;
  readonly links: Links;
  readonly paths: PathFlavour;
  readonly git: Pick<Git, 'clone' | 'importSource'>;
  readonly archive: Archive;
  readonly store: Store;
  readonly random: Random;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly activity: ActivityLog;
  readonly trash: InstanceTrash;
  readonly credentials: Pick<HostCredentials, 'gitAuth'>;
  readonly repo: Pick<GitRepo, 'defaultBranch' | 'listTree'>;
  readonly dataFolder: string;
  readonly libraryRoot: () => string;
  readonly snapshot: () => LibrarySnapshot | null;
  readonly skillsChanged: (reason: string) => void;
  readonly onChange: () => void;
}

type ImportQueries = 'importSession' | 'importFile' | 'importOffers';
type ImportCommands =
  | 'startImport'
  | 'reviewImportSkill'
  | 'renameImportSkill'
  | 'saveImportFile'
  | 'addImportedSkills'
  | 'cancelImport'
  | 'replaceOriginal'
  | 'keepOriginal';

export class WorkerImports {
  readonly service: ImportService;
  readonly #deps: WorkerImportsDeps;

  constructor(deps: WorkerImportsDeps) {
    this.#deps = deps;
    this.service = new ImportService({
      ...deps,
      // An SSH URL uses the user's own agent and SSH config; an https URL the library's sign-in for its host, if any
      // (PLAN.md §3.18 A).
      auth: async (url) => (url.transport === 'ssh' ? { kind: 'ssh-agent' } : deps.credentials.gitAuth(url.url)),
      // In the company version: the server's company branch, as the last fetch saw it, has the skill (§3.18 B).
      inCompany: async (skill) => {
        const branch = (await deps.repo.defaultBranch().catch(() => null)) ?? 'main';
        const entries = await deps.repo.listTree(`origin/${branch}`, `skills/${skill}`).catch(() => []);
        return entries.some((entry) => entry.path === `skills/${skill}/SKILL.md`);
      },
    });
  }

  handlers(): {
    queries: Pick<Handlers<InstanceApi>['queries'], ImportQueries>;
    commands: Pick<Handlers<InstanceApi>['commands'], ImportCommands>;
  } {
    const { engine } = this.#deps;
    return {
      queries: {
        importSession: async () => view(await engine.query(ImportSessionQuery, {})),
        importFile: ({ id, path }) => engine.query(ImportFileQuery, { id, path }),
        importOffers: async () => view(await engine.query(ImportOffersQuery, {})),
      },
      commands: {
        startImport: async (source, context) =>
          view(
            await engine.execute(StartImport, source, {
              signal: context.signal,
              onProgress: (progress) => context.progress(progress),
            }),
          ),
        reviewImportSkill: async ({ id }) => view(await engine.execute(ReviewImportSkill, { id })),
        renameImportSkill: async (input) => view(await engine.execute(RenameImportSkill, input)),
        saveImportFile: (input) => engine.execute(SaveImportFile, input),
        addImportedSkills: async ({ ids }) => view(await engine.execute(AddImportedSkills, { ids })),
        cancelImport: async () => {
          await engine.execute(CancelImport, {});
          return {};
        },
        replaceOriginal: async ({ skill }) => {
          await engine.execute(ReplaceOriginal, { skill });
          return {};
        },
        keepOriginal: async ({ skill }) => {
          await engine.execute(KeepOriginal, { skill });
          return {};
        },
      },
    };
  }
}
