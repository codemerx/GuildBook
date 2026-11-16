// The environment: every path the app uses comes from here, so tests run each "device" in its own temp home
// (IMPLEMENTATION.md §2.10). Nothing calls os.homedir() or reads process.env elsewhere.
import type { AbsPath } from '../shared/brand.ts';
import type { PathFlavour } from '../shared/paths.ts';

export type Platform = 'darwin' | 'win32' | 'linux';

export interface Env {
  readonly platform: Platform;
  readonly paths: PathFlavour;
  readonly home: AbsPath;
  /** Set in test mode: nothing outside it may be written (TESTING.md §3). */
  readonly testRoot: AbsPath | undefined;
  /** Live tests only (ADR 0033): the real home folder of one tool, e.g. `~/.claude`, where `aisstest-*` entries may go. */
  readonly liveToolHome?: AbsPath | undefined;
  /** An allowed environment variable. Variables that aren't allowed read as undefined. */
  variable(name: string): string | undefined;
}
