// Changing the library's location (PLAN.md §3.9) and S9 "Library folder moved outside the app" (§3.8): a durable
// operation on the operation runner (IMPLEMENTATION.md §2.6). The steps:
//   move     the same disk: one rename; another disk: copy to `<to>.partial`, verify, rename the copy
//   pointer  the same disk: a link at the old place to the new one, so every link works again at once
//   rewrite  every link of the app, and Claude Code's owned file, point at the new place (reconciler plans)
//   save     main records the new place in device.json
//   cleanup  the pointer goes; after a copy, changes made in the old folder meanwhile are carried over, and the old
//            folder goes to the trash (kept 7 days)
// Every step pauses the link checks, the watchers and write-back first, and checks what's on disk before it acts, so
// a crash at any point resumes at the next start. The worker starts again at the new place when the operation ends.
import { LIBRARY_FILE, readLibraryYaml } from '@app/schemas';
import type { ActivityLog, InstanceTrash } from '../../activity/index.ts';
import { defineCommand, defineQuery, type InstanceEngine } from '../../engine/index.ts';
import { parseGitUrl } from '../../library/index.ts';
import { mirrorFolder, type RetargetReport } from '../../links/index.ts';
import { checkLocation, type LocationContext, folderFacts, type LocationWarning } from '../../onboarding/index.ts';
import type { OperationDef, OperationRunner } from '../../operations/index.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { GitRepo } from '../../ports/git.ts';
import type { Links } from '../../ports/links.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Volumes } from '../../ports/volumes.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import { hashValue, sha256Hex } from '../../shared/hash.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import {
  carryOver,
  initialRelocationState,
  isGitPath,
  type Manifest,
  RELOCATION_OPERATION,
  type RelocationParams,
  type RelocationProblem,
  type RelocationState,
  type RelocationSummary,
  type RewrittenConnection,
  summarize,
} from '../domain/relocation.ts';

type NoInput = Record<string, never>;

export interface RelocationPreview {
  /** The new location, normalized. */
  readonly path: string;
  readonly problems: readonly RelocationProblem[];
  readonly warnings: readonly LocationWarning[];
  /** How the library will move: one rename on the same disk, or a copy to another disk. */
  readonly method: 'rename' | 'copy';
  /** Confirms exactly this preview (ADR 0008). */
  readonly hash: string;
}

/** What a folder picked for S9 [Locate folder…] is, checked before anything changes. */
export type LocateProblem =
  | { readonly code: 'relocation.notALibrary' }
  | { readonly code: 'relocation.otherLibrary'; readonly found: string }
  | { readonly code: 'relocation.otherRemote'; readonly remote: string }
  | { readonly code: 'relocation.notMissing' };

export interface LocateCheck {
  readonly path: string;
  readonly problems: readonly LocateProblem[];
}

export interface RelocationStatus {
  /** A move that's under way, or that stopped with an error and is tried again (PLAN.md §3.9 "Crash at any point"). */
  readonly unfinished: {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly error: { readonly code: string } | null;
  } | null;
}

export const PreviewRelocation = defineQuery<{ to: string }, RelocationPreview>('PreviewRelocation');
export const CheckLocate = defineQuery<{ path: string }, LocateCheck>('CheckLocate');
export const RelocationQuery = defineQuery<NoInput, RelocationStatus>('Relocation');
export const Relocate = defineCommand<{ to: string; planHash: string; copy?: boolean }, RelocationSummary>('Relocate');
export const LocateLibrary = defineCommand<{ path: string }, RelocationSummary>('LocateLibrary');
export const RetryRelocation = defineCommand<NoInput, RelocationSummary>('RetryRelocation');
export const DownloadAgain = defineCommand<NoInput, void>('DownloadAgain');

