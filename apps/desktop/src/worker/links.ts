// The link engine in an instance's worker (IMPLEMENTATION.md Step 5): the link service wired to the worker's ports, its
// triggers (start, focus, every 3 minutes, and git or library changes; PLAN.md §3.8 "When"), its notifications in the
// user's language, and the instance API's link calls.
import {
  ActivityLog,
  AddRepo,
  AddRepoRoot,
  ApplyPlacement,
  type AppliedStateBaseline,
  type BaselineDiff,
  DismissSuggestion,
  type Git,
  LocateRepo,
  OverviewQuery,
  PlacementAnalysis,
  type PlacementNotice,
  PlacementService,
  PreviewPlacement,
  type WatchedRepo,
  AttentionQuery,
  CheckLinks,
  type Clock,
  FolderDifferences,
  type FileSystem,
  type GitRepo,
  type InstanceEngine,
  InstanceTrash,
  type LibrarySnapshot,
  type LinkNotice,
  LinkService,
  type Links,
  type Logger,
  osLinkStrategy,
  type PathFlavour,
  PreviewDecision,
  PreviewTools,
  type Random,
  ReconcileRunner,
  type FaultPoints,
  ResolveLink,
  RestoreFromTrash,
  RestoreSkill,
  Scheduler,
  SetTools,
  SkillLinksQuery,
  type Store,
  ToolsQuery,
  type ToolSettings,
  type AbsPath,
  CheckInstructions,
  DoctorQuery,
  DoctorService,
  type InstructionNotice,
  InstructionService,
  InstructionsQuery,
  PreviewInstruction,
  ResolveInstruction,
  ChangeLocalPrefix,
  CopyDifferences,
  type DevicePrefixes,
  LocalPrefixQuery,
  type OperationRunner,
  parseGitUrl,
  PreviewLocalPrefix,
  type ProjectionNotice,
  ProjectionService,
  ResolveCopy,
  type AttentionItem,
  CheckLocate,
  DownloadAgain,
  type LocationContext,
  LocateLibrary,
  PreviewRelocation,
  RecoverConnections,
  RecoveryQuery,
  RecoveryService,
  Relocate,
  RelocationQuery,
  RelocationService,
  RetryRelocation,
  type Volumes,
} from '@app/core';
import type {
  ActivityEntryView,
  ActivityFilter,
  Handlers,
  InstanceApi,
  ToolSettings as ToolSettingsWire,
} from '@app/ipc';
import type { Catalog } from '@app/tools';
import { translate } from '../shared/i18n.ts';

/** Core's results are deeply readonly; the contracts' views are the same shapes without the modifier. */
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
const view = <T>(value: T): Mutable<T> => value as Mutable<T>;

/** How many of the newest entries a filtered activity query looks through. */
const ACTIVITY_SCAN = 5000;

/** Whether an activity entry is about a skill: its path, or a git entry that lists it (PLAN.md §3.13 per-skill history). */
export function concernsSkill(event: { path: string | null; details: unknown }, skill: string): boolean {
  const folder = `skills/${skill}`;
  if (event.path !== null && (event.path === folder || event.path.startsWith(`${folder}/`))) return true;
  const details = event.details as Record<string, unknown> | null;
  if (!details || typeof details !== 'object') return false;
  if (details.skill === skill) return true;
  for (const key of ['skills', 'added', 'modified', 'removed', 'deleted']) {
    const list = details[key];
    if (Array.isArray(list) && list.includes(skill)) return true;
  }
  const renamed = details.renamed;
  if (
    Array.isArray(renamed) &&
    renamed.some((r) => (r as { from?: unknown; to?: unknown }).from === skill || (r as { to?: unknown }).to === skill)
  ) {
    return true;
  }
  return details.from === skill || details.to === skill;
}

/** The health check runs every 3 minutes (PLAN.md §3.8 "When"). */
export const CHECK_INTERVAL_MS = 3 * 60 * 1000;

