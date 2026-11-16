// A setup while its instance is *pending* (IMPLEMENTATION.md §2.1): the wizard's sign-in, folder and download pages,
// and for a new library the prefix page and the first push (PLAN.md §3.17). It runs in the setup's own worker, keeps
// its state in memory, and writes only into the temporary download folder main recorded. When it's done, it hands the
// library over: main renames the download into place and records the instance, which is then *setting up*.
// For a new library "the download" is complete once the first commit is pushed: only then does the library have its
// id, which names its data folder.
import {
  agentSkillNameProblems,
  type GitIdentityValue,
  GitIdentitySchema,
  type HostAccount,
  type HostCredential,
  LIBRARY_FILE,
  prefixProblems,
  type SetupFolderChoice,
  type SetupHandoff,
  type SetupIntent,
  type SignInMethod,
} from '@app/schemas';
import type { Clock } from '../../ports/clock.ts';
import type { DeviceServices } from '../../ports/device-services.ts';
import type { Platform } from '../../ports/env.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Git, GitProgress } from '../../ports/git.ts';
import type { DeviceCode, Host, HostEndpoint, HostKind, HostProbe } from '../../ports/host.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Random } from '../../ports/random.ts';
import type { Volumes } from '../../ports/volumes.ts';
import { type GitUrl, newLibraryId } from '../../library/index.ts';
import {
  clashOf,
  type LocalPrefixContext,
  localPrefixCandidates,
  type LocalPrefixProblem,
  localPrefixProblem,
  prefixesUsedByFolders,
  shorterSuggestion,
  suggestLocalPrefix,
  tooLongUnder,
} from '../../projection/index.ts';
import type { Role } from '../../review/index.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import { checkDownloadedLibrary } from '../domain/downloaded-library.ts';
import { defaultLibraryFolder, libraryName } from '../domain/library-url.ts';
import { type LocationCheck, neededBytes } from '../domain/location.ts';
import { checkEmptyRepo, FIRST_COMMIT_MESSAGE, newLibraryFiles, type RootEntry } from '../domain/new-library.ts';
import { hostAccess, keyRole } from './access.ts';
import type { HostCredentials } from './credentials.ts';
import { checkFolder } from './folder.ts';
import { credentialFor, type SignInRequest } from './sign-in.ts';

export type SetupStep = 'signIn' | 'folder' | 'download' | 'prefix' | 'localPrefix' | 'done';

/** A local prefix checked against the device (PLAN.md §3.3), as the local-prefix page shows it while the user types. */
export interface LocalPrefixCheck {
  readonly prefix: string;
  readonly problem: LocalPrefixProblem | null;
  /** The library's skills that would go over 64 characters under it. */
  readonly tooLong: readonly string[];
  /** A shorter free prefix that fits them. */
  readonly shorter: string | null;
}

/** The local-prefix page (PLAN.md §3.3 step 1): why the git prefix can't be used here, and a suggestion. */
export interface LocalPrefixPage {
  readonly gitPrefix: string;
  readonly clash: { readonly kind: 'instance'; readonly name: string } | { readonly kind: 'folders' };
  readonly suggestion: string | null;
  readonly skills: number;
  readonly check: LocalPrefixCheck | null;
  /** The prefix chosen: the setup is done. */
  readonly chosen: string | null;
  /**
   * The user's own folders that start with the git prefix (PLAN.md §3.17 step 5), when they're what clashes: instead of
   * a local prefix, each can be moved or kept.
   */
  readonly folders: readonly string[];
  /** The answer for each of them: the setup is done without a local prefix. */
  readonly folderChoices: readonly SetupFolderChoice[] | null;
}

export type { SignInRequest } from './sign-in.ts';

export interface SignInInput {
  readonly method: SignInRequest;
  /** The commit author, when the host doesn't give one (plain servers, keys). */
  readonly identity?: GitIdentityValue | null | undefined;
  /** The user saw the warning that secrets are kept with weaker protection here (PLAN.md §2, A4.13). */
  readonly acceptWeakStorage?: boolean | undefined;
}

export type SetupOffer =
  /** The same library is connected under another URL: change that instance's URL instead (A4.4). */
  | { readonly kind: 'sameLibrary'; readonly instanceId: string; readonly name: string }
  /** Someone set up the repo first: join it instead (A4.6). */
  | { readonly kind: 'alreadySetUp' };

