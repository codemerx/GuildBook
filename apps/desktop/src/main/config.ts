// How main starts, read from its command line and environment before anything else (IMPLEMENTATION.md §2.12, §2.16):
// - production builds refuse debugging switches, which no Electron fuse covers (ADR 0021)
// - test-hooks builds need a test root and refuse to start without one (TESTING.md §3, A1.7); only a person can run a
//   development build on the real home folder, through `pnpm dev:real-home`
// - `--device-operation=<kind>` runs one device operation without a window and exits (IMPLEMENTATION.md §2.6)
// - `--test-inactive-window` or `APP_TEST_INACTIVE_WINDOW=1` (test builds): the window opens without taking the focus,
//   so a test run doesn't take the keyboard from the person at the computer (macOS; TESTING.md §3)
// - `--test-no-tray` (test builds): the desktop has no tray, as GNOME without the AppIndicator extension (Step 17)
// - `--test-locale=pseudo` (test builds): the pseudo-locale, long accented text that shows clipping and untranslated
//   text (TESTING.md §7.2, Step 17)
// - `--test-release-url=<url>` (test builds): the test's release host, which serves the update feed and the signed
//   tool catalog (Step 18)
// - `APP_TEST_LIVE_TOOL_HOME=<folder>` (test builds, with a test root): the live exception of ADR 0033

import { liveToolHomeOf } from '../shared/live.ts';

export type Variant = 'production' | 'test-hooks';

export interface MainConfig {
  readonly variant: Variant;
  readonly devBuild: boolean;
  /** Test mode: every path comes from here. */
  readonly testRoot: string | undefined;
  /** Test mode: all network traffic goes through this recording proxy (TESTING.md §3). */
  readonly testProxy: string | undefined;
  /** A development build on the real home folder, after a person confirmed it. */
  readonly realHome: boolean;
  /** The no-window mode. */
  readonly deviceOperation: { readonly kind: string; readonly instance: string | undefined } | undefined;
  /** Test runs: the window opens without taking the focus, and the app never becomes the active one (macOS). */
  readonly inactiveWindow: boolean;
  /** Test runs: the desktop has no tray, so the window's small status view stands in for it (PLAN.md §3.19). */
  readonly noTray: boolean;
  /** The language of the window: English, or the pseudo-locale in test runs. */
  readonly locale: 'en' | 'pseudo';
  /** Test runs: where the test's release host serves the update feed and the catalog (release-feed.ts). */
  readonly releaseUrl: string | undefined;
  /** Live tests only (ADR 0033): the real home folder of a tool, where `aisstest-*` entries may go. */
  readonly liveToolHome: string | undefined;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: MainConfig }
  | { readonly ok: false; readonly exitCode: number; readonly message: string };

/** Chromium and Node switches that open the app to a debugger. */
const debuggingSwitch =
  /^--(remote-debugging-port|remote-debugging-pipe|inspect|inspect-brk|inspect-port|inspect-publish-uid|debug|debug-brk)(=|$)/;

export const EXIT_DEBUGGING_REFUSED = 64;
export const EXIT_NO_TEST_ROOT = 65;

function option(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit?.slice(prefix.length);
}

export function readConfig(input: {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly variant: Variant;
  readonly devBuild: boolean;
}): ConfigResult {
  const { argv, env, variant, devBuild } = input;
  const kind = option(argv, 'device-operation');
  const deviceOperation = kind ? { kind, instance: option(argv, 'instance') } : undefined;

  if (variant === 'production') {
    const refused = argv.filter((arg) => debuggingSwitch.test(arg));
    if (refused.length > 0) {
      return {
        ok: false,
        exitCode: EXIT_DEBUGGING_REFUSED,
        message: `refusing to start with debugging switches: ${refused.join(' ')}`,
      };
    }
    return {
      ok: true,
      config: {
        variant,
        devBuild: false,
        testRoot: undefined,
        testProxy: undefined,
        realHome: false,
        deviceOperation,
        inactiveWindow: false,
        noTray: false,
        locale: 'en',
        releaseUrl: undefined,
        liveToolHome: undefined,
      },
    };
  }

  const testRoot = option(argv, 'test-root') ?? env.APP_TEST_ROOT;
  const realHome = devBuild && env.APP_DEV_REAL_HOME === 'confirmed';
  if (!testRoot && !realHome) {
    return {
      ok: false,
      exitCode: EXIT_NO_TEST_ROOT,
      message: 'test mode needs a test root: start with --test-root=<folder> (TESTING.md §3)',
    };
  }
  return {
    ok: true,
    config: {
      variant,
      devBuild,
      testRoot: realHome ? undefined : testRoot,
      testProxy: option(argv, 'test-proxy') ?? env.APP_TEST_PROXY,
      realHome,
      deviceOperation,
      inactiveWindow: argv.includes('--test-inactive-window') || env.APP_TEST_INACTIVE_WINDOW === '1',
      noTray: argv.includes('--test-no-tray'),
      locale: option(argv, 'test-locale') === 'pseudo' ? 'pseudo' : 'en',
      releaseUrl: option(argv, 'test-release-url'),
      liveToolHome: realHome ? undefined : liveToolHomeOf(env, testRoot),
    },
  };
}