export interface WorkerLinksDeps {
  readonly engine: InstanceEngine;
  readonly store: Store;
  readonly fs: FileSystem;
  readonly links: Links;
  readonly paths: PathFlavour;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  readonly faults: FaultPoints;
  readonly home: string;
  readonly dataFolder: string;
  /** Where the library is: it changes during a relocation (Step 9). */
  readonly libraryRoot: () => string;
  readonly catalog: () => Catalog;
  readonly snapshot: () => LibrarySnapshot | null;
  readonly repo: GitRepo;
  readonly baseline: AppliedStateBaseline;
  /** HEAD moved since the links were last adjusted (Step 11): the git screens announce another tool's change. */
  readonly baselineMoved?: (diff: BaselineDiff) => void;
  readonly deviceName: () => string;
  readonly active: () => boolean;
  /** Test mode: environment folders outside it are ignored, as the Environment refuses them (TESTING.md §3). */
  readonly testRoot: string | undefined;
  /** Live tests only (ADR 0033): the real home folder of a tool, which is outside the test root and still allowed. */
  readonly liveToolHome?: string | undefined;
  readonly notify: (notification: { kind: 'warning' | 'linksChanged'; title: string; body: string }) => void;
  /** Git for the user's code repos: only what PLAN.md §3.7 rule 4 allows (Step 6). */
  readonly git: Pick<Git, 'codeRepo'>;
  /** Runs `fn` holding a device-wide lock (IMPLEMENTATION.md §2.13 rule 8). */
  readonly lock: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** The repos changed: watch their worktree lists, and tell main their folders. */
  readonly onRepos?: (repos: readonly WatchedRepo[]) => void;
  readonly instanceId: string;
  /** Whether the company's instructions are linked on this device (device.json, through main; Step 7). */
  readonly instructionsLinked: () => boolean;
  /** The durable operations' runner (IMPLEMENTATION.md §2.6): the local prefix's changes run on it (Step 8). */
  readonly operations: OperationRunner;
  /** This instance's local prefix and the other instances' prefixes, in main's device.json (Step 8). */
  readonly prefixes: DevicePrefixes;
  /** The library's URL, for the local prefix's suggestion (PLAN.md §3.3). */
  readonly gitUrl: () => string | null;
  /**
   * The prefix change (Step 14), once it's built: the gate before every link check, the prefix the owned instruction
   * files keep while a change waits for a local prefix, and that change for "Needs attention".
   */
  readonly prefix?: () =>
    | {
        gate(): Promise<'ok' | 'waiting'>;
        readonly heldPrefix: string | null;
        readonly waiting: { readonly from: string; readonly to: string; readonly since: number } | null;
      }
    | undefined;
  /** Relocation and S9 (Step 9, PLAN.md §3.9): the worker's parts, and the location check's context from main. */
  readonly relocation: {
    readonly volumes: Volumes;
    readonly journalDir: string;
    readonly repo: (folder: string) => Pick<GitRepo, 'state' | 'status' | 'remoteUrl'>;
    readonly clone: (dest: string) => Promise<void>;
    readonly location: () => Promise<Omit<LocationContext, 'neededBytes'>>;
    readonly pause: () => Promise<void>;
    readonly useRoot: (root: string) => void;
    readonly setLibraryPath: (path: string) => Promise<void>;
    readonly restart: () => void;
    readonly forceCopy?: () => boolean;
  };
}

/** A projected copy's notice in the user's language (PLAN.md §3.19 "Notifications"). */
export function projectionNoticeText(notice: ProjectionNotice): { kind: 'warning'; title: string; body: string } {
  if (notice.type === 'both-changed') {
    return {
      kind: 'warning',
      title: translate('notifications.bothChanged.title', { skill: notice.skill }),
      body: translate('notifications.bothChanged.body', { skill: notice.skill }),
    };
  }
  const key = notice.reason === 'too-long' ? 'nameTooLong' : 'wrongPrefix';
  return {
    kind: 'warning',
    title: translate(`notifications.${key}.title`, { skill: notice.skill }),
    body: translate(`notifications.${key}.body`, { skill: notice.skill }),
  };
}