export interface SetupSnapshot {
  readonly id: string;
  readonly intent: SetupIntent;
  readonly url: string;
  /** What the pages show before cloning (A4.12): the library's name from the URL, its host and its repo. */
  readonly name: string;
  readonly host: string;
  readonly repo: string;
  readonly hostKind: HostKind | null;
  readonly selfHosted: boolean;
  /** Whether the device flow needs a client id typed in (a self-hosted server without one in the invite link). */
  readonly clientIdNeeded: boolean;
  /** The client id the invite link carried: the sign-in form has it filled in (PLAN.md §3.17 step 2). */
  readonly clientId: string | null;
  readonly methods: readonly SignInMethod[];
  readonly step: SetupStep;
  readonly signedIn: {
    readonly method: SignInMethod;
    readonly login: string | null;
    readonly role: Role | null;
    readonly identity: GitIdentityValue | null;
  } | null;
  readonly defaultFolder: string;
  readonly folder: LocationCheck | null;
  readonly download: { readonly phase: string; readonly percent: number | null } | null;
  readonly library: {
    readonly id: string;
    readonly prefix: string | null;
    readonly needsUpdate: 'formatTooNew' | 'appTooOld' | null;
  } | null;
  readonly offer: SetupOffer | null;
  /** Set when the library's git prefix is in use on this device already (Step 8). */
  readonly localPrefix: LocalPrefixPage | null;
  /** Why the last action stopped, for the page to show (PLAN.md's messages). */
  readonly error: {
    readonly code: string;
    readonly params: Readonly<Record<string, string | number | boolean | null>>;
  } | null;
  readonly weakStorage: boolean;
}

export interface ConnectedInstance {
  readonly id: string;
  readonly name: string;
  readonly gitUrl: string | null;
  readonly libraryPath: string;
  /** The effective prefix: the local one if set, else the git prefix. */
  readonly prefix: string | null;
}

export interface SetupSessionDeps {
  readonly id: string;
  readonly intent: SetupIntent;
  readonly url: GitUrl;
  readonly git: Git;
  readonly probe: HostProbe;
  readonly credentials: HostCredentials;
  readonly services: DeviceServices;
  readonly fs: FileSystem;
  readonly volumes: Volumes;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  readonly paths: PathFlavour;
  readonly platform: Platform;
  readonly home: string;
  readonly appVersion: string;
  readonly connected: () => readonly ConnectedInstance[];
  /** Every instance's added code repos (PLAN.md §3.9: not inside an added code repo). */
  readonly repos?: () => readonly string[];
  readonly toolFolders: ReadonlyArray<{ readonly tool: string; readonly path: string }>;
  /**
   * Every tool's skills folders, enabled or not (PLAN.md §3.3 "Detection"): only whether a folder name starts with a
   * prefix is looked at. Without them only the other instances count.
   */
  readonly skillFolders?: () => readonly string[];
  /** The client id an invite link carried (PLAN.md §3.17 step 2). */
  readonly inviteClientId?: string | null;
  /** The app's own client id for github.com or gitlab.com (PLAN.md §3.16), null where none is registered. */
  readonly builtInClientId: (endpoint: HostEndpoint) => string | null;
  readonly onChange: (snapshot: SetupSnapshot) => void;
}

export type DownloadOutcome =
  | { readonly kind: 'downloaded' }
  | { readonly kind: 'prefix' }
  | { readonly kind: 'localPrefix' }
  | { readonly kind: 'offer'; readonly offer: SetupOffer }
  | { readonly kind: 'refused'; readonly error: AppError };

export interface SetupResult {
  readonly libraryId: string;
  readonly prefix: string | null;
  /** The local prefix chosen on the local-prefix page (Step 8), else null. */
  readonly localPrefix: string | null;
  readonly handoff: SetupHandoff;
}

