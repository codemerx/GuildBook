// The Git port on dugite (ADR 0013, IMPLEMENTATION.md §2.9). Each operation is one or a few git commands with
// machine-readable output, the flags that keep that output the same whatever the user's git config says, and the
// per-command environment of git-env.ts. Network commands ask for the credentials, the proxy and the certificate
// bundle of their URL just before they run.
import {
  AppError,
  type AbsPath,
  type Branch,
  type Clock,
  type CloneInput,
  type CodeRepoGit,
  type Commit,
  type CommitDetails,
  type CommitInput,
  type ConflictTake,
  type ConflictVersions,
  type ContinueOutcome,
  type DiffEnd,
  EMPTY_TREE,
  type FetchResult,
  type FileChange,
  type Git,
  type GitAuth,
  type GitCallOptions,
  type GitConflict,
  type GitIdentity,
  type GitRepo,
  type GitSigning,
  type GitTreeEntry,
  type ImportSourceGit,
  type IntegrateInput,
  type IntegrateOutcome,
  type LogOptions,
  type Logger,
  type MergeTreeResult,
  type Oid,
  type OperationHeads,
  type PathFlavour,
  type Platform,
  type PushInput,
  type PushOutcome,
  type RemoteBranch,
  type RemoteRefs,
  type RepoState,
  type RevertOutcome,
  type Stash,
  type StashApplyOutcome,
  type Status,
} from '@app/core';
import { existsSync, readFileSync } from 'node:fs';
import { classifyRejection, failure, remoteLines, wouldBeOverwritten } from './classify.ts';
import { type CommitIdentity, commandEnv, type GitNetwork, identityEnv, NETWORK_STALL_SECONDS } from './git-env.ts';
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  parseFetch,
  parseLog,
  parseLsRemote,
  parseLsTree,
  parseMergeTree,
  parseNameStatus,
  parsePush,
  parseRefs,
  parseStashList,
  parseStatus,
  parseWorktrees,
  STASH_FORMAT,
} from './parse.ts';
import { type GitRunRecord, GitRunner, type RunResult } from './runner.ts';

export interface DugiteGitOptions {
  readonly paths: PathFlavour;
  readonly platform: Platform;
  /** The device's variables git may see (HOME, PATH, GIT_CONFIG_GLOBAL in test mode, SSH_AUTH_SOCK, …). */
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The folders whose repos are libraries (the guard, §2.10). */
  readonly libraryRoots: () => readonly string[];
  /** Folders picked to import from, and the folder import URLs are cloned into (PLAN.md §3.18). */
  readonly importRoots?: () => readonly string[];
  /** A folder outside every repo, for commands that need none (the data folder's tmp/). */
  readonly neutralDir: AbsPath;
  /** Where an app-kept SSH key is written for one command. */
  readonly keyDir: AbsPath;
  /** The credentials for a URL, refreshed by the caller when they're about to expire (ADR 0014). */
  readonly credentials?: (url: string) => Promise<GitAuth>;
  /** The proxy and certificate bundle for a URL (ADR 0015). */
  readonly network?: (url: string) => Promise<GitNetwork>;
  /** Extra ssh options; test mode passes its own config and known-hosts file (TESTING.md §3). */
  readonly sshOptions?: readonly string[];
  /** Seconds without data before a command that talks to a server ends with an error; tests shorten it. */
  readonly stallSeconds?: number;
  readonly onRun?: (record: GitRunRecord) => void;
  /** Test mode: called with an app-kept key's temporary file while its command runs (A3.8). */
  readonly onKeyFile?: (file: string) => void;
  /**
   * How the commits made in this repo are signed, or null: asked by the commands that make commits, where the host
   * requires signed commits (PLAN.md §3.10 "Signing").
   */
  readonly signing?: (repo: string) => Promise<GitSigning | null>;
}

interface Call {
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: GitCallOptions['onProgress'];
  /** Exit codes that aren't failures; the caller reads the result. Defaults to 0 only. */
  readonly ok?: readonly number[];
  /** A command that talks to this URL: it gets the URL's credentials, proxy and certificate bundle. */
  readonly url?: string;
  /** The settings this command needs besides the pinned ones. */
  readonly config?: ReadonlyArray<readonly [string, string]>;
  /** A command that makes commits: they're signed when the repo's signing says so. */
  readonly sign?: boolean;
  /** Signs with this, whatever the repo's signing says ([Sign my unpushed commits and push again]). */
  readonly signing?: GitSigning;
  /** Signs in this way instead of with the URL's credentials (an import over SSH uses the user's agent). */
  readonly auth?: GitAuth;
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** A revision or path given to git as an argument must never read as an option. */
function plain(value: string, what: string): string {
  if (value === '' || value.startsWith('-') || value.includes('\0')) {
    throw new AppError('git.failed', { message: `invalid ${what}`, exitCode: -1 });
  }
  return value;
}

const text = (result: RunResult) => result.stdout.toString('utf8');

export class DugiteGit implements Git {
  readonly #options: DugiteGitOptions;
  readonly #runner: GitRunner;