/** An instruction notice in the user's language (PLAN.md §3.19 "Notifications"). */
export function instructionNoticeText(notice: InstructionNotice): { kind: 'warning'; title: string; body: string } {
  const tools = notice.tools.join(', ');
  return {
    kind: 'warning',
    title: translate(`notifications.instructions.${notice.type}.title`, { tools }),
    body: translate(`notifications.instructions.${notice.type}.body`, { tools, file: notice.file }),
  };
}

/** A placement notice in the user's language (PLAN.md §3.19 "Notifications"). */
export function placementNoticeText(notice: PlacementNotice): { kind: 'warning'; title: string; body: string } {
  switch (notice.type) {
    case 'repo-missing':
      return {
        kind: 'warning',
        title: translate('notifications.repoMissing.title', { repo: notice.repo }),
        body: translate('notifications.repoMissing.body', { repo: notice.repo, path: notice.path }),
      };
    case 'tag-gone':
      return {
        kind: 'warning',
        title: translate('notifications.tagGone.title', { tag: notice.tag }),
        body: translate('notifications.tagGone.body', { tag: notice.tag, repos: notice.repos.join(', ') }),
      };
  }
}

/** A notice in the user's language (PLAN.md §3.19 "Notifications"). */
export function noticeText(notice: LinkNotice): { kind: 'warning' | 'linksChanged'; title: string; body: string } {
  switch (notice.type) {
    case 'warning': {
      const tools = notice.tools.join(', ');
      return {
        kind: 'warning',
        title: translate(`notifications.warning.${notice.status}.title`, { skill: notice.skill, tools }),
        body: translate(`notifications.warning.${notice.status}.body`, { skill: notice.skill, tools }),
      };
    }
    case 'renamed':
      return {
        kind: 'linksChanged',
        title: translate('notifications.renamed.title', { from: notice.from, to: notice.to }),
        body: translate(notice.author ? 'notifications.renamed.bodyBy' : 'notifications.renamed.body', {
          from: notice.from,
          to: notice.to,
          author: notice.author ?? '',
        }),
      };
    case 'removed':
      return {
        kind: 'linksChanged',
        title: translate('notifications.removed.title', { skill: notice.skill }),
        body: translate('notifications.removed.body', { skill: notice.skill }),
      };
    case 'library-missing':
      return {
        kind: 'warning',
        title: translate('notifications.libraryMissing.title'),
        body: translate('notifications.libraryMissing.body'),
      };
    case 'moved': {
      const where = (w: { global: boolean; repos: readonly string[] }) =>
        w.global
          ? translate('notifications.moved.everywhere')
          : w.repos.length > 0
            ? w.repos.join(', ')
            : translate('notifications.moved.nowhere');
      const lines = notice.moves.map((move) =>
        translate('notifications.moved.line', { skill: move.skill, from: where(move.from), to: where(move.to) }),
      );
      return {
        kind: 'linksChanged',
        title: translate('notifications.moved.title', { count: notice.moves.length }),
        body: lines.join('\n'),
      };
    }
  }
}

export class WorkerLinks {
  readonly service: LinkService;
  readonly instructions: InstructionService;
  readonly doctor: DoctorService;
  readonly placement: PlacementService;
  readonly projection: ProjectionService;
  readonly relocation: RelocationService;
  readonly recovery: RecoveryService;
  readonly trash: InstanceTrash;
  readonly activity: ActivityLog;
  readonly #deps: WorkerLinksDeps;
  readonly #scheduler: Scheduler;
  #settings: ToolSettings = { customTools: [], toolFolders: {}, homeEnv: {} };
  #prefixes: string[] = [];
  #libraries: string[] = [];