export interface RelocationServiceDeps {
  readonly engine: InstanceEngine;
  readonly operations: OperationRunner;
  readonly fs: FileSystem;
  /** The guarded Links port: the pointer, and links inside the library when it's copied. */
  readonly links: Links;
  readonly volumes: Volumes;
  readonly paths: PathFlavour;
  readonly logger: Logger;
  readonly trash: InstanceTrash;
  readonly activity: ActivityLog;
  /** The operation runner's journal folder: the copy's manifest waits there until cleanup. */
  readonly journalDir: string;
  /** The library's id: a folder holds this library when its library.yaml says so. */
  readonly libraryId: string;
  /** Where the worker's library is now. */
  readonly libraryRoot: () => string;
  readonly gitUrl: () => string | null;
  /** git in one folder: the library, its copy, or a folder the user picked. */
  readonly repo: (folder: string) => Pick<GitRepo, 'state' | 'status' | 'remoteUrl'>;
  /** Downloads the library again into a folder (S9 [Download again]). */
  readonly clone: (dest: string) => Promise<void>;
  /** The location check's context: the tool folders, the other libraries and every instance's repos (§3.9 step 0). */
  readonly location: () => Promise<Omit<LocationContext, 'neededBytes'>>;
  /** The link engine's part: the links rewritten in place, and whether the library folder is there. */
  readonly linkEngine: {
    retarget(from: string, to: string): Promise<RetargetReport>;
    libraryPresent(): Promise<boolean>;
  };
  /** The instructions' part: Claude Code's owned file imports the library's file by its path (§3.9 step 5). */
  readonly instructions: { rewrite(): Promise<RewrittenConnection[]> };
  /** The worker's part: pause the checks and watchers, read the library at another place, record it in device.json. */
  readonly worker: {
    pause(): Promise<void>;
    useRoot(root: string): void;
    setLibraryPath(path: string): Promise<void>;
    /** The worker starts again at the new place, once the command returned. */
    restart(): void;
  };
  /** Test seam (A9.2): the move copies, as across disks, even on one disk. */
  readonly forceCopy?: () => boolean;
}

/** The suffix of the copy on the other disk until it's verified (PLAN.md §3.9 step 3). */
const PARTIAL = '.partial';

export class RelocationService {
  readonly #deps: RelocationServiceDeps;
  /** The folders the user named for a preview or a locate: the guard lets the checks look at them. */
  readonly #looked = new Set<string>();
  /** The folders an unfinished move works in: the old and new place, and the copy. */
  #working: string[] = [];
  #busy = false;
  /** A move that stopped with an error: "Needs attention" offers [Try again]. */
  #stopped: { readonly from: string; readonly to: string; readonly code: string } | null = null;