  constructor(options: DugiteGitOptions) {
    this.#options = options;
    this.#runner = new GitRunner({
      paths: options.paths,
      libraryRoots: options.libraryRoots,
      ...(options.importRoots ? { importRoots: options.importRoots } : {}),
      neutralDir: options.neutralDir,
      baseEnv: options.baseEnv,
      logger: options.logger,
      ...(options.onRun ? { onRun: options.onRun } : {}),
    });
  }

  /** Runs one git command with the app's environment; a failure that isn't in `ok` throws a classified AppError. */
  async run(cwd: string, args: readonly string[], call: Call = {}): Promise<RunResult> {
    const options = this.#options;
    const auth: GitAuth =
      call.auth ?? (call.url && options.credentials ? await options.credentials(call.url) : { kind: 'none' });
    const network: GitNetwork =
      call.url && options.network ? await options.network(call.url) : { proxy: null, caBundle: null };
    const signing = call.signing ?? (call.sign && options.signing ? await options.signing(cwd) : null);
    const prepared = await commandEnv({
      platform: options.platform,
      auth,
      network,
      keyDir: options.keyDir,
      sshOptions: options.sshOptions ?? [],
      signing,
      // Only a command that talks to a server can stall on one.
      stallSeconds: call.url || call.auth ? (options.stallSeconds ?? NETWORK_STALL_SECONDS) : undefined,
      url: call.url,
      ...(call.config ? { config: call.config } : {}),
    });
    try {
      if (prepared.keyFile) options.onKeyFile?.(prepared.keyFile);
      if (prepared.signingFile) options.onKeyFile?.(prepared.signingFile);
      const result = await this.#runner.run({
        cwd,
        args,
        env: { ...prepared.env, ...call.env },
        ...(call.stdin === undefined ? {} : { stdin: call.stdin }),
        ...(call.signal ? { signal: call.signal } : {}),
        ...(call.onProgress ? { onProgress: call.onProgress } : {}),
      });
      if (!(call.ok ?? [0]).includes(result.exitCode)) throw failure(result.stderr, result.exitCode);
      return result;
    } finally {
      await prepared.cleanup();
    }
  }

  /** The signing a repo's commits get now, or null (PLAN.md §3.10 "Signing"). */
  async signing(repo: string): Promise<GitSigning | null> {
    return this.#options.signing ? this.#options.signing(repo) : null;
  }

  identity(identity: GitIdentity, committerOnly = false): Record<string, string> {
    const commit: CommitIdentity = { identity, now: this.#options.clock.now(), committerOnly };
    return identityEnv(commit);
  }

  async version(): Promise<string> {
    const result = await this.run(this.#options.neutralDir, ['--version']);
    return /git version (\S+)/.exec(text(result))?.[1] ?? text(result).trim();
  }

  async clone(input: CloneInput): Promise<void> {
    const args = ['clone', '--progress'];
    if (input.shallow) args.push('--depth', '1');
    if (input.branch !== undefined) args.push('--branch', plain(input.branch, 'branch'));
    args.push('--', plain(input.url, 'URL'), input.dest);
    await this.run(this.#options.neutralDir, args, {
      url: input.url,
      signal: input.signal,
      onProgress: input.onProgress,
      ...(input.auth ? { auth: input.auth } : {}),
    });
  }

  async lsRemote(url: string, options: GitCallOptions = {}): Promise<RemoteRefs> {
    return this.#lsRemote(this.#options.neutralDir, url, url, options);
  }

  async #lsRemote(cwd: string, remote: string, url: string, options: GitCallOptions): Promise<RemoteRefs> {
    const result = await this.run(cwd, ['ls-remote', '--symref', '--', plain(remote, 'URL'), 'HEAD', 'refs/heads/*'], {
      url,
      signal: options.signal,
    });
    return parseLsRemote(text(result));
  }

  repo(path: AbsPath): GitRepo {
    return new DugiteRepo(this, path, this.#options.paths, (cwd, remote, url, options) =>
      this.#lsRemote(cwd, remote, url, options),
    );
  }

  codeRepo(path: AbsPath): CodeRepoGit {
    return new DugiteCodeRepo(this, path, this.#options.paths);
  }

  importSource(path: AbsPath): ImportSourceGit {
    return new DugiteImportSource(this, path);
  }
}

type LsRemote = (cwd: string, remote: string, url: string, options: GitCallOptions) => Promise<RemoteRefs>;

class DugiteRepo implements GitRepo {
  readonly path: AbsPath;
  readonly #git: DugiteGit;
  readonly #paths: PathFlavour;
  readonly #lsRemote: LsRemote;
  #gitDir: string | undefined;