  constructor(deps: WorkerLinksDeps) {
    this.#deps = deps;
    const { paths } = deps;
    this.trash = new InstanceTrash({
      fs: deps.fs,
      store: deps.store,
      clock: deps.clock,
      random: deps.random,
      paths,
      logger: deps.logger,
      dir: paths.join(deps.dataFolder, 'trash') as AbsPath,
    });
    this.activity = new ActivityLog({ store: deps.store, clock: deps.clock, device: deps.deviceName });
    const runner = new ReconcileRunner({
      store: deps.store,
      faults: deps.faults,
      clock: deps.clock,
      logger: deps.logger,
    });
    // Placement (Step 6) decides where each skill goes; the link engine applies it.
    this.placement = new PlacementService({
      engine: deps.engine,
      store: deps.store,
      fs: deps.fs,
      git: deps.git,
      runner,
      activity: this.activity,
      paths,
      clock: deps.clock,
      random: deps.random,
      logger: deps.logger,
      links: () => this.service,
      snapshot: deps.snapshot,
      libraryFolders: () => [deps.libraryRoot(), ...this.#libraries],
      lock: deps.lock,
      notify: (notice) => deps.notify(placementNoticeText(notice)),
      ...(deps.onRepos ? { onRepos: deps.onRepos } : {}),
    });
    // Projected copies under a local prefix (Step 8): the links point at them; the library keeps the git names.
    this.projection = new ProjectionService({
      engine: deps.engine,
      runner,
      operations: deps.operations,
      store: deps.store,
      fs: deps.fs,
      links: deps.links,
      trash: this.trash,
      activity: this.activity,
      paths,
      clock: deps.clock,
      logger: deps.logger,
      dataFolder: deps.dataFolder,
      libraryRoot: deps.libraryRoot,
      snapshot: deps.snapshot,
      repo: deps.repo,
      gitUrl: () => {
        const url = deps.gitUrl();
        const parsed = url === null ? null : parseGitUrl(url);
        return parsed?.ok ? { host: parsed.value.host, path: parsed.value.path } : null;
      },
      skillFolders: () => this.#skillFolders(),
      device: deps.prefixes,
      reconcile: {
        links: async () => {
          await this.service.checkNow((event) => deps.engine.events.emit(event));
        },
        instructions: async () => {
          await this.instructions.checkNow((event) => deps.engine.events.emit(event));
        },
      },
      notify: (notice) => deps.notify(projectionNoticeText(notice)),
    });
    this.service = new LinkService({
      engine: deps.engine,
      runner,
      store: deps.store,
      fs: deps.fs,
      links: deps.links,
      strategy: osLinkStrategy(deps.links),
      trash: this.trash,
      activity: this.activity,
      paths,
      clock: deps.clock,
      logger: deps.logger,
      home: deps.home,
      libraryRoot: deps.libraryRoot,
      catalog: deps.catalog,
      toolSettings: () => this.#settings,
      prefixesInUse: () => this.#prefixes,
      snapshot: deps.snapshot,
      repo: deps.repo,
      baseline: deps.baseline,
      notify: (notice) => deps.notify(noticeText(notice)),
      active: deps.active,
      placement: this.placement,
      projection: this.projection,
      instanceItems: () => this.#instanceItems(),
      prefixGate: async () => (await deps.prefix?.()?.gate()) ?? 'ok',
      ...(deps.baselineMoved ? { baselineMoved: deps.baselineMoved } : {}),
      // Copy mode (Step 16): the copies' markers name this instance, and copies leave the ignored files out.
      instanceId: deps.instanceId,
      ignored: (paths) => deps.repo.ignored(paths),
    });
    // The company's instructions (Step 7): the same triggers as the link check.
    this.instructions = new InstructionService({
      engine: deps.engine,
      runner,
      store: deps.store,
      fs: deps.fs,
      trash: this.trash,
      activity: this.activity,
      paths,
      clock: deps.clock,
      logger: deps.logger,
      home: deps.home,
      instanceId: deps.instanceId,
      libraryRoot: deps.libraryRoot,
      catalog: deps.catalog,
      toolSettings: () => this.#settings,
      enabled: () => this.service.toolsSnapshot().enabled,
      snapshot: deps.snapshot,
      repo: deps.repo,
      linked: deps.instructionsLinked,
      lock: deps.lock,
      notify: (notice) => deps.notify(instructionNoticeText(notice)),
      active: deps.active,
      // Owned files and the blocks' markers follow the local prefix (PLAN.md §3.3), and keep the old prefix while a
      // prefix change waits for a local one (Step 14).
      prefix: () =>
        this.projection.localPrefix ?? deps.prefix?.()?.heldPrefix ?? deps.snapshot()?.config.prefix ?? null,
    });
    // Relocation and S9 (Step 9, PLAN.md §3.9): a durable operation; the link engine and the instructions do step 5.
    const r = deps.relocation;
    this.relocation = new RelocationService({
      engine: deps.engine,
      operations: deps.operations,
      fs: deps.fs,
      links: deps.links,
      volumes: r.volumes,
      paths,
      logger: deps.logger,
      trash: this.trash,
      activity: this.activity,
      journalDir: r.journalDir,
      libraryId: deps.instanceId,
      libraryRoot: deps.libraryRoot,
      gitUrl: deps.gitUrl,
      repo: r.repo,
      clone: r.clone,
      location: r.location,
      linkEngine: {
        retarget: (from, to) => this.service.retarget(from, to),
        libraryPresent: () => this.service.libraryPresent(),
      },
      instructions: {
        rewrite: () => this.instructions.rewriteImports((event) => deps.engine.events.emit(event)),
      },
      worker: { pause: r.pause, useRoot: r.useRoot, setLibraryPath: r.setLibraryPath, restart: r.restart },
      ...(r.forceCopy ? { forceCopy: r.forceCopy } : {}),
    });
    // [Recover connections] (PLAN.md §3.5): the registry rebuilt from the links on disk.
    this.recovery = new RecoveryService({
      engine: deps.engine,
      store: deps.store,
      fs: deps.fs,
      links: deps.links,
      paths,
      clock: deps.clock,
      logger: deps.logger,
      activity: this.activity,
      home: deps.home,
      catalog: deps.catalog,
      toolSettings: () => this.#settings,
      libraryRoot: deps.libraryRoot,
      projectionRoot: this.projection.root,
      snapshot: deps.snapshot,
      naming: () => this.projection.naming(),
      placement: this.placement,
      check: (emit) => this.service.checkNow(emit),
      instanceId: deps.instanceId,
    });
    this.doctor = new DoctorService({
      engine: deps.engine,
      fs: deps.fs,
      paths,
      store: deps.store,
      snapshot: deps.snapshot,
      tools: () => this.service.toolsSnapshot(),
      nested: () => this.placement.analysis(),
      repoName: (id) => this.placement.repoName(id),
      instructions: () => this.instructions.view(),
    });
    this.#scheduler = new Scheduler(deps.clock);
  }

  /** The tool settings main sent; variables pointing outside the test root are dropped in test mode. */
  setToolSettings(settings: ToolSettingsWire): void {
    const { testRoot, liveToolHome, paths } = this.#deps;
    const homeEnv = Object.fromEntries(
      Object.entries(settings.homeEnv).filter(
        ([, value]) =>
          testRoot === undefined ||
          (paths.isAbsolute(value) &&
            (paths.isInside(testRoot, paths.normalize(value)) ||
              (liveToolHome !== undefined && paths.same(paths.normalize(value), liveToolHome)))),
      ),
    );
    this.#settings = { customTools: settings.customTools, toolFolders: settings.toolFolders, homeEnv };
    this.#prefixes = settings.prefixesInUse;
    this.#libraries = settings.libraryFolders;
    this.#folders = undefined;
  }

  /** Every tool's skills folders, enabled or not: the local prefix looks at their names (PLAN.md §3.3). */
  #skillFolders(): readonly string[] {
    const catalog = this.#deps.catalog();
    if (this.#folders?.catalog !== catalog) {
      const { testRoot, liveToolHome, paths } = this.#deps;
      const liveSkills = liveToolHome === undefined ? undefined : paths.join(liveToolHome, 'skills');
      const folders = this.service
        .toolsSnapshot()
        .tools.flatMap((tool) => tool.skillDirs)
        .filter(
          (dir) =>
            testRoot === undefined ||
            paths.isInside(testRoot, dir) ||
            (liveSkills !== undefined && paths.same(dir, liveSkills)),
        );
      this.#folders = { catalog, folders: [...new Set(folders)].sort() };
    }
    return this.#folders.folders;
  }