  constructor(deps: RelocationServiceDeps) {
    this.#deps = deps;
    const { engine } = deps;
    deps.operations.register(this.#operation());
    engine.handleQuery(PreviewRelocation, ({ to }) => this.#preview(to));
    engine.handleQuery(CheckLocate, ({ path }) => this.#checkLocate(path));
    engine.handleQuery(RelocationQuery, () => this.status());
    engine.handle(Relocate, ({ to, planHash, copy }, context) =>
      this.#relocate(to, planHash, copy === true, (done, total) => context.progress(done, total)),
    );
    engine.handle(LocateLibrary, ({ path }) => this.#locate(path));
    engine.handle(RetryRelocation, () => this.#retry());
    engine.handle(DownloadAgain, () => this.#downloadAgain());
  }

  /** Whether a move is under way or unfinished: links, watchers and write-back wait until it ends. */
  get busy(): boolean {
    return this.#busy;
  }

  /** A move that stopped with an error, or null. */
  get stopped(): { readonly from: string; readonly to: string; readonly code: string } | null {
    return this.#stopped;
  }

  /** Reads the unfinished moves at start: their folders become reachable, and the links wait for the resume. */
  async load(): Promise<void> {
    const journal = await this.#journal();
    if (!journal) return;
    this.#busy = true;
    this.#working = this.#folders(journal.params as RelocationParams);
    this.#noteStopped(journal);
  }

  #noteStopped(journal: Awaited<ReturnType<RelocationService['journalOf']>>): void {
    const params = journal?.params as RelocationParams | undefined;
    this.#stopped =
      journal?.status === 'failed' && params
        ? { from: params.from, to: params.to, code: journal.error?.code ?? 'operation.failed' }
        : null;
  }

  /** The unfinished relocation journal, if any. */
  journalOf() {
    return this.#journal();
  }

  /** What the guard lets relocation reach besides the data folder and the library (IMPLEMENTATION.md §2.10). */
  roots(): { write: readonly string[]; read: readonly string[]; exact: readonly string[] } {
    // The same arrays while nothing changed: the guard keeps a lookup per array, and asks at every file operation.
    if (this.#roots?.working !== this.#working || this.#roots.looked !== this.#looked.size) {
      const { paths } = this.#deps;
      const looked = [...this.#looked];
      this.#roots = {
        working: this.#working,
        looked: this.#looked.size,
        value: {
          write: this.#working,
          read: [...this.#working, ...looked],
          // The new place's parent folder may be made, and its existence checked.
          exact: [...this.#working, ...looked].map((path) => paths.dirname(path)),
        },
      };
    }
    return this.#roots.value;
  }

  #roots:
    | {
        working: readonly string[];
        looked: number;
        value: { write: readonly string[]; read: readonly string[]; exact: readonly string[] };
      }
    | undefined;

  async status(): Promise<RelocationStatus> {
    const journal = await this.#journal();
    if (!journal) return { unfinished: null };
    const params = journal.params as RelocationParams;
    return {
      unfinished: {
        id: journal.id,
        from: params.from,
        to: params.to,
        error: journal.error ? { code: journal.error.code } : null,
      },
    };
  }

  async #journal() {
    return (await this.#deps.operations.journals()).find((j) => j.kind === RELOCATION_OPERATION && j.status !== 'done');
  }

  #folders(params: RelocationParams): string[] {
    const { paths } = this.#deps;
    return [params.from, params.to, `${paths.normalize(params.to)}${PARTIAL}`].map((p) => paths.normalize(p));
  }

  // ---- Pre-flight (PLAN.md §3.9 step 0) --------------------------------------------------------------------------

  async #preview(to: string): Promise<RelocationPreview> {
    const { paths } = this.#deps;
    const from = paths.normalize(this.#deps.libraryRoot());
    if (!paths.isAbsolute(to)) {
      return { path: to, problems: [{ code: 'location.notAbsolute' }], warnings: [], method: 'rename', hash: '' };
    }
    const target = paths.normalize(to);
    this.#looked.add(target);
    const method = await this.#method(from, target);
    const context = await this.#deps.location();
    // The library itself is a library the new place mustn't be inside (or hold).
    const libraries = [...context.libraries, { name: '', path: from }];
    const neededBytes = method === 'copy' ? await this.#size(from) : 0;
    const check =
      paths.same(from, target) || paths.isInside(from, target)
        ? { path: target, problems: [{ code: 'relocation.same' } as const], warnings: [] }
        : checkLocation(target, await folderFacts(target as AbsPath, this.#deps), {
            ...context,
            libraries,
            neededBytes,
          });
    const problems: RelocationProblem[] = [...check.problems];
    const state = await this.#deps
      .repo(from)
      .state()
      .catch(() => ({ operation: 'none' as const, busy: false }));
    if (state.operation !== 'none' || state.busy) {
      problems.push({ code: 'relocation.gitBusy', operation: state.busy ? 'busy' : state.operation });
    }
    const warnings = [...check.warnings];
    return { path: target, problems, warnings, method, hash: hashValue({ from, to: target, problems, method }) };
  }

  /** The same disk when both folders' disks are the same one; a disk the OS can't name is tried with a rename. */
  async #method(from: string, to: string): Promise<'rename' | 'copy'> {
    if (this.#deps.forceCopy?.()) return 'copy';
    const [a, b] = await Promise.all([
      this.#deps.volumes.info(from as AbsPath),
      this.#deps.volumes.info(to as AbsPath),
    ]);
    return a.device !== null && b.device !== null && a.device !== b.device ? 'copy' : 'rename';
  }

  async #size(root: string): Promise<number> {
    let total = 0;
    const visit = async (dir: string) => {
      for (const name of await this.#deps.fs.list(dir as AbsPath)) {
        const at = this.#deps.paths.join(dir, name);
        const entry = await this.#deps.fs.lstat(at as AbsPath);
        if (entry?.kind === 'dir') await visit(at);
        else if (entry) total += entry.size;
      }
    };
    await visit(root);
    return total;
  }

  // ---- The commands ----------------------------------------------------------------------------------------------

  async #relocate(
    to: string,
    planHash: string,
    copy: boolean,
    progress: (done: number, total: number) => void,
  ): Promise<RelocationSummary> {
    if (await this.#journal()) throw new AppError('relocation.unfinished');
    const preview = await this.#preview(to);
    if (preview.problems.length > 0) {
      throw new AppError('relocation.invalid', { problem: preview.problems[0]?.code ?? '' });
    }
    if (preview.hash !== planHash) throw new AppError('plan.changed', { kind: RELOCATION_OPERATION });
    const params: RelocationParams = {
      from: this.#deps.paths.normalize(this.#deps.libraryRoot()),
      to: preview.path,
      method: copy ? 'copy' : preview.method,
    };
    return this.#run(params, progress);
  }

  async #run(
    params: RelocationParams,
    progress: (done: number, total: number) => void = () => undefined,
  ): Promise<RelocationSummary> {
    this.#busy = true;
    this.#working = this.#folders(params);
    this.#progress = progress;
    return this.#finish(params, await this.#deps.operations.start(RELOCATION_OPERATION, params));
  }

  #progress: (done: number, total: number) => void = () => undefined;

  async #finish(
    params: RelocationParams,
    outcome: Awaited<ReturnType<OperationRunner['start']>>,
  ): Promise<RelocationSummary> {
    this.#progress = () => undefined;
    if (outcome.status === 'failed') {
      const journal = (await this.#deps.operations.journals()).find((j) => j.id === outcome.id);
      this.#noteStopped(journal);
      // Refused before anything moved (a rename Windows refused, a copy that didn't verify): nothing to resume.
      if (journal && journal.nextStep === 0 && (await this.#untouched(journal.params as RelocationParams))) {
        await this.#deps.operations.discard(outcome.id);
        this.#stopped = null;
        this.#busy = false;
        this.#working = [];
        this.#deps.worker.restart();
      }
      throw new AppError(isRelocationCode(outcome.error.code) ? outcome.error.code : 'operation.failed', {
        kind: RELOCATION_OPERATION,
        code: outcome.error.code,
      });
    }
    this.#busy = false;
    this.#stopped = null;
    // The worker starts again at the new place: its watchers, checks and timers resume there (§3.9 step 8).
    this.#deps.worker.restart();
    return summarize(params, outcome.state as unknown as RelocationState);
  }

  /**
   * After the unfinished operations resumed at start: a move that finished then lets the worker start again at the
   * new place; one that failed again keeps the links waiting, and [Try again] shows.
   */
  async afterResume(): Promise<void> {
    const journal = await this.#journal();
    this.#noteStopped(journal);
    if (!this.#busy || journal) return;
    this.#busy = false;
    this.#deps.worker.restart();
  }

  /** The old folder is still a whole library and nothing is at the new place but a partial copy. */
  async #untouched(params: RelocationParams): Promise<boolean> {
    const { fs, paths } = this.#deps;
    if (params.method === 'locate') return true;
    if ((await fs.lstat(params.from as AbsPath))?.kind !== 'dir') return false;
    return !(await fs.lstat(paths.join(params.to, LIBRARY_FILE) as AbsPath));
  }

  async #retry(): Promise<RelocationSummary> {
    const journal = await this.#journal();
    if (!journal) throw new AppError('relocation.notUnfinished');
    const params = journal.params as RelocationParams;
    this.#busy = true;
    this.#working = this.#folders(params);
    return this.#finish(params, await this.#deps.operations.resume(journal.id));
  }

  /** S9 [Locate folder…]: the folder must hold this very library, with the same remote (PLAN.md §3.8 S9 step 3). */
  async #checkLocate(path: string): Promise<LocateCheck> {
    const { paths, fs } = this.#deps;
    if (!paths.isAbsolute(path)) return { path, problems: [{ code: 'relocation.notALibrary' }] };
    const folder = paths.normalize(path);
    this.#looked.add(folder);
    const problems: LocateProblem[] = [];
    if (await this.#deps.linkEngine.libraryPresent()) problems.push({ code: 'relocation.notMissing' });
    const file = paths.join(folder, LIBRARY_FILE) as AbsPath;
    const text = (await fs.lstat(file))?.kind === 'file' ? await fs.readText(file) : null;
    const id = text === null ? null : (readLibraryYaml(text).value.id ?? null);
    if (text === null || id === null) problems.push({ code: 'relocation.notALibrary' });
    else if (id !== this.#deps.libraryId) problems.push({ code: 'relocation.otherLibrary', found: id });
    else {
      const remote = await this.#deps
        .repo(folder)
        .remoteUrl()
        .catch(() => '');
      if (!sameRemote(remote, this.#deps.gitUrl())) problems.push({ code: 'relocation.otherRemote', remote });
    }
    return { path: folder, problems };
  }

  async #locate(path: string): Promise<RelocationSummary> {
    if (await this.#journal()) throw new AppError('relocation.unfinished');
    const check = await this.#checkLocate(path);
    const problem = check.problems[0];
    if (problem)
      throw new AppError(problem.code, problem.code === 'relocation.otherLibrary' ? { found: problem.found } : {});
    const from = this.#deps.paths.normalize(this.#deps.libraryRoot());
    return this.#run({ from, to: check.path, method: 'locate' });
  }

  /**
   * S9 [Download again]: a fresh download into the configured place. The links point there, so they work again
   * unchanged; the worker starts again on the new download.
   */
  async #downloadAgain(): Promise<void> {
    if (await this.#deps.linkEngine.libraryPresent()) throw new AppError('relocation.notMissing');
    const root = this.#deps.libraryRoot();
    const { fs } = this.#deps;
    // An empty folder left at the place may stay: git clones into it.
    const there = await fs.lstat(root as AbsPath);
    if (there && (there.kind !== 'dir' || (await fs.list(root as AbsPath)).length > 0)) {
      throw new AppError('relocation.notMissing');
    }
    await this.#deps.clone(root);
    this.#deps.activity.append([{ kind: 'library-downloaded', path: null, details: { path: root } }]);
    this.#deps.worker.restart();
  }

  // ---- The durable operation -------------------------------------------------------------------------------------

  #operation(): OperationDef<RelocationParams, RelocationState> {
    const pause = async () => {
      this.#busy = true;
      await this.#deps.worker.pause();
    };
    return {
      kind: RELOCATION_OPERATION,
      retryFailed: true,
      initialState: () => initialRelocationState(),
      steps: [
        {
          name: 'move',
          run: async ({ params }) => {
            await pause();
            this.#progress(0, 4);
            return this.#move(params);
          },
        },
        {
          name: 'pointer',
          run: async ({ params, state }) => {
            await pause();
            this.#progress(1, 4);
            await this.#pointer(params, state);
          },
        },
        {
          name: 'rewrite',
          run: async ({ params }) => {
            await pause();
            this.#progress(2, 4);
            this.#deps.worker.useRoot(params.to);
            const links = await this.#deps.linkEngine.retarget(params.from, params.to);
            const owned = await this.#deps.instructions.rewrite();
            return { connections: [...links.retargeted, ...owned], skipped: [...links.skipped] };
          },
        },
        {
          name: 'save',
          run: async ({ params }) => {
            await pause();
            this.#deps.worker.useRoot(params.to);
            await this.#deps.worker.setLibraryPath(params.to);
          },
        },
        {
          name: 'cleanup',
          run: async ({ params, state }) => {
            await pause();
            this.#progress(3, 4);
            const kept = await this.#cleanup(params, state);
            const after = { ...state, ...kept };
            this.#deps.activity.append([
              {
                kind: 'library-moved',
                path: null,
                details: {
                  from: params.from,
                  to: params.to,
                  method: params.method,
                  files: after.files,
                  connections: after.connections.length,
                  skipped: after.skipped,
                  carried: after.carried,
                  keptBoth: after.keptBoth,
                },
              },
            ]);
            this.#progress(4, 4);
            return kept;
          },
        },
      ],
    };
  }

  /** Step 3: the folder moves in one rename, or is copied and verified; a repeat finds it moved already. */
  async #move(params: RelocationParams): Promise<Partial<RelocationState>> {
    const { fs, paths } = this.#deps;
    const { from, to } = params;
    if (params.method === 'locate') {
      if (!(await this.#holdsLibrary(to))) throw new AppError('relocation.notALibrary');
      return { moved: 'locate', files: await this.#count(to) };
    }
    if (await this.#holdsLibrary(to)) {
      // A repeat after a crash: the old folder tells how it moved (a copy leaves it whole until cleanup).
      const kept = (await fs.lstat(from as AbsPath))?.kind === 'dir';
      return { moved: kept ? 'copy' : 'rename', files: await this.#count(to) };
    }
    if (params.method === 'rename') {
      try {
        await this.#makeRoom(to);
        await fs.rename(from as AbsPath, to as AbsPath);
        return { moved: 'rename', files: await this.#count(to) };
      } catch (error) {
        if (codeOf(error) !== 'EXDEV') throw blocked(error);
        // Another disk after all: the copy below.
        this.#deps.logger.info('the rename crossed disks: copying instead');
      }
    }
    const partial = `${paths.normalize(to)}${PARTIAL}` as AbsPath;
    await mirrorFolder({ fs, links: this.#deps.links, paths }, from as AbsPath, partial);
    const [source, copy] = await Promise.all([this.#manifest(from), this.#manifest(partial)]);
    if (!sameManifest(source, copy)) throw new AppError('relocation.verifyFailed', { what: 'files' });
    const [before, after] = await Promise.all([this.#deps.repo(from).status(), this.#deps.repo(partial).status()]);
    if (JSON.stringify(before.entries) !== JSON.stringify(after.entries)) {
      throw new AppError('relocation.verifyFailed', { what: 'status' });
    }
    // What was copied: cleanup compares the old folder with it (step 7).
    await fs.writeTextAtomic(this.#manifestFile(), `${JSON.stringify(copy)}\n`);
    await this.#makeRoom(to);
    await fs.rename(partial, to as AbsPath);
    return { moved: 'copy', files: Object.keys(copy).filter((path) => !isGitPath(path)).length };
  }

  /** An empty folder at the new place makes way for the rename (Windows refuses to rename onto one). */
  async #makeRoom(to: string): Promise<void> {
    const { fs, paths } = this.#deps;
    const there = await fs.lstat(to as AbsPath);
    if (there?.kind === 'dir' && (await fs.list(to as AbsPath)).length === 0) await fs.remove(to as AbsPath);
    else if (!there) await fs.mkdirp(paths.dirname(to) as AbsPath);
  }

  /** Step 4: a link at the old place to the new one (a junction on Windows), after a rename only. */
  async #pointer(params: RelocationParams, state: RelocationState): Promise<void> {
    if ((state.moved === '' ? params.method : state.moved) !== 'rename') return;
    const { fs, links, paths } = this.#deps;
    const there = await fs.lstat(params.from as AbsPath);
    if (there?.kind === 'link') {
      const target = await links.readTarget(params.from as AbsPath);
      if (target !== undefined && paths.same(paths.normalize(target), params.to)) return;
      throw new AppError('relocation.pathTaken', { path: params.from });
    }
    if (there) throw new AppError('relocation.pathTaken', { path: params.from });
    await links.create(params.to as AbsPath, params.from as AbsPath);
  }

  /** Step 7: the pointer goes; after a copy, the old folder's late changes come over, and it goes to the trash. */
  async #cleanup(params: RelocationParams, state: RelocationState): Promise<Partial<RelocationState>> {
    const { fs, links, paths } = this.#deps;
    const there = await fs.lstat(params.from as AbsPath);
    const moved = state.moved === '' ? params.method : state.moved;
    if (moved === 'locate') return {};
    if (moved === 'rename' || there?.kind === 'link') {
      if (there?.kind === 'link') {
        const target = await links.readTarget(params.from as AbsPath);
        if (target !== undefined && paths.same(paths.normalize(target), params.to)) {
          await links.remove(params.from as AbsPath);
        }
      }
      return {};
    }
    const manifestFile = this.#manifestFile();
    if (there?.kind !== 'dir') {
      if (await fs.lstat(manifestFile)) await fs.remove(manifestFile);
      return {};
    }
    const base = (await fs.lstat(manifestFile))
      ? (JSON.parse(await fs.readText(manifestFile)) as Manifest)
      : await this.#manifest(params.to);
    const files = (manifest: Manifest) =>
      Object.fromEntries(Object.entries(manifest).filter(([path]) => !isGitPath(path)));
    const [old, now] = await Promise.all([this.#manifest(params.from), this.#manifest(params.to)]);
    const plan = carryOver(files(base), files(old), files(now));
    for (const path of plan.copy) {
      const source = paths.join(params.from, ...path.split('/')) as AbsPath;
      const dest = paths.join(params.to, ...path.split('/')) as AbsPath;
      await fs.mkdirp(paths.dirname(dest) as AbsPath);
      const entry = await fs.lstat(source);
      const here = await fs.lstat(dest);
      if (here?.kind === 'link') await fs.remove(dest);
      if (entry?.kind === 'link') {
        if (here?.kind === 'file') await fs.remove(dest);
        await links.create((await fs.readLink(source)) as AbsPath, dest);
      } else await fs.copyFile(source, dest);
    }
    for (const path of plan.remove) {
      const dest = paths.join(params.to, ...path.split('/')) as AbsPath;
      if (await fs.lstat(dest)) await fs.remove(dest);
    }
    if (plan.copy.length + plan.remove.length > 0) {
      this.#deps.logger.info('changes made in the old folder during the copy were carried over', {
        files: plan.copy.length + plan.remove.length,
      });
    }
    // The old folder keeps its versions of the files both places changed: it goes to the trash whole (7 days). On
    // another disk than the trash it's copied there, then removed.
    await this.#deps.trash.put(params.from as AbsPath, 'relocation', null).catch(async (error: unknown) => {
      if (codeOf(error) !== 'EXDEV') throw error;
      await this.#deps.trash.putCopy(params.from as AbsPath, 'relocation', null, {
        copy: (from, to) => mirrorFolder({ fs, links, paths }, from, to),
        removeOriginal: (folder) => this.#removeFiles(folder),
      });
    });
    await fs.remove(manifestFile);
    return { carried: [...plan.copy, ...plan.remove], keptBoth: [...plan.keepBoth] };
  }

  /** Removes a folder file by file, never through a link: only the data folder may lose a whole tree at once. */
  async #removeFiles(folder: string): Promise<void> {
    const { fs, paths } = this.#deps;
    for (const name of await fs.list(folder as AbsPath)) {
      const at = paths.join(folder, name) as AbsPath;
      if ((await fs.lstat(at))?.kind === 'dir') await this.#removeFiles(at);
      else await fs.remove(at);
    }
    await fs.removeEmptyFolder(folder as AbsPath);
  }

  /** Not a `.json` file: the runner reads only journals there. */
  #manifestFile(): AbsPath {
    return this.#deps.paths.join(this.#deps.journalDir, 'relocation.manifest') as AbsPath;
  }

  async #holdsLibrary(folder: string): Promise<boolean> {
    const file = this.#deps.paths.join(folder, LIBRARY_FILE) as AbsPath;
    if ((await this.#deps.fs.lstat(file))?.kind !== 'file') return false;
    return readLibraryYaml(await this.#deps.fs.readText(file)).value.id === this.#deps.libraryId;
  }

  async #count(root: string): Promise<number> {
    return Object.keys(await this.#manifest(root)).filter((path) => !isGitPath(path)).length;
  }

  /** Every file and link below a folder, by its path with forward slashes: its bytes' or its target's fingerprint. */
  async #manifest(root: string): Promise<Manifest> {
    const { fs, paths } = this.#deps;
    const out: Record<string, string> = {};
    const visit = async (relative: string) => {
      const dir = relative === '' ? root : paths.join(root, ...relative.split('/'));
      for (const name of await fs.list(dir as AbsPath)) {
        const child = relative === '' ? name : `${relative}/${name}`;
        const at = paths.join(dir, name) as AbsPath;
        const entry = await fs.lstat(at);
        if (entry?.kind === 'dir') await visit(child);
        else if (entry?.kind === 'link') out[child] = `link:${await fs.readLink(at)}`;
        else if (entry?.kind === 'file') out[child] = sha256Hex(await fs.readBytes(at));
      }
    };
    await visit('');
    return out;
  }
}

/** The relocation codes the renderer explains; anything else is "the move failed". */
function isRelocationCode(
  code: string,
): code is 'relocation.renameBlocked' | 'relocation.verifyFailed' | 'relocation.pathTaken' | 'relocation.notALibrary' {
  return (
    code === 'relocation.renameBlocked' ||
    code === 'relocation.verifyFailed' ||
    code === 'relocation.pathTaken' ||
    code === 'relocation.notALibrary'
  );
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

/** Windows refuses the rename while a program has a file inside open (PLAN.md §3.9 step 3). */
function blocked(error: unknown): unknown {
  if (isAppError(error)) return error;
  const code = codeOf(error);
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return new AppError('relocation.renameBlocked');
  return error;
}

function sameManifest(a: Manifest, b: Manifest): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Whether a folder's remote is the library's URL: the same host and path, whatever the transport. */
function sameRemote(remote: string, url: string | null): boolean {
  if (url === null) return true;
  const a = parseGitUrl(remote);
  const b = parseGitUrl(url);
  if (!a.ok || !b.ok) return remote === url;
  const key = (v: { host: string; path: string }) =>
    `${v.host.toLowerCase()}/${v.path.toLowerCase().replace(/\.git$/, '')}`;
  return key(a.value) === key(b.value);
}