  constructor(git: DugiteGit, path: AbsPath, paths: PathFlavour, lsRemote: LsRemote) {
    this.#git = git;
    this.path = path;
    this.#paths = paths;
    this.#lsRemote = lsRemote;
  }

  #run(args: readonly string[], call?: Call): Promise<RunResult> {
    return this.#git.run(this.path, args, call);
  }

  async #output(args: readonly string[], call?: Call): Promise<string> {
    return text(await this.#run(args, call));
  }

  async #dir(): Promise<string> {
    this.#gitDir ??= (await this.#output(['rev-parse', '--absolute-git-dir'])).trim();
    return this.#gitDir;
  }

  async state(): Promise<RepoState> {
    const dir = await this.#dir();
    const has = (name: string) => existsSync(this.#paths.join(dir, name));
    const operation: RepoState['operation'] =
      has('rebase-merge') || has('rebase-apply')
        ? 'rebasing'
        : has('MERGE_HEAD')
          ? 'merging'
          : has('CHERRY_PICK_HEAD')
            ? 'cherryPicking'
            : has('REVERT_HEAD')
              ? 'reverting'
              : 'none';
    return { operation, busy: has('index.lock') };
  }

  /** Commands that change the repo refuse while another git program holds its lock (A3.10). */
  async #notBusy(): Promise<RepoState> {
    const state = await this.state();
    if (state.busy) throw new AppError('git.busy');
    return state;
  }

  async status(): Promise<Status> {
    const output = await this.#output([
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
      '--untracked-files=all',
      '--find-renames',
      '--ignore-submodules=none',
    ]);
    return parseStatus(output);
  }

  async resolve(revision: string): Promise<Oid | null> {
    const result = await this.#run(['rev-parse', '--verify', '--quiet', `${plain(revision, 'revision')}^{commit}`], {
      ok: [0, 1, 128],
    });
    return result.exitCode === 0 ? text(result).trim() : null;
  }

  remoteUrl(): Promise<string> {
    return this.#remoteUrl();
  }

  async setRemoteUrl(url: string): Promise<void> {
    await this.#run(['remote', 'set-url', 'origin', plain(url, 'URL')]);
  }

  async fetchUrl(url: string, options: GitCallOptions = {}): Promise<Oid> {
    await this.#notBusy();
    await this.#run(['fetch', '--no-tags', '--no-recurse-submodules', '--progress', plain(url, 'URL'), 'HEAD'], {
      url,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    const id = await this.resolve('FETCH_HEAD');
    if (id === null) throw new AppError('git.notFound', { ref: 'FETCH_HEAD' });
    return id;
  }

  async setUnbornBranch(name: string): Promise<void> {
    if ((await this.resolve('HEAD')) !== null)
      throw new AppError('git.failed', { message: 'HEAD has commits', exitCode: -1 });
    await this.#run(['symbolic-ref', 'HEAD', `refs/heads/${plain(name, 'branch')}`]);
  }

  /**
   * The address the repo has for `origin`, as it was stored. `git remote get-url` would give the address after the
   * user's own `insteadOf` rules, which can be another one, with another way to sign in (addressPins).
   */
  async #remoteUrl(): Promise<string> {
    const result = await this.#run(['config', '--local', '--get', 'remote.origin.url'], { ok: [0, 1, 2, 128] });
    if (result.exitCode !== 0) throw new AppError('git.notFound', { remote: 'origin' });
    return text(result).trim();
  }

  async fetch(options: GitCallOptions = {}): Promise<FetchResult> {
    await this.#notBusy();
    const url = await this.#remoteUrl();
    const output = await this.#output(
      ['fetch', '--porcelain', '--prune', '--no-recurse-submodules', '--progress', 'origin'],
      { url, signal: options.signal, onProgress: options.onProgress },
    );
    return { updated: parseFetch(output) };
  }

  async aheadBehind(local: string, upstream: string): Promise<{ ahead: number; behind: number }> {
    const output = await this.#output([
      'rev-list',
      '--left-right',
      '--count',
      `${plain(local, 'revision')}...${plain(upstream, 'revision')}`,
      '--',
    ]);
    const [ahead = '0', behind = '0'] = output.trim().split(/\s+/);
    return { ahead: Number(ahead), behind: Number(behind) };
  }

  async defaultBranch(options: GitCallOptions = {}): Promise<string | null> {
    const known = await this.#run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { ok: [0, 1, 128] });
    if (known.exitCode === 0)
      return text(known)
        .trim()
        .replace(/^refs\/remotes\/origin\//, '');
    const url = await this.#remoteUrl();
    return (await this.#lsRemote(this.path, 'origin', url, options)).head;
  }

  async log(options: LogOptions = {}): Promise<Commit[]> {
    if (options.range === undefined && (await this.resolve('HEAD')) === null) return [];
    const args = [
      'log',
      '--no-color',
      '--no-decorate',
      '--no-show-signature',
      '--no-ext-diff',
      `--format=${LOG_FORMAT}`,
      '-z',
    ];
    if (options.max !== undefined) args.push(`--max-count=${options.max}`);
    if (options.skip !== undefined) args.push(`--skip=${options.skip}`);
    args.push(plain(options.range ?? 'HEAD', 'range'), '--', ...(options.paths ?? []));
    return parseLog(await this.#output(args));
  }

  async show(commit: string): Promise<CommitDetails> {
    const id = await this.resolve(commit);
    const [details] = id === null ? [] : await this.log({ range: id, max: 1 });
    if (!details) throw new AppError('git.notFound', { commit });
    const changes = await this.diff(details.parents[0] ?? EMPTY_TREE, details.id);
    return { ...details, changes };
  }

  async diff(from: DiffEnd, to: DiffEnd, paths: readonly string[] = []): Promise<FileChange[]> {
    if (typeof from !== 'string') throw new Error('a diff starts at a commit');
    const args = [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '-M',
      '-z',
      plain(from, 'revision'),
    ];
    if (typeof to === 'string') args.push(plain(to, 'revision'));
    args.push('--', ...paths);
    return parseNameStatus(await this.#output(args));
  }

  async listTree(treeish: string, path?: string): Promise<GitTreeEntry[]> {
    const args = ['ls-tree', '-r', '-t', '-z', '-l', '--full-tree', plain(treeish, 'tree')];
    if (path !== undefined) args.push('--', path);
    return parseLsTree(await this.#output(args));
  }

  async readBlob(oid: Oid): Promise<Uint8Array> {
    if (!OID.test(oid)) throw new AppError('git.notFound', { object: oid });
    const result = await this.#run(['cat-file', 'blob', oid]);
    return new Uint8Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
  }

  async commit(input: CommitInput): Promise<Oid> {
    await this.#notBusy();
    if (input.paths && input.paths.length > 0) await this.#run(['add', '-A', '--', ...input.paths]);
    const executable = (input.executable ?? []).map((p) => plain(p, 'path'));
    if (executable.length > 0) {
      // The bit goes into the index, and git writes it to the file too, so `--only` below (which reads the files
      // again) keeps it. On Windows the file has no such bit, and git keeps the index's (core.fileMode is false there).
      await this.#run(['update-index', '--chmod=+x', '--', ...executable]);
      await this.#run(['checkout-index', '--force', '--', ...executable]);
    }
    const args = ['commit', '-F', '-'];
    if (input.allowEmpty) args.push('--allow-empty');
    for (const [key, value] of Object.entries(input.trailers ?? {})) args.push('--trailer', `${key}: ${value}`);
    if (input.paths && input.paths.length > 0) args.push('--only', '--', ...input.paths);
    const result = await this.#run(args, {
      stdin: input.message,
      env: this.#git.identity(input.author),
      ok: [0, 1],
      sign: true,
    });
    if (result.exitCode !== 0) {
      if (/nothing to commit|no changes added to commit|nothing added to commit/.test(text(result))) {
        throw new AppError('git.nothingToCommit');
      }
      throw failure(result.stderr || text(result), result.exitCode);
    }
    return (await this.resolve('HEAD')) ?? '';
  }

  async push(input: PushInput, options: GitCallOptions = {}): Promise<PushOutcome> {
    const url = await this.#remoteUrl();
    const remoteBranch = input.remoteBranch ?? input.branch;
    const args = ['push', '--porcelain', '--progress', '--no-follow-tags', '--no-signed'];
    if (input.dryRun) args.push('--dry-run');
    if (input.setUpstream) args.push('--set-upstream');
    args.push('origin', `refs/heads/${plain(input.branch, 'branch')}:refs/heads/${plain(remoteBranch, 'branch')}`);
    const result = await this.#run(args, { url, signal: options.signal, onProgress: options.onProgress, ok: [0, 1] });
    const [ref] = parsePush(text(result));
    if (!ref) throw failure(result.stderr, result.exitCode);
    if (ref.flag === '!') {
      const rejection = classifyRejection(ref.summary, result.stderr);
      return { kind: 'rejected', ...rejection };
    }
    if (ref.flag === '=') return { kind: 'upToDate' };
    return { kind: 'pushed', dryRun: input.dryRun === true, remoteMessage: remoteLines(result.stderr) };
  }

  async #dirtyTracked(): Promise<string[]> {
    const status = await this.status();
    return status.entries.filter((e) => e.kind === 'changed').map((e) => e.path);
  }

  async #conflictedFiles(): Promise<string[]> {
    return (await this.conflicts()).map((c) => c.path);
  }

  async integrate(input: IntegrateInput): Promise<IntegrateOutcome> {
    const state = await this.#notBusy();
    if (state.operation !== 'none') throw new AppError('git.busy', { operation: state.operation });
    if (!OID.test(input.commit)) throw new AppError('git.notFound', { commit: input.commit });
    const before = await this.resolve('HEAD');
    if (before !== null && (before === input.commit || (await this.#isAncestor(input.commit, before)))) {
      return { kind: 'upToDate' };
    }
    const fastForward = before === null || (await this.#isAncestor(before, input.commit));
    const autostash = input.autostash ? '--autostash' : '--no-autostash';
    let result: RunResult;
    if (input.mode === 'merge') {
      const message = input.message ?? `Merge remote-tracking branch '${input.name}'`;
      // By its name while the name is still exactly that commit, so the conflict markers name the branch the user
      // knows; else by the commit itself.
      const named = /^\w[\w./-]*$/.test(input.name) && (await this.resolve(input.name)) === input.commit;
      result = await this.#run(
        ['merge', '--no-edit', '--ff', autostash, '-m', message, named ? input.name : input.commit],
        { env: this.#git.identity(input.identity), ok: [0, 1, 2, 128], sign: true },
      );
    } else {
      // git refuses to rebase with any local change; the files it would have to stash are those.
      if (!input.autostash) {
        const dirty = await this.#dirtyTracked();
        if (dirty.length > 0) return { kind: 'wouldBeOverwritten', files: dirty };
      }
      result = await this.#run(['rebase', autostash, input.commit], {
        env: this.#git.identity(input.identity, true),
        ok: [0, 1, 2, 128],
        sign: true,
      });
    }
    if (result.exitCode === 0) {
      const head = (await this.resolve('HEAD')) ?? '';
      // The merge or rebase is done, but the local changes it stashed came back with conflicts: git keeps the stash and
      // leaves the files in conflict. The state tells it, not git's words, which changed in Git 2.56 ("Applying
      // autostash resulted in conflicts." became "Your local changes are stashed, however applying them resulted in
      // conflicts.").
      if (input.autostash) {
        const files = await this.#conflictedFiles();
        if (files.length > 0) return { kind: 'stashConflicts', head, files };
      }
      if (head === input.commit && fastForward) return { kind: 'fastForwarded', head };
      return input.mode === 'merge' ? { kind: 'merged', head } : { kind: 'rebased', head };
    }
    const overwritten = wouldBeOverwritten(result.stderr);
    if (overwritten.length > 0) return { kind: 'wouldBeOverwritten', files: overwritten };
    const after = await this.state();
    if (after.operation !== 'none') return { kind: 'conflicts', files: await this.#conflictedFiles() };
    throw failure(result.stderr, result.exitCode);
  }

  async #isAncestor(ancestor: string, of: string): Promise<boolean> {
    const result = await this.#run(['merge-base', '--is-ancestor', ancestor, of], { ok: [0, 1, 128] });
    return result.exitCode === 0;
  }

  async continue(identity: GitIdentity): Promise<ContinueOutcome> {
    const state = await this.#notBusy();
    const unresolved = await this.#conflictedFiles();
    if (state.operation === 'none') throw new AppError('git.noOperation');
    if (unresolved.length > 0) return { kind: 'unresolved', files: unresolved };
    if (state.operation === 'merging') {
      await this.#run(['commit', '--no-edit'], { env: this.#git.identity(identity), sign: true });
      return { kind: 'done', head: (await this.resolve('HEAD')) ?? '' };
    }
    const command =
      state.operation === 'rebasing' ? 'rebase' : state.operation === 'reverting' ? 'revert' : 'cherry-pick';
    const env = this.#git.identity(identity, state.operation === 'rebasing');
    let result = await this.#run([command, '--continue'], { env, ok: [0, 1, 128], sign: true });
    // A step whose resolution left nothing to commit is skipped, as `git rebase --continue` asks for.
    for (
      let i = 0;
      i < 100 && result.exitCode !== 0 && /No changes|nothing to commit|--skip/.test(`${text(result)}${result.stderr}`);
      i++
    ) {
      if ((await this.#conflictedFiles()).length > 0) break;
      result = await this.#run([command, '--skip'], { env, ok: [0, 1, 128], sign: true });
    }
    if (result.exitCode === 0) return { kind: 'done', head: (await this.resolve('HEAD')) ?? '' };
    const files = await this.#conflictedFiles();
    if (files.length > 0) return { kind: 'conflicts', files };
    throw failure(result.stderr, result.exitCode);
  }

  async abort(): Promise<void> {
    const state = await this.state();
    const command =
      state.operation === 'merging'
        ? 'merge'
        : state.operation === 'rebasing'
          ? 'rebase'
          : state.operation === 'reverting'
            ? 'revert'
            : state.operation === 'cherryPicking'
              ? 'cherry-pick'
              : undefined;
    if (!command) throw new AppError('git.noOperation');
    await this.#run([command, '--abort']);
  }

  async conflicts(): Promise<GitConflict[]> {
    const status = await this.status();
    return status.entries.flatMap((entry) =>
      entry.kind === 'conflicted' ? [{ path: entry.path, kind: entry.conflict }] : [],
    );
  }

  async markResolved(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.#notBusy();
    await this.#run(['add', '-A', '--', ...paths]);
  }

  async conflictVersions(path: string): Promise<ConflictVersions> {
    const output = await this.#output(['ls-files', '--unmerged', '-z', '--', plain(path, 'path')]);
    const versions: { base: Oid | null; ours: Oid | null; theirs: Oid | null } = {
      base: null,
      ours: null,
      theirs: null,
    };
    for (const record of output.split('\0')) {
      const match = /^\d+ ([0-9a-f]+) ([123])\t(.*)$/s.exec(record);
      if (!match || match[3] !== path) continue;
      const stage = match[2] === '1' ? 'base' : match[2] === '2' ? 'ours' : 'theirs';
      versions[stage] = match[1] ?? null;
    }
    return versions;
  }

  async takeConflict(path: string, take: ConflictTake): Promise<void> {
    await this.#notBusy();
    const file = plain(path, 'path');
    if (take === 'delete') {
      await this.#run(['rm', '--quiet', '--force', '--ignore-unmatch', '--', file]);
      return;
    }
    await this.#run(['checkout', `--${take}`, '--', file]);
    await this.#run(['add', '--', file]);
  }

  async operationHeads(): Promise<OperationHeads> {
    const dir = await this.#dir();
    const onto = (() => {
      const file = this.#paths.join(dir, 'rebase-merge', 'onto');
      if (!existsSync(file)) return null;
      const id = readFileSync(file, 'utf8').trim();
      return OID.test(id) ? id : null;
    })();
    const incoming =
      (await this.resolve('MERGE_HEAD')) ??
      (await this.resolve('REVERT_HEAD')) ??
      (await this.resolve('CHERRY_PICK_HEAD'));
    return { incoming, replaying: await this.resolve('REBASE_HEAD'), onto };
  }

  async undoCommit(): Promise<void> {
    await this.#notBusy();
    if ((await this.resolve('HEAD~1')) === null) throw new AppError('git.notFound', { commit: 'HEAD~1' });
    await this.#run(['reset', '--soft', 'HEAD~1']);
  }

  async discard(paths: readonly string[]): Promise<void> {
    await this.#notBusy();
    const files = paths.map((p) => plain(p, 'path'));
    if (files.length === 0) return;
    const head = await this.resolve('HEAD');
    if (head !== null) {
      // Unstaged first, so a new file that was staged is an untracked one below.
      await this.#run(['reset', '--quiet', 'HEAD', '--', ...files], { ok: [0, 1] });
      const tracked = (
        await this.#output(['ls-tree', '-r', '-z', '--name-only', '--full-tree', 'HEAD', '--', ...files])
      )
        .split('\0')
        .filter((p) => p !== '');
      if (tracked.length > 0) await this.#run(['checkout', 'HEAD', '--', ...tracked]);
    } else {
      await this.#run(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...files]);
    }
    await this.#run(['clean', '--force', '-d', '--quiet', '--', ...files]);
  }

  async stashPush(input: { message: string; identity: GitIdentity; includeUntracked?: boolean }): Promise<Oid | null> {
    await this.#notBusy();
    const args = ['stash', 'push', '--message', input.message];
    if (input.includeUntracked) args.push('--include-untracked');
    const output = await this.#output(args, { env: this.#git.identity(input.identity) });
    if (/No local changes to save/.test(output)) return null;
    return this.resolve('refs/stash');
  }

  async stashList(): Promise<Stash[]> {
    return parseStashList(await this.#output(['stash', 'list', `--format=${STASH_FORMAT}`, '-z']));
  }

  async stashApply(index: number, options: { pop: boolean; identity: GitIdentity }): Promise<StashApplyOutcome> {
    await this.#notBusy();
    // Local changes that the stash would overwrite end the command with 1 before Git 2.56, and with 128 since.
    const result = await this.#run(['stash', options.pop ? 'pop' : 'apply', `stash@{${Math.trunc(index)}}`], {
      env: this.#git.identity(options.identity),
      ok: [0, 1, 128],
    });
    if (result.exitCode === 0) return { kind: 'applied' };
    // A new file the stash brings back is in the folder already: "<path> already exists, no checkout".
    const existing = [...result.stderr.matchAll(/^(.+) already exists, no checkout$/gm)].map((m) => m[1] ?? '');
    const overwritten = [...wouldBeOverwritten(result.stderr), ...existing];
    if (overwritten.length > 0) return { kind: 'wouldBeOverwritten', files: overwritten };
    const files = await this.#conflictedFiles();
    if (files.length > 0) return { kind: 'conflicts', files };
    throw failure(result.stderr, result.exitCode);
  }

  async stashDrop(index: number): Promise<void> {
    await this.#run(['stash', 'drop', `stash@{${Math.trunc(index)}}`]);
  }

  async branches(): Promise<Branch[]> {
    const refs = parseRefs(
      await this.#output(['for-each-ref', `--format=${BRANCH_FORMAT}`, '--sort=refname', 'refs/heads/']),
    );
    return refs.map((ref) => ({
      name: ref.ref.replace(/^refs\/heads\//, ''),
      head: ref.head,
      current: ref.current,
      upstream: ref.upstream,
    }));
  }

  async remoteBranches(): Promise<RemoteBranch[]> {
    const refs = parseRefs(
      await this.#output(['for-each-ref', `--format=${BRANCH_FORMAT}`, '--sort=refname', 'refs/remotes/']),
    );
    return refs
      .filter((ref) => !ref.symbolic)
      .map((ref) => ({ name: ref.ref.replace(/^refs\/remotes\//, ''), head: ref.head }));
  }

  async createBranch(name: string, start: string): Promise<void> {
    await this.#run(['branch', '--no-track', plain(name, 'branch'), plain(start, 'revision')]);
  }

  async switchBranch(name: string): Promise<void> {
    await this.#notBusy();
    const result = await this.#run(['switch', plain(name, 'branch')], { ok: [0, 1, 128] });
    if (result.exitCode === 0) return;
    const files = wouldBeOverwritten(result.stderr);
    if (files.length > 0) throw new AppError('git.wouldBeOverwritten', { files: files.join(', ') });
    throw failure(result.stderr, result.exitCode);
  }

  async deleteBranch(name: string, options: { force?: boolean } = {}): Promise<void> {
    await this.#run(['branch', options.force ? '-D' : '-d', plain(name, 'branch')]);
  }

  async revert(commit: Oid, identity: GitIdentity): Promise<RevertOutcome> {
    await this.#notBusy();
    const id = await this.resolve(commit);
    const [details] = id === null ? [] : await this.log({ range: id, max: 1 });
    if (!details) throw new AppError('git.notFound', { commit });
    const args = ['revert', '--no-edit'];
    if (details.parents.length > 1) args.push('-m', '1');
    args.push(details.id);
    const result = await this.#run(args, { env: this.#git.identity(identity), ok: [0, 1, 128], sign: true });
    if (result.exitCode === 0) return { kind: 'reverted', head: (await this.resolve('HEAD')) ?? '' };
    const overwritten = wouldBeOverwritten(result.stderr);
    if (overwritten.length > 0) throw new AppError('git.wouldBeOverwritten', { files: overwritten.join(', ') });
    const files = await this.#conflictedFiles();
    if (files.length > 0) return { kind: 'conflicts', files };
    throw failure(result.stderr, result.exitCode);
  }

  async pathVersions(path: string, options: { max?: number } = {}): Promise<Oid[]> {
    if ((await this.resolve('HEAD')) === null) return [];
    const commits = (
      await this.#output([
        'log',
        '--no-color',
        '--format=%H',
        `--max-count=${options.max ?? 100}`,
        'HEAD',
        '--',
        plain(path, 'path'),
      ])
    )
      .split('\n')
      .filter((line) => OID.test(line));
    if (commits.length === 0) return [];
    // One process for every commit: `<commit>:<path>` names the path's tree there, or is "missing" where it's gone.
    const result = await this.#run(['cat-file', '--batch-check'], {
      stdin: commits.map((commit) => `${commit}:${path}\n`).join(''),
    });
    const versions: Oid[] = [];
    for (const line of text(result).split('\n')) {
      const [oid, type] = line.split(' ');
      if (oid !== undefined && type === 'tree' && OID.test(oid) && !versions.includes(oid)) versions.push(oid);
    }
    return versions;
  }

  async ignored(paths: readonly string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    // One process for every path; -z keeps names with any character intact. Exit 1 means none is ignored.
    const result = await this.#run(['check-ignore', '-z', '--stdin'], {
      stdin: paths.map((p) => `${plain(p, 'path')}\0`).join(''),
      ok: [0, 1],
    });
    return text(result)
      .split('\0')
      .filter((p) => p !== '');
  }

  async restore(paths: readonly string[], source = 'HEAD'): Promise<void> {
    await this.#notBusy();
    if (paths.length === 0) return;
    await this.#run(['checkout', plain(source, 'revision'), '--', ...paths.map((p) => plain(p, 'path'))]);
  }

  async resetKeep(commit: Oid): Promise<void> {
    await this.#notBusy();
    const result = await this.#run(['reset', '--keep', plain(commit, 'revision')], { ok: [0, 1, 128] });
    if (result.exitCode === 0) return;
    const files = [...result.stderr.matchAll(/Entry '(.+)' not uptodate/g)].map((m) => m[1] ?? '');
    if (files.length > 0) throw new AppError('git.wouldBeOverwritten', { files: files.join(', ') });
    throw failure(result.stderr, result.exitCode);
  }

  async forceBranch(name: string, commit: Oid): Promise<void> {
    await this.#notBusy();
    const status = await this.status();
    if (status.branch === name) throw new AppError('sync.currentBranch', { branch: name });
    await this.#run(['branch', '--force', '--no-track', plain(name, 'branch'), plain(commit, 'revision')]);
  }

  async mergeBase(a: string, b: string): Promise<Oid | null> {
    const result = await this.#run(['merge-base', plain(a, 'revision'), plain(b, 'revision')], { ok: [0, 1] });
    return result.exitCode === 0 ? text(result).trim() : null;
  }

  isAncestor(ancestor: string, commit: string): Promise<boolean> {
    return this.#isAncestor(plain(ancestor, 'revision'), plain(commit, 'revision'));
  }

  async signCommits(base: Oid, identity: GitIdentity): Promise<Oid> {
    const state = await this.#notBusy();
    if (state.operation !== 'none') throw new AppError('git.busy', { operation: state.operation });
    const signing = await this.#git.signing(this.path);
    if (signing === null) throw new AppError('review.signingKeyNeeded');
    // Every commit made again, signed; merges stay merges, and the authors and their dates stay.
    const result = await this.#run(
      ['rebase', '--force-rebase', '--rebase-merges', '--autostash', '--no-verify', plain(base, 'revision')],
      { env: this.#git.identity(identity, true), signing, ok: [0, 1, 128] },
    );
    if (result.exitCode !== 0) {
      if ((await this.state()).operation === 'rebasing') await this.#run(['rebase', '--abort'], { ok: [0, 1, 128] });
      throw failure(result.stderr, result.exitCode);
    }
    return (await this.resolve('HEAD')) ?? '';
  }

  async mergeTree(ours: string, theirs: string): Promise<MergeTreeResult> {
    const result = await this.#run(
      ['merge-tree', '--write-tree', '-z', plain(ours, 'revision'), plain(theirs, 'revision')],
      { ok: [0, 1] },
    );
    return parseMergeTree(text(result), result.exitCode);
  }
}