  #folders: { catalog: Catalog; folders: readonly string[] } | undefined;

  /** What the guarded file system lets the reconcilers reach (IMPLEMENTATION.md §2.10). */
  roots(): { entries: string[]; exact: string[]; lists: string[]; made: string[] } {
    const links = this.service.roots();
    const placement = this.placement.roots();
    const instructions = this.instructions.roots();
    const projection = this.projection.roots();
    const recovery = this.recovery.roots();
    // Each list is joined again only when one of its own parts changed: the guard keeps a lookup per array, and asks
    // at every file operation. A folder made during an apply changes `made`, never the 27,000 entries (Step 17).
    return {
      entries: this.#entries([links.entries, placement.entries, instructions.entries, recovery.entries]),
      exact: this.#exact([links.exact, placement.exact, instructions.exact, projection.exact, recovery.exact]),
      lists: this.#lists([placement.lists, projection.lists, recovery.lists]),
      made: links.made,
    };
  }

  readonly #entries = joinedOnce();
  readonly #exact = joinedOnce();
  readonly #lists = joinedOnce();

  /** The instance-wide items of "Needs attention" (Step 9): connections lost with the database, a move that stopped. */
  #instanceItems(): AttentionItem[] {
    const item = (id: string, kind: AttentionItem['kind'], since: number, reason: string | null): AttentionItem => ({
      id,
      kind,
      skill: null,
      dest: null,
      folder: null,
      tools: [],
      reason,
      takenBy: null,
      since,
      repoId: null,
      repo: null,
      tag: null,
      repos: [],
    });
    const items: AttentionItem[] = [];
    const recovery = this.recovery.state();
    if (recovery.needed) items.push(item('connections', 'connections-lost', recovery.since ?? 0, null));
    const stopped = this.relocation.stopped;
    if (stopped) items.push(item('relocation', 'relocation-unfinished', this.#deps.clock.now(), stopped.to));
    // A new git prefix that clashes here waits for a local prefix (Step 14): reason is the new one, takenBy the old.
    const waiting = this.#deps.prefix?.()?.waiting;
    if (waiting) items.push({ ...item('prefix', 'prefix-waiting', waiting.since, waiting.to), takenBy: waiting.from });
    return items;
  }

  /** Asks for a health check; checks asked while one waits join it (background commands coalesce, §2.4). */
  check(reason: string): void {
    if (!this.#deps.active()) return;
    this.#deps.engine.execute(CheckLinks, {}).catch((error: unknown) => {
      if (!LinkService.quiet(error)) this.#deps.logger.warn('link check failed', { reason, error: String(error) });
    });
    this.checkInstructions(reason);
  }

