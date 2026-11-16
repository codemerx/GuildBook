// A test root (TESTING.md §3): every test, and every app a test starts, runs inside one, with its own home folder,
// app data, git config and network. It's removed after a passing test and kept after a failing one.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TestRoot {
  readonly path: string;
  readonly home: string;
  readonly appdata: string;
  readonly xdg: string;
  readonly gitconfig: string;
  readonly ssh: string;
  readonly remotes: string;
  readonly artifacts: string;
  readonly tmp: string;
  /** A path inside the test root. */
  at(...parts: string[]): string;
  remove(): void;
}

/**
 * A new test root in the system's temporary folder, or below `base`: the WSL scenario (Step 16) puts its whole root
 * inside a distribution, `\\wsl.localhost\<distribution>\tmp`, so its copy target is there and still in the test root.
 */
export function createTestRoot(prefix = 'app-test-', base = os.tmpdir()): TestRoot {
  const root = realpathSync(mkdtempSync(path.join(base, prefix)));
  const at = (...parts: string[]) => path.join(root, ...parts);
  const layout = {
    path: root,
    home: at('home'),
    appdata: at('appdata'),
    xdg: at('xdg'),
    gitconfig: at('gitconfig'),
    ssh: at('ssh'),
    remotes: at('remotes'),
    artifacts: at('artifacts'),
    tmp: at('tmp'),
  };
  for (const dir of [
    layout.home,
    layout.appdata,
    layout.xdg,
    layout.ssh,
    layout.remotes,
    layout.artifacts,
    layout.tmp,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  // ssh's own config and known hosts: test mode passes them to every ssh command (TESTING.md §3).
  writeFileSync(path.join(layout.ssh, 'config'), '');
  writeFileSync(path.join(layout.ssh, 'known_hosts'), '');
  writeFileSync(
    layout.gitconfig,
    '[user]\n\tname = Test User\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n' +
      // A root on another file system (WSL's) belongs to another owner as git sees it: git would refuse its repos.
      (base === os.tmpdir() ? '' : '[safe]\n\tdirectory = *\n'),
  );
  return { ...layout, at, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** A test root made earlier, e.g. by another process of the same test (the crash suite's restarts, TESTING.md §9.3). */
export function openTestRoot(root: string): TestRoot {
  const at = (...parts: string[]) => path.join(root, ...parts);
  return {
    path: root,
    home: at('home'),
    appdata: at('appdata'),
    xdg: at('xdg'),
    gitconfig: at('gitconfig'),
    ssh: at('ssh'),
    remotes: at('remotes'),
    artifacts: at('artifacts'),
    tmp: at('tmp'),
    at,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * The environment an app in this test root gets (TESTING.md §3 "Clean environment"): nothing of the developer's own
 * environment leaks in; a world adds the variables a test needs.
 */
export function testEnv(root: TestRoot, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const systemPath =
    process.platform === 'win32'
      ? [process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32'].join(';')
      : '/usr/bin:/bin:/usr/sbin:/sbin';
  const env: Record<string, string> = {
    HOME: root.home,
    USERPROFILE: root.home,
    APPDATA: root.at('appdata', 'Roaming'),
    LOCALAPPDATA: root.appdata,
    XDG_CONFIG_HOME: root.at('xdg', 'config'),
    XDG_DATA_HOME: root.at('xdg', 'data'),
    XDG_CACHE_HOME: root.at('xdg', 'cache'),
    GIT_CONFIG_GLOBAL: root.gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    TMPDIR: root.tmp,
    TMP: root.tmp,
    TEMP: root.tmp,
    TZ: 'UTC',
    LANG: 'en_US.UTF-8',
    PATH: systemPath,
    APP_TEST_ROOT: root.path,
  };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  // Linux: the display server, and the cookie that lets the app talk to it (xvfb-run sets both).
  for (const name of process.platform === 'linux' ? ['DISPLAY', 'XAUTHORITY'] : []) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return { ...env, ...extra };
}