class DugiteCodeRepo implements CodeRepoGit {
  readonly path: AbsPath;
  readonly #git: DugiteGit;
  readonly #paths: PathFlavour;

  constructor(git: DugiteGit, path: AbsPath, paths: PathFlavour) {
    this.#git = git;
    this.path = path;
    this.#paths = paths;
  }

  // A code repo's own config could start a program (core.fsmonitor); the allowed commands never need one.
  #run(args: readonly string[], ok?: readonly number[]): Promise<RunResult> {
    return this.#git.run(this.path, args, { config: [['core.fsmonitor', 'false']], ...(ok ? { ok } : {}) });
  }

  async remoteUrl(name = 'origin'): Promise<string | null> {
    const result = await this.#run(['remote', 'get-url', name], [0, 2, 128]);
    return result.exitCode === 0 ? text(result).trim() : null;
  }

  async worktrees(): Promise<ReadonlyArray<{ path: AbsPath; branch: string | null }>> {
    const output = text(await this.#run(['worktree', 'list', '--porcelain', '-z']));
    return parseWorktrees(output).map((w) => ({ path: this.#paths.normalize(w.path) as AbsPath, branch: w.branch }));
  }

  async excludePath(): Promise<AbsPath> {
    const output = text(await this.#run(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']));
    return this.#paths.normalize(output.trim()) as AbsPath;
  }

  async isCommitted(path: string): Promise<boolean> {
    const result = await this.#run(['ls-tree', '-z', '--name-only', 'HEAD', '--', plain(path, 'path')], [0, 128]);
    return result.exitCode === 0 && text(result).length > 0;
  }
}

/** A folder picked to import from, or the app's clone of an import URL: its remote, commit and place (PLAN.md §3.18). */
class DugiteImportSource implements ImportSourceGit {
  readonly path: AbsPath;
  readonly #git: DugiteGit;

  constructor(git: DugiteGit, path: AbsPath) {
    this.#git = git;
    this.path = path;
  }

  // The picked repo's own config could start a program (core.fsmonitor); these commands never need one. A folder
  // outside any repo makes git fail with 128: that answers null.
  async #answer(args: readonly string[]): Promise<string | null> {
    const result = await this.#git.run(this.path, args, { config: [['core.fsmonitor', 'false']], ok: [0, 1, 2, 128] });
    return result.exitCode === 0 ? text(result).trim() : null;
  }

  remoteUrl(): Promise<string | null> {
    return this.#answer(['remote', 'get-url', 'origin']);
  }

  async head(): Promise<Oid | null> {
    const head = await this.#answer(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    return head !== null && OID.test(head) ? head : null;
  }

  async prefix(): Promise<string | null> {
    const prefix = await this.#answer(['rev-parse', '--show-prefix']);
    return prefix === null ? null : prefix.replace(/\\/g, '/').replace(/\/+$/, '');
  }
}