export class SetupSession {
  readonly #deps: SetupSessionDeps;
  #intent: SetupIntent;
  #endpoint: HostEndpoint | null = null;
  #step: SetupStep = 'signIn';
  #signedIn: SetupSnapshot['signedIn'] = null;
  #account: Omit<HostAccount, 'identity' | 'role' | 'roleCheckedAt'> | null = null;
  #defaultBranch: string | null = null;
  #sizeBytes: number | null = null;
  #remoteEmpty = false;
  #folder: LocationCheck | null = null;
  #downloadPath: string | null = null;
  #download: SetupSnapshot['download'] = null;
  #library: SetupSnapshot['library'] = null;
  #offer: SetupOffer | null = null;
  #localPrefix: LocalPrefixPage | null = null;
  #error: SetupSnapshot['error'] = null;
  #weakStorage = false;
  /** The default folder, once start() looked at the disk: a number is added when the folder exists. */
  #defaultFolder: string | null = null;
  /** This setup made the first commit, which a rejected push left on the local branch. */
  #committed = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: SetupSessionDeps) {
    this.#deps = deps;
    this.#intent = deps.intent;
  }

  get downloadPath(): string | null {
    return this.#downloadPath;
  }

  snapshot(): SetupSnapshot {
    const { url } = this.#deps;
    const endpoint = this.#endpoint;
    return {
      id: this.#deps.id,
      intent: this.#intent,
      url: url.url,
      name: libraryName(url),
      host: url.port === null ? url.host : `${url.host}:${url.port}`,
      repo: url.path,
      hostKind: endpoint?.kind ?? null,
      selfHosted: endpoint?.selfHosted ?? true,
      clientIdNeeded: endpoint !== null && endpoint.kind !== 'plain' && this.#deps.builtInClientId(endpoint) === null,
      clientId: this.#deps.inviteClientId ?? null,
      methods: this.#methods(),
      step: this.#step,
      signedIn: this.#signedIn,
      defaultFolder:
        this.#defaultFolder ?? defaultLibraryFolder(this.#deps.home, url, this.#deps.paths, (p) => this.#used(p)),
      folder: this.#folder,
      download: this.#download,
      library: this.#library,
      offer: this.#offer,
      localPrefix: this.#localPrefix,
      error: this.#error,
      weakStorage: this.#weakStorage,
    };
  }

  /** Finds the host behind the URL: its kind decides how to sign in (ADR 0016). */
  start(): Promise<SetupSnapshot> {
    return this.#run(async () => {
      const { url } = this.#deps;
      this.#weakStorage = (await this.#deps.services.facts()).secretStorage === 'weak';
      // ~/<brand.defaultLibraryFolderName>/<owner>, with a number added when that folder exists (PLAN.md §3.17 step 3).
      const existing = new Set<string>();
      for (let n = 1; n <= 100; n++) {
        const candidate = defaultLibraryFolder(
          this.#deps.home,
          url,
          this.#deps.paths,
          (p) => existing.has(p) || this.#used(p),
        );
        if (!(await this.#deps.fs.lstat(candidate as AbsPath))) {
          this.#defaultFolder = candidate;
          break;
        }
        existing.add(candidate);
      }
      if (url.transport === 'https') {
        const origin = `https://${url.port === null ? url.host : `${url.host}:${url.port}`}`;
        this.#endpoint = await this.#deps.probe.probe(origin);
      } else {
        // Over SSH the app has no token for an API: the key decides, as on a plain server (PLAN.md §3.11).
        this.#endpoint = { kind: 'plain', origin: `https://${url.host}`, apiBase: null, selfHosted: true };
      }
    });
  }

  signIn(input: SignInInput, options: { signal?: AbortSignal; onCode?: (code: DeviceCode) => void } = {}) {
    return this.#run(async () => {
      this.#expect('signIn');
      const endpoint = this.#endpointOrFail();
      if (this.#weakStorage && input.acceptWeakStorage !== true) throw new AppError('setup.weakStorageNotConfirmed');
      const identity = input.identity ? GitIdentitySchema.parse(input.identity) : null;
      const credential = await this.#credential(endpoint, input.method, options);
      await this.#deps.credentials.save(credential);
      try {
        await this.#checkAccess(endpoint, credential, identity, options.signal);
      } catch (error) {
        await this.#deps.credentials.remove();
        this.#signedIn = null;
        throw error;
      }
      if (this.#signedIn?.identity) this.#step = 'folder';
    });
  }

  /** The commit author, asked once on plain servers and with keys (PLAN.md §3.17 step 2). */
  setIdentity(identity: GitIdentityValue): Promise<SetupSnapshot> {
    return this.#run(async () => {
      this.#expect('signIn');
      if (!this.#signedIn) throw new AppError('setup.wrongStep', { step: 'signIn' });
      this.#signedIn = { ...this.#signedIn, identity: GitIdentitySchema.parse(identity) };
      this.#step = 'folder';
    });
  }

  checkFolder(path: string): Promise<SetupSnapshot> {
    return this.#run(async () => {
      this.#expect('folder');
      this.#folder = await this.#checkFolder(path);
    });
  }

  /** Clones into `downloadPath` (next to `libraryPath`, recorded by main) and checks what arrived (PLAN.md §3.17 step 4). */
  download(
    input: { readonly libraryPath: string; readonly downloadPath: string },
    options: { signal?: AbortSignal; onProgress?: (progress: GitProgress) => void } = {},
  ): Promise<DownloadOutcome> {
    return this.#act(async () => {
      this.#expect('folder');
      const check = await this.#checkFolder(input.libraryPath);
      this.#folder = check;
      if (check.problems.length > 0)
        throw new AppError('setup.locationInvalid', { problem: check.problems[0]?.code ?? '' });
      this.#downloadPath = input.downloadPath;
      this.#step = 'download';
      this.#download = { phase: '', percent: null };
      this.#emit();
      try {
        await this.#deps.git.clone({
          url: this.#deps.url.url,
          dest: input.downloadPath as AbsPath,
          ...(options.signal ? { signal: options.signal } : {}),
          onProgress: (progress) => {
            this.#download = { phase: progress.phase, percent: progress.percent };
            options.onProgress?.(progress);
            this.#emit();
          },
        });
      } catch (error) {
        await this.#discard();
        throw error;
      }
      return this.#intent === 'join' ? this.#joinCheck(options.signal) : this.#emptyCheck();
    });
  }

  /** The prefix page (PLAN.md §3.2): library.yaml, .gitattributes and .gitignore, committed and pushed (A4.6). */
  createLibrary(prefix: string): Promise<DownloadOutcome> {
    return this.#act(async () => {
      this.#expect('prefix');
      const problems = prefixProblems(prefix);
      if (problems.length > 0) throw new AppError('setup.prefixInvalid', { problem: problems[0] ?? '' });
      const taken = this.#deps.connected().find((c) => c.prefix === prefix);
      if (taken) throw new AppError('setup.prefixInUse', { prefix, name: taken.name });
      const dir = this.#downloadOrFail();
      const repo = this.#deps.git.repo(dir);
      const gitignore = this.#deps.paths.join(dir, '.gitignore') as AbsPath;
      const existing = (await this.#deps.fs.lstat(gitignore)) ? await this.#deps.fs.readText(gitignore) : null;
      const id = newLibraryId(this.#deps.random);
      const files = newLibraryFiles({ id, prefix, existingGitignore: existing });
      for (const [name, text] of Object.entries(files)) {
        await this.#deps.fs.writeTextAtomic(this.#deps.paths.join(dir, name) as AbsPath, text);
      }
      const head = await repo.resolve('HEAD');
      const branch = head === null ? (this.#defaultBranch ?? 'main') : ((await repo.status()).branch ?? 'main');
      if (head === null) await repo.setUnbornBranch(branch);
      const identity = this.#signedIn?.identity;
      if (!identity) throw new AppError('setup.identityRequired');
      await repo.commit({ message: FIRST_COMMIT_MESSAGE, author: identity, paths: Object.keys(files) });
      this.#committed = true;
      const pushed = await repo.push({ branch, setUpstream: true }).catch((error: unknown) => {
        if (isAppError(error) && (error.code === 'git.forbidden' || error.code === 'git.authFailed')) {
          throw new AppError('setup.cannotWrite', { repo: this.#deps.url.path });
        }
        throw error;
      });
      if (pushed.kind === 'rejected') {
        if (pushed.reason === 'nonFastForward') {
          this.#offer = { kind: 'alreadySetUp' };
          return { kind: 'offer', offer: this.#offer };
        }
        throw new AppError('setup.cannotWrite', { repo: this.#deps.url.path });
      }
      this.#library = { id, prefix, needsUpdate: null };
      if (this.#signedIn && this.#signedIn.role === null) this.#signedIn = { ...this.#signedIn, role: 'maintainer' };
      this.#step = 'done';
      return { kind: 'downloaded' };
    });
  }

  /** Someone set the repo up first: join their library with the download already here (A4.6). */
  joinInstead(signal?: AbortSignal): Promise<DownloadOutcome> {
    return this.#act(async () => {
      if (this.#offer?.kind !== 'alreadySetUp') throw new AppError('setup.wrongStep', { step: this.#step });
      const repo = this.#deps.git.repo(this.#downloadOrFail());
      this.#intent = 'join';
      this.#offer = null;
      if (this.#committed) {
        // Our first commit lost the race: take theirs. reset --keep keeps nothing else, as nothing else is there.
        await repo.fetch(signal ? { signal } : {});
        const branch = (await repo.status()).branch ?? 'main';
        const theirs = await repo.resolve(`origin/${branch}`);
        if (theirs === null) throw new AppError('setup.notSetUp');
        await repo.resetKeep(theirs);
        this.#committed = false;
      }
      return this.#joinCheck(signal);
    });
  }

  /** The local-prefix page while the user types: the prefix checked against the device (PLAN.md §3.3). */
  checkLocalPrefix(prefix: string): Promise<SetupSnapshot> {
    return this.#run(async () => {
      this.#expect('localPrefix');
      const page = this.#localPrefix;
      if (!page) throw new AppError('setup.wrongStep', { step: this.#step });
      this.#localPrefix = { ...page, check: await this.#checkLocal(page.gitPrefix, prefix) };
    });
  }

  /**
   * The local prefix for this library on this device (PLAN.md §3.3 step 2). It follows §3.2's rules and is free on the
   * device; one that pushes names past 64 characters may still be chosen: those skills are skipped here.
   */
  chooseLocalPrefix(prefix: string): Promise<DownloadOutcome> {
    return this.#act(async () => {
      this.#expect('localPrefix');
      const page = this.#localPrefix;
      if (!page) throw new AppError('setup.wrongStep', { step: this.#step });
      const check = await this.#checkLocal(page.gitPrefix, prefix);
      this.#localPrefix = { ...page, check };
      const problem = check.problem;
      if (problem?.code === 'rules') throw new AppError('localPrefix.invalid', { problem: problem.problem });
      if (problem?.code === 'git-prefix') throw new AppError('localPrefix.invalid', { problem: 'git-prefix' });
      if (problem)
        throw new AppError('localPrefix.inUse', { prefix, name: problem.code === 'instance' ? problem.name : '' });
      this.#localPrefix = { ...this.#localPrefix, chosen: prefix };
      this.#step = 'done';
      return { kind: 'downloaded' };
    });
  }

  /**
   * [Move my folder] or [Keep it] for each of the user's own folders that start with the git prefix (PLAN.md §3.17
   * step 5): the library keeps its git prefix here. The choices are only recorded; [Finish] moves the folders.
   */
  chooseFolders(choices: readonly SetupFolderChoice[]): Promise<DownloadOutcome> {
    return this.#act(async () => {
      this.#expect('localPrefix');
      const page = this.#localPrefix;
      if (!page || page.folders.length === 0) throw new AppError('setup.wrongStep', { step: this.#step });
      const { paths, fs } = this.#deps;
      const byPath = new Map(choices.map((c) => [paths.normalize(c.path), c]));
      if (byPath.size !== page.folders.length || page.folders.some((f) => !byPath.has(paths.normalize(f)))) {
        throw new AppError('setup.folderInvalid', { problem: 'missing' });
      }
      const prefixes = [
        page.gitPrefix,
        ...this.#deps.connected().flatMap((c) => (c.prefix === null ? [] : [c.prefix])),
      ];
      const names = new Map<string, Set<string>>();
      const out: SetupFolderChoice[] = [];
      for (const folder of page.folders) {
        const choice = byPath.get(paths.normalize(folder));
        if (!choice) continue;
        if (choice.choice === 'keep') {
          out.push({ path: folder, choice: 'keep', name: null });
          continue;
        }
        const name = choice.name?.trim() ?? '';
        if (
          agentSkillNameProblems(name).length > 0 ||
          prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}-`))
        ) {
          throw new AppError('links.nameInvalid', { name });
        }
        const dir = paths.dirname(folder);
        const taken = names.get(dir) ?? new Set(await fs.list(dir as AbsPath));
        if (taken.has(name)) throw new AppError('links.pathTaken', { path: paths.join(dir, name) });
        taken.add(name);
        names.set(dir, taken);
        out.push({ path: folder, choice: 'move', name });
      }
      this.#localPrefix = { ...page, folderChoices: out };
      this.#step = 'done';
      return { kind: 'downloaded' };
    });
  }

  /** What main needs to record the instance and start its own worker. */
  result(): SetupResult {
    if (this.#step !== 'done' || !this.#library || !this.#account || !this.#signedIn?.identity) {
      throw new AppError('setup.wrongStep', { step: this.#step });
    }
    return {
      libraryId: this.#library.id,
      prefix: this.#library.prefix,
      localPrefix: this.#localPrefix?.chosen ?? null,
      handoff: {
        intent: this.#intent,
        account: {
          ...this.#account,
          identity: this.#signedIn.identity,
          role: this.#signedIn.role,
          roleCheckedAt: this.#deps.clock.now(),
        },
        needsUpdate: this.#library.needsUpdate,
        folders: [...(this.#localPrefix?.folderChoices ?? [])],
      },
    };
  }

  // ---- Steps ------------------------------------------------------------------------------------------------------

  #credential(
    endpoint: HostEndpoint,
    method: SignInRequest,
    options: { signal?: AbortSignal; onCode?: (code: DeviceCode) => void },
  ): Promise<HostCredential> {
    return credentialFor({
      endpoint,
      transport: this.#deps.url.transport,
      method,
      host: (e) => this.#host(e),
      clock: this.#deps.clock,
      builtInClientId: this.#deps.builtInClientId,
      ...options,
    });
  }

  async #checkAccess(
    endpoint: HostEndpoint,
    credential: HostCredential,
    identity: GitIdentityValue | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const { url } = this.#deps;
    let role: Role | null = null;
    let login: string | null = null;
    let hostIdentity: GitIdentityValue | null = null;
    const token =
      credential.method === 'device' ? credential.accessToken : credential.method === 'token' ? credential.token : null;
    if (token !== null && endpoint.kind !== 'plain') {
      const access = await hostAccess(this.#host(endpoint), token, url.path, signal);
      role = access.role;
      login = access.account.login;
      this.#defaultBranch = access.defaultBranch;
      this.#sizeBytes = access.sizeBytes;
      if (access.account.email)
        hostIdentity = { name: access.account.name ?? access.account.login, email: access.account.email };
      if (this.#intent === 'create' && role !== 'maintainer' && role !== 'admin') {
        throw new AppError('setup.cannotWrite', { repo: url.path });
      }
    }
    // git itself must get in too: this also proves a key or a token for a plain server, and finds an empty repo.
    const refs = await this.#deps.git.lsRemote(url.url, signal ? { signal } : {}).catch((error: unknown) => {
      if (isAppError(error) && error.code === 'git.authFailed') throw new AppError('host.unauthorized');
      if (isAppError(error) && error.code === 'git.notFound') throw new AppError('host.noAccess', { repo: url.path });
      throw error;
    });
    this.#remoteEmpty = refs.branches.length === 0;
    if (this.#intent === 'join' && this.#remoteEmpty) throw new AppError('setup.notSetUp');
    this.#defaultBranch ??= refs.head;
    this.#account = {
      host: endpoint.kind,
      origin: url.transport === 'https' ? endpoint.origin : null,
      selfHosted: endpoint.selfHosted,
      method: credential.method,
      clientId: credential.method === 'device' && endpoint.selfHosted ? credential.clientId : null,
      login,
    };
    this.#signedIn = { method: credential.method, login, role, identity: identity ?? hostIdentity };
  }

  async #checkFolder(path: string): Promise<LocationCheck> {
    const { paths } = this.#deps;
    const others = this.#deps.connected();
    return checkFolder(
      path,
      {
        platform: this.#deps.platform,
        paths,
        home: this.#deps.home,
        toolFolders: this.#deps.toolFolders,
        libraries: others.map((c) => ({ name: c.name, path: c.libraryPath })),
        repos: this.#deps.repos?.() ?? [],
        neededBytes: neededBytes(this.#sizeBytes),
      },
      { fs: this.#deps.fs, volumes: this.#deps.volumes },
    );
  }

  /** Joining: library.yaml decides (PLAN.md §3.17 step 4). */
  async #joinCheck(signal?: AbortSignal): Promise<DownloadOutcome> {
    const dir = this.#downloadOrFail();
    const file = this.#deps.paths.join(dir, LIBRARY_FILE) as AbsPath;
    const text = (await this.#deps.fs.lstat(file)) ? await this.#deps.fs.readText(file) : null;
    const checked = checkDownloadedLibrary(text, this.#deps.appVersion, this.#deps.connected());
    switch (checked.kind) {
      case 'sameLibrary':
        await this.#discard();
        this.#offer = { kind: 'sameLibrary', instanceId: checked.instanceId, name: checked.name };
        return { kind: 'offer', offer: this.#offer };
      case 'notSetUp':
        return this.#refuse(new AppError('setup.notSetUp'));
      case 'idInvalid':
        return this.#refuse(new AppError('setup.idInvalid'));
      case 'needsUpdate':
        if (checked.id === null) return this.#refuse(new AppError('setup.needsUpdate', { reason: checked.reason }));
        this.#library = { id: checked.id, prefix: checked.prefix, needsUpdate: checked.reason };
        break;
      case 'ok':
        this.#library = { id: checked.id, prefix: checked.prefix, needsUpdate: null };
        break;
    }
    if (this.#signedIn && this.#signedIn.role === null) {
      const repo = this.#deps.git.repo(dir);
      const branch = (await repo.status()).branch ?? 'main';
      this.#signedIn = { ...this.#signedIn, role: await keyRole(repo, branch, this.#deps.random, signal) };
    }
    // The git prefix may be in use on this device already: by another instance, or the user's own folders
    // (PLAN.md §3.3 "Detection"). Then this library needs a local prefix before anything else.
    const gitPrefix = this.#library.prefix;
    if (gitPrefix !== null && this.#library.needsUpdate === null) {
      const url = { host: this.#deps.url.host, path: this.#deps.url.path };
      const candidates = localPrefixCandidates(gitPrefix, url);
      const context = await this.#prefixContext(gitPrefix, [gitPrefix, ...candidates]);
      const clash = clashOf(context);
      if (clash) {
        const suggestion = suggestLocalPrefix(candidates, context);
        const skills = await this.#skillFolders();
        this.#localPrefix = {
          gitPrefix,
          clash,
          suggestion,
          skills: skills.length,
          check: suggestion === null ? null : await this.#checkLocal(gitPrefix, suggestion),
          chosen: null,
          folders: clash.kind === 'folders' ? await this.#ownFolders(gitPrefix) : [],
          folderChoices: null,
        };
        this.#step = 'localPrefix';
        return { kind: 'localPrefix' };
      }
    }
    this.#step = 'done';
    return { kind: 'downloaded' };
  }

  /** The other instances' effective prefixes, and which of `candidates` the user's own folders use. */
  async #prefixContext(gitPrefix: string, candidates: readonly string[]): Promise<LocalPrefixContext> {
    const used = await prefixesUsedByFolders(
      this.#deps.fs,
      this.#deps.paths,
      this.#deps.skillFolders?.() ?? [],
      candidates,
    );
    return {
      gitPrefix,
      instances: this.#deps.connected().flatMap((c) => (c.prefix === null ? [] : [{ prefix: c.prefix, name: c.name }])),
      folderUses: (prefix) => used.has(prefix),
    };
  }

  async #checkLocal(gitPrefix: string, prefix: string): Promise<LocalPrefixCheck> {
    const url = { host: this.#deps.url.host, path: this.#deps.url.path };
    const shorter = Array.from({ length: Math.max(0, prefix.length - 3) }, (_, i) =>
      prefix.slice(0, prefix.length - 1 - i),
    );
    const context = await this.#prefixContext(gitPrefix, [
      gitPrefix,
      prefix,
      ...shorter,
      ...localPrefixCandidates(gitPrefix, url),
    ]);
    const problem = localPrefixProblem(prefix, context);
    const skills = await this.#skillFolders();
    const tooLong = problem?.code === 'rules' ? [] : tooLongUnder(skills, gitPrefix, prefix);
    return {
      prefix,
      problem,
      tooLong,
      shorter: tooLong.length > 0 ? shorterSuggestion(prefix, skills, context, url) : null,
    };
  }

  /** The user's own folders in the tools' skills folders that start with the prefix (PLAN.md §3.3 "Detection"). */
  async #ownFolders(prefix: string): Promise<string[]> {
    const { fs, paths } = this.#deps;
    const out: string[] = [];
    for (const dir of this.#deps.skillFolders?.() ?? []) {
      if ((await fs.lstat(dir as AbsPath))?.kind !== 'dir') continue;
      for (const name of await fs.list(dir as AbsPath)) {
        if (name === prefix || name.startsWith(`${prefix}-`)) out.push(paths.join(dir, name));
      }
    }
    return [...new Set(out)].sort();
  }

  /** The skill folders of the download. */
  async #skillFolders(): Promise<string[]> {
    const dir = this.#deps.paths.join(this.#downloadOrFail(), 'skills') as AbsPath;
    if ((await this.#deps.fs.lstat(dir))?.kind !== 'dir') return [];
    return (await this.#deps.fs.list(dir)).sort();
  }

  /** Creating: the repo must be empty but for a README, LICENSE or .gitignore (PLAN.md §3.17 Admin step 1). */
  async #emptyCheck(): Promise<DownloadOutcome> {
    const dir = this.#downloadOrFail();
    const entries: RootEntry[] = [];
    for (const name of await this.#deps.fs.list(dir)) {
      if (name === '.git') continue;
      const entry = await this.#deps.fs.lstat(this.#deps.paths.join(dir, name) as AbsPath);
      entries.push({ name, kind: entry?.kind === 'dir' ? 'dir' : entry?.kind === 'file' ? 'file' : 'other' });
    }
    const empty = checkEmptyRepo(entries);
    if (empty.kind === 'notEmpty')
      return this.#refuse(new AppError('setup.notEmpty', { examples: empty.examples.join(', ') }));
    if (empty.kind === 'setUp') {
      this.#offer = { kind: 'alreadySetUp' };
      this.#step = 'prefix';
      return { kind: 'offer', offer: this.#offer };
    }
    this.#step = 'prefix';
    return { kind: 'prefix' };
  }

  async #refuse(error: AppError): Promise<DownloadOutcome> {
    await this.#discard();
    this.#error = { code: error.code, params: error.params };
    return { kind: 'refused', error };
  }

  /** The download goes; the setup is back on the folder page. */
  async #discard(): Promise<void> {
    const dir = this.#downloadPath;
    this.#downloadPath = null;
    this.#download = null;
    this.#step = 'folder';
    if (dir && (await this.#deps.fs.lstat(dir as AbsPath))) await this.#deps.fs.removeTree(dir as AbsPath);
  }

  #used(path: string): boolean {
    return this.#deps.connected().some((c) => this.#deps.paths.same(c.libraryPath, path));
  }

  #methods(): SignInMethod[] {
    if (this.#deps.url.transport === 'ssh') return ['ssh-agent', 'ssh-key'];
    if (!this.#endpoint) return [];
    return this.#endpoint.kind === 'plain' ? ['token'] : ['device', 'token'];
  }

  #host(endpoint: HostEndpoint): Host {
    return this.#deps.probe.host(endpoint);
  }

  #endpointOrFail(): HostEndpoint {
    if (!this.#endpoint) throw new AppError('setup.wrongStep', { step: 'start' });
    return this.#endpoint;
  }

  #downloadOrFail(): AbsPath {
    if (!this.#downloadPath) throw new AppError('setup.wrongStep', { step: this.#step });
    return this.#downloadPath as AbsPath;
  }

  #expect(step: SetupStep): void {
    if (this.#step !== step) throw new AppError('setup.wrongStep', { step: this.#step, expected: step });
  }

  #emit(): void {
    this.#deps.onChange(this.snapshot());
  }

  /** An action that reports the new state. */
  #run(action: () => Promise<void>): Promise<SetupSnapshot> {
    return this.#act(async () => {
      await action();
      return this.snapshot();
    });
  }

  /** One action at a time; each clears the last error, records a new one, and reports the new state. */
  #act<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(async () => {
      this.#error = null;
      try {
        return await action();
      } catch (error) {
        const known = isAppError(error) ? error : new AppError('internal', {}, String(error));
        this.#error = { code: known.code, params: known.params };
        throw known;
      } finally {
        this.#emit();
      }
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