  /** Asks for an instruction check, e.g. when the device's choice of linked instructions changed. */
  checkInstructions(reason: string): void {
    if (!this.#deps.active()) return;
    this.#deps.engine.execute(CheckInstructions, {}).catch((error: unknown) => {
      if (!InstructionService.quiet(error))
        this.#deps.logger.warn('instruction check failed', { reason, error: String(error) });
    });
  }

  start(): void {
    this.#scheduler.every(CHECK_INTERVAL_MS, () => this.check('timer'));
  }

  stop(): void {
    this.#scheduler.stopAll();
  }

  /** Removing the instance: a reconcile to an empty desired state (IMPLEMENTATION.md §2.6). Runs inside a command. */
  async removeAll(): Promise<number> {
    // The instruction files, blocks and OpenCode entry (A7.13), then the links.
    const instructions = await this.instructions.removeAll();
    return instructions + (await this.service.removeAll());
  }

  /**
   * The activity log, newest first (PLAN.md §3.13), filtered by kind, skill and date (Step 11): the timeline, a skill's
   * own history, and "what changed since yesterday".
   */
  /** The Doctor report, for main's Export diagnostics (Step 16). */
  async doctorReport() {
    return view(await this.#deps.engine.query(DoctorQuery, {}));
  }

  activityView(filter: ActivityFilter = {}): ActivityEntryView[] {
    const limit = filter.limit ?? 200;
    // "Since yesterday" by the worker's clock, which tests move (TESTING.md §6): from 00:00 UTC the day before.
    const day = 24 * 60 * 60 * 1000;
    const since = filter.sinceYesterday ? Math.floor(this.#deps.clock.now() / day) * day - day : filter.since;
    const trash = new Map(this.trash.list().map((entry) => [entry.id, entry]));
    const kinds = filter.kinds && filter.kinds.length > 0 ? new Set(filter.kinds) : null;
    const filtered = kinds !== null || filter.skill !== undefined || since !== undefined || filter.until !== undefined;
    const events = this.activity
      .list({ limit: filtered ? ACTIVITY_SCAN : limit })
      .filter((event) => kinds === null || kinds.has(event.kind))
      .filter((event) => since === undefined || event.ts >= since)
      .filter((event) => filter.until === undefined || event.ts < filter.until)
      .filter((event) => filter.skill === undefined || concernsSkill(event, filter.skill))
      .slice(0, limit);
    return events.map((event) => {
      const details = event.details as Record<string, unknown> | null;
      const trashId = details && typeof details.trashId === 'string' ? details.trashId : null;
      const entry = trashId ? trash.get(trashId) : undefined;
      return {
        id: event.id,
        ts: event.ts,
        kind: event.kind,
        path: event.path,
        author: event.author,
        details: event.details,
        trash: entry
          ? { id: entry.id, state: entry.state, expiresAt: entry.expiresAt, originalPath: entry.originalPath }
          : null,
      };
    });
  }

  handlers(): {
    queries: Pick<
      Handlers<InstanceApi>['queries'],
      | 'tools'
      | 'previewTools'
      | 'previewDecision'
      | 'skillLinks'
      | 'attention'
      | 'activity'
      | 'folderDifferences'
      | 'overview'
      | 'previewPlacement'
      | 'placementAnalysis'
      | 'instructions'
      | 'previewInstruction'
      | 'doctor'
      | 'localPrefix'
      | 'previewLocalPrefix'
      | 'copyDifferences'
      | 'previewRelocation'
      | 'relocation'
      | 'checkLocate'
      | 'recovery'
    >;
    commands: Pick<
      Handlers<InstanceApi>['commands'],
      | 'setTools'
      | 'resolveLink'
      | 'restoreSkill'
      | 'restoreFromTrash'
      | 'checkLinks'
      | 'addRepo'
      | 'addRepoRoot'
      | 'applyPlacement'
      | 'locateRepo'
      | 'dismissSuggestion'
      | 'resolveInstruction'
      | 'checkInstructions'
      | 'changeLocalPrefix'
      | 'resolveCopy'
      | 'relocate'
      | 'retryRelocation'
      | 'locateLibrary'
      | 'downloadAgain'
      | 'recoverConnections'
    >;
  } {
    const { engine } = this.#deps;
    return {
      queries: {
        tools: async () => view(await engine.query(ToolsQuery, {})),
        previewTools: async ({ enabled }) => view(await engine.query(PreviewTools, { enabled })),
        previewDecision: async ({ dest, decision }) => view(await engine.query(PreviewDecision, { dest, decision })),
        skillLinks: async () => view(await engine.query(SkillLinksQuery, {})),
        attention: async () => view(await engine.query(AttentionQuery, {})),
        activity: (filter) => this.activityView(filter),
        folderDifferences: ({ dest }) => engine.query(FolderDifferences, { dest }),
        overview: async () => view(await engine.query(OverviewQuery, {})),
        previewPlacement: async ({ edits }) => view(await engine.query(PreviewPlacement, { edits })),
        placementAnalysis: async () => view(await engine.query(PlacementAnalysis, {})),
        instructions: async () => view(await engine.query(InstructionsQuery, {})),
        previewInstruction: async ({ key, decision }) =>
          view(await engine.query(PreviewInstruction, { key, decision })),
        doctor: async () => view(await engine.query(DoctorQuery, {})),
        localPrefix: async () => view(await engine.query(LocalPrefixQuery, {})),
        previewLocalPrefix: async ({ prefix }) => view(await engine.query(PreviewLocalPrefix, { prefix })),
        copyDifferences: async ({ key, keep }) => view(await engine.query(CopyDifferences, { key, keep })),
        previewRelocation: async ({ to }) => {
          const preview = await engine.query(PreviewRelocation, { to });
          return {
            path: preview.path,
            problems: preview.problems.map(({ code, ...params }) => ({ code, params: view(params) })),
            warnings: preview.warnings.map(({ code, ...params }) => ({ code, params: view(params) })),
            method: preview.method,
            hash: preview.hash,
          };
        },
        relocation: async () => view(await engine.query(RelocationQuery, {})),
        checkLocate: async ({ path }) => {
          const check = await engine.query(CheckLocate, { path });
          return {
            path: check.path,
            problems: check.problems.map(({ code, ...params }) => ({ code, params: { ...params } })),
          };
        },
        recovery: () => engine.query(RecoveryQuery, {}),
      },
      commands: {
        setTools: ({ enabled, planHash }) => engine.execute(SetTools, { enabled, planHash }),
        resolveLink: ({ dest, decision, planHash }) => engine.execute(ResolveLink, { dest, decision, planHash }),
        restoreSkill: ({ skill }) => engine.execute(RestoreSkill, { skill }),
        restoreFromTrash: ({ id }) => engine.execute(RestoreFromTrash, { id }),
        checkLinks: () => engine.execute(CheckLinks, {}),
        addRepo: async ({ path }) => view(await engine.execute(AddRepo, { path })),
        addRepoRoot: async ({ path }) => view(await engine.execute(AddRepoRoot, { path })),
        applyPlacement: ({ edits, planHash }) => engine.execute(ApplyPlacement, { edits, planHash }),
        locateRepo: ({ repo, path }) => engine.execute(LocateRepo, { repo, path }),
        dismissSuggestion: async ({ repo, tag }) => {
          await engine.execute(DismissSuggestion, { repo, tag });
          return {};
        },
        resolveInstruction: ({ key, decision, planHash }) =>
          engine.execute(ResolveInstruction, { key, decision, planHash }),
        checkInstructions: () => engine.execute(CheckInstructions, {}),
        changeLocalPrefix: async ({ prefix, planHash }) =>
          view(await engine.execute(ChangeLocalPrefix, { prefix, planHash })),
        resolveCopy: async ({ key, keep, planHash }) =>
          view(await engine.execute(ResolveCopy, { key, keep, planHash })),
        relocate: async ({ to, planHash, copy }, context) =>
          view(
            await engine.execute(
              Relocate,
              { to, planHash, ...(copy === undefined ? {} : { copy }) },
              { onProgress: (progress) => context.progress(progress) },
            ),
          ),
        retryRelocation: async () => view(await engine.execute(RetryRelocation, {})),
        locateLibrary: async ({ path }) => view(await engine.execute(LocateLibrary, { path })),
        downloadAgain: async () => {
          await engine.execute(DownloadAgain, {});
          return {};
        },
        recoverConnections: async ({ repos }) => view(await engine.execute(RecoverConnections, { repos })),
      },
    };
  }
}

/** Joins arrays into one, and gives the same array again while every part is the same array. */
export function joinedOnce(): (parts: readonly (readonly string[])[]) => string[] {
  let last: { parts: readonly (readonly string[])[]; value: string[] } | undefined;
  return (parts) => {
    if (!last || last.parts.length !== parts.length || last.parts.some((part, i) => part !== parts[i]))
      last = { parts, value: parts.flat() };
    return last.value;
  };
}
