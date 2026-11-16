// The development build (TESTING.md §3): `pnpm dev` starts it in a fresh test root with a world, so it never reaches
// the real home folder, its tool folders or the keychain. Development builds are test-hooks builds.
//   pnpm dev [--world empty]     a fresh test root (printed), the recording proxy, the dev server
//   pnpm dev:real-home           a person only: asks for confirmation, then runs on the real home folder
//   node scripts/dev.ts --smoke  starts, waits until the app is up, stops (used by A1.7's test)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { brand } from '../packages/brand/src/index.ts';
import { startRecordingProxy } from '../packages/testkit/src/harness/recording-proxy.ts';
import { createTestRoot, testEnv } from '../packages/testkit/src/harness/test-root.ts';
import { buildWorld, type WorldName } from '../packages/testkit/src/worlds/index.ts';

const repo = path.resolve(import.meta.dirname, '..');
const app = path.join(repo, 'apps', 'desktop');
const args = process.argv.slice(2);
const realHome = args.includes('--real-home');
const smoke = args.includes('--smoke');
const worldAt = args.indexOf('--world');
const world = (worldAt >= 0 ? args[worldAt + 1] : 'empty') as WorldName;
const electronVite = path.join(app, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');

/**
 * electron-vite runs Electron's binary, which Electron 44 doesn't download when it's installed (Step 0): fetch it. Its
 * download is kept in the repository's .cache, not the home folder, which a development run never writes to.
 */
function ensureElectron(): void {
  const electron = path.join(app, 'node_modules', 'electron');
  if (existsSync(path.join(electron, 'path.txt'))) return;
  process.stdout.write("Downloading Electron's binary, once.\n");
  const install = spawnSync(process.execPath, [path.join(electron, 'install.js')], {
    stdio: 'inherit',
    env: { ...process.env, electron_config_cache: path.join(repo, '.cache', 'electron') },
  });
  if (install.status !== 0) throw new Error("Electron's binary could not be installed");
}

/** Whether any process of the process group is left (POSIX). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // macOS answers EPERM for a group whose last members are exiting. It is still there: the wait goes on, with its limit.
    // (A run of the journeys once ended with this error, and passed three times alone.)
    if (code === 'EPERM') return true;
    throw error;
  }
}

/**
 * Waits until the development run's process group is gone, and kills what's left after the timeout. electron-vite
 * exits first; the app it started can still be shutting down then, writing into the test root.
 */
async function groupGone(pgid: number, timeoutMs = 15_000): Promise<void> {
  const until = async (deadline: number) => {
    while (groupAlive(pgid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  };
  await until(Date.now() + timeoutMs);
  if (!groupAlive(pgid)) return;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // It ended in between.
  }
  await until(Date.now() + 2_000);
}

async function main(): Promise<number> {
  let env: NodeJS.ProcessEnv;
  let mainLog: string | undefined;
  let cleanup = async () => {};
  if (realHome) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(
      `This runs a development build of ${brand.displayName} on your real home folder: it can change your tool folders.\nType "yes" to continue: `,
    );
    prompt.close();
    if (answer.trim() !== 'yes') {
      process.stdout.write('Not started.\n');
      return 1;
    }
    env = { ...process.env, APP_DEV_REAL_HOME: 'confirmed' };
  } else {
    const root = createTestRoot('app-dev-');
    buildWorld(world, root);
    // The development renderer comes from the local dev server, which picks a port from 5173 on.
    const devServer = Array.from({ length: 27 }, (_, i) => 5173 + i).flatMap((port) => [
      `localhost:${port}`,
      `127.0.0.1:${port}`,
    ]);
    const proxy = await startRecordingProxy({ allow: devServer });
    env = { ...testEnv(root), APP_TEST_PROXY: proxy.url, NODE_ENV: 'development' };
    // The smoke check runs inside a test run: its window must not take the focus either (TESTING.md §3).
    if (smoke) env.APP_TEST_INACTIVE_WINDOW = '1';
    mainLog = root.at('appdata', brand.dataFolderName, 'logs', 'main.log');
    process.stdout.write(`test root: ${root.path}\nworld: ${world}\n`);
    cleanup = async () => {
      await proxy.close();
      const violations = proxy.violations();
      if (violations.length) process.stdout.write(`requests outside the allow-list: ${JSON.stringify(violations)}\n`);
      if (smoke) root.remove();
    };
  }

  ensureElectron();
  const child = spawn(process.execPath, [electronVite, 'dev'], {
    cwd: app,
    env,
    stdio: smoke ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    detached: process.platform !== 'win32',
  });
  const exited = new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
  /** electron-vite's exit code, once everything it started has ended too. */
  const ended = async () => {
    const code = await exited;
    if (process.platform !== 'win32' && child.pid !== undefined) await groupGone(child.pid);
    return code;
  };
  // The smoke test shows the dev server's last output when the app doesn't start.
  let output = '';
  const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-20_000));
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const stop = () => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (smoke && mainLog) {
    const log = mainLog;
    const deadline = Date.now() + 120_000;
    const up = await new Promise<boolean>((resolve) => {
      const check = setInterval(() => {
        const started = existsSync(log) && readFileSync(log, 'utf8').includes('renderer connected');
        if (started || Date.now() > deadline || child.exitCode !== null) {
          clearInterval(check);
          resolve(started);
        }
      }, 250);
    });
    stop();
    await ended();
    await cleanup();
    process.stdout.write(
      up ? 'smoke: the development build started in its test root\n' : `smoke: it did not start\n${output}\n`,
    );
    return up ? 0 : 1;
  }

  const code = await ended();
  await cleanup();
  return code;
}

process.exit(await main());
