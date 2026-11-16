// Git as a test's other person or tool runs it: dugite's git, isolated from this computer's git configuration, its
// credential helpers and its proxies (TESTING.md §3). The app's own git goes through the Git port (ADR 0013).
import { exec, setupEnvironment } from 'dugite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface TestGitOptions {
  /** The home folder git sees; its .gitconfig is created empty. */
  readonly home: string;
  /** A PEM file of trusted certificates, e.g. the fake host's certificate authority. */
  readonly trust?: string;
  /** An Authorization header for every request, e.g. `Basic …`. */
  readonly authorization?: string;
  readonly author?: { name: string; email: string };
  /** Variables for this command, e.g. fixed commit dates. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface TestGitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function testGitEnv(options: TestGitOptions): Record<string, string> {
  mkdirSync(options.home, { recursive: true });
  const globalConfig = path.join(options.home, '.gitconfig');
  if (!existsSync(globalConfig)) writeFileSync(globalConfig, '');
  const config: Array<[string, string]> = [['credential.helper', '']];
  if (options.authorization) config.push(['http.extraHeader', `Authorization: ${options.authorization}`]);
  // dugite's Windows git verifies with Windows' own store unless it uses OpenSSL (Step 0, spike 4).
  if (options.trust && process.platform === 'win32') config.push(['http.sslBackend', 'openssl']);
  const author = options.author ?? { name: 'Test Person', email: 'person@example.test' };
  const env: Record<string, string> = {
    HOME: options.home,
    USERPROFILE: options.home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    HTTPS_PROXY: '',
    https_proxy: '',
    HTTP_PROXY: '',
    http_proxy: '',
    ALL_PROXY: '',
    all_proxy: '',
    NO_PROXY: '',
    no_proxy: '',
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], i) => [
        [`GIT_CONFIG_KEY_${i}`, key],
        [`GIT_CONFIG_VALUE_${i}`, value],
      ]),
    ),
    // The environment variable, not http.sslCAInfo: dugite sets GIT_SSL_CAINFO itself on Linux (Step 0, spike 4).
    ...(options.trust ? { GIT_SSL_CAINFO: options.trust } : {}),
    ...options.env,
  };
  return env;
}

export async function testGit(args: readonly string[], cwd: string, options: TestGitOptions): Promise<TestGitResult> {
  const result = await exec([...args], cwd, { env: testGitEnv(options) });
  return { exitCode: result.exitCode, stdout: String(result.stdout), stderr: String(result.stderr) };
}

/**
 * The same, synchronously, for building worlds (which are built synchronously). Throws when git fails, unless the
 * exit code is in `ok`.
 */
export function testGitSync(
  args: readonly string[],
  cwd: string,
  options: TestGitOptions & { ok?: readonly number[] },
): TestGitResult {
  const { env, gitLocation } = setupEnvironment(testGitEnv(options), {
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  });
  try {
    const stdout = execFileSync(gitLocation, [...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    const result = { exitCode: failed.status ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    if (options.ok?.includes(result.exitCode)) return result;
    throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr}`, { cause: error });
  }
}
