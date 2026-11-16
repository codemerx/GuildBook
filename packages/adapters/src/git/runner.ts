// Runs dugite's git (ADR 0013). The environment is built from scratch for each command: the device's base variables
// (from the composition root, never this process's whole environment), dugite's own settings, and the command's
// (git-env.ts). Every command passes the guard first, and git never looks for a repo above the folder it runs in.
import { AppError, type Logger, type PathFlavour } from '@app/core';
import { spawn } from 'node:child_process';
import { setupEnvironment } from 'dugite';
import { ownProcessGroup, signalTree } from '../process/process-tree.ts';
import { checkCommand, type GitGuardOptions, type GitRole } from './guard.ts';
import { parseProgress } from './parse.ts';

export interface RunRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  /** Variables for this command (git-env.ts, identities). */
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: { phase: string; percent: number | null }) => void;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** What tests see of each command: never the variables' values (A3.8). */
export interface GitRunRecord {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly role: GitRole;
  /** The names of the variables set for this command. */
  readonly envNames: readonly string[];
  readonly exitCode: number | null;
}

export interface GitRunnerOptions extends GitGuardOptions {
  /** The device's variables git may see: HOME, PATH, the test root's GIT_CONFIG_GLOBAL, SSH_AUTH_SOCK, … */
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly logger: Logger;
  /** Test mode: every command, for the privacy and credential checks (TESTING.md §9.4). */
  readonly onRun?: (record: GitRunRecord) => void;
}

/** How long git gets to remove its lock files after SIGTERM, before everything it started is killed. */
const KILL_GRACE_MS = 3000;

export class GitRunner {
  readonly #options: GitRunnerOptions;

  constructor(options: GitRunnerOptions) {
    this.#options = options;
  }

  get paths(): PathFlavour {
    return this.#options.paths;
  }

  get neutralDir(): string {
    return this.#options.neutralDir;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const role = checkCommand({ cwd: request.cwd, args: request.args }, this.#options);
    if (request.signal?.aborted) throw new AppError('command.cancelled');
    const paths = this.#options.paths;
    const vars: Record<string, string> = {
      ...request.env,
      // git never looks for a repo above the folder it runs in, so a folder that isn't a repo can't turn into the
      // repo of a folder around it (a home folder kept in git, say).
      GIT_CEILING_DIRECTORIES: paths.dirname(request.cwd),
      GIT_DIR: '',
      GIT_WORK_TREE: '',
      GIT_INDEX_FILE: '',
      GIT_OBJECT_DIRECTORY: '',
      GIT_CONFIG_PARAMETERS: '',
    };
    const { env, gitLocation } = setupEnvironment(vars, { ...this.#options.baseEnv });
    // An empty variable means "not set", except a setting's empty value (`credential.helper=` resets every helper).
    for (const [key, value] of Object.entries(env)) {
      if (value === '' && !key.startsWith('GIT_CONFIG_VALUE_')) delete env[key];
    }
    const started = Date.now();
    const record = (exitCode: number | null) =>
      this.#options.onRun?.({
        cwd: request.cwd,
        args: [...request.args],
        role,
        envNames: Object.keys(request.env ?? {}).sort(),
        exitCode,
      });

    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(gitLocation, [...request.args], {
        cwd: request.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Its own process group, so a cancel can end git and the helpers it started (signalTree).
        detached: ownProcessGroup,
      });
      const out: Buffer[] = [];
      let err = '';
      let aborted = false;
      let escalation: NodeJS.Timeout | undefined;
      const onAbort = () => {
        aborted = true;
        // SIGTERM first: git removes its lock files when it ends this way.
        signalTree(child, 'SIGTERM');
        escalation = setTimeout(() => {
          signalTree(child, 'SIGKILL');
          // A process that left the group may still hold the pipes: close them, so the command ends with git itself.
          child.stdout.destroy();
          child.stderr.destroy();
        }, KILL_GRACE_MS);
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        err += text;
        if (request.onProgress) for (const progress of parseProgress(text)) request.onProgress(progress);
      });
      child.on('error', (error) => {
        clearTimeout(escalation);
        request.signal?.removeEventListener('abort', onAbort);
        reject(new AppError('git.failed', { message: error.message, exitCode: -1 }));
      });
      child.on('close', (code) => {
        clearTimeout(escalation);
        request.signal?.removeEventListener('abort', onAbort);
        if (aborted) reject(new AppError('command.cancelled'));
        else resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out), stderr: err });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(request.stdin ?? '');
    }).catch((error: unknown) => {
      record(null);
      throw error;
    });
    record(result.exitCode);
    // Arguments and variable names only: values can hold credentials (ADR 0014).
    this.#options.logger.debug('git', {
      args: request.args.slice(0, 12),
      cwd: request.cwd,
      env: Object.keys(request.env ?? {}).filter((name) => !name.startsWith('GIT_CONFIG_')),
      exitCode: result.exitCode,
      ms: Date.now() - started,
    });
    return result;
  }
}
