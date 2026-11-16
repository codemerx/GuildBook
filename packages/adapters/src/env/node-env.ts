// The Environment on Node (IMPLEMENTATION.md §2.10): the one place that reads the home folder and the process
// environment. In test mode the home folder is the test root's, and a path variable pointing outside the test root is
// refused (TESTING.md §3).
import { type AbsPath, type Env, pathFlavourFor, type Platform, PROXY_VARIABLES } from '@app/core';
import os from 'node:os';
import path from 'node:path';

/** Variables any part of the app may read. Others read as undefined. */
export const BASE_VARIABLES = [
  'PATH',
  'SHELL',
  'SSH_AUTH_SOCK',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'TZ',
  'LANG',
  ...PROXY_VARIABLES,
] as const;

const PATH_VARIABLES = new Set(['LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']);

export interface NodeEnvOptions {
  /** Test mode: everything lives in this folder. */
  readonly testRoot?: string;
  /** Live tests only (ADR 0033, needs a test root): the real home folder of a tool, e.g. `~/.claude`. */
  readonly liveToolHome?: string;
  /** Further variable names the app may read, e.g. the catalog's home_env variables. */
  readonly allow?: readonly string[];
  readonly source?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export function currentPlatform(platform: NodeJS.Platform = process.platform): Platform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform;
  throw new Error(`unsupported platform ${platform}`);
}

export function nodeEnv(options: NodeEnvOptions = {}): Env {
  const platform = currentPlatform(options.platform);
  const paths = pathFlavourFor(platform);
  const source = options.source ?? process.env;
  const allowed = new Set<string>([...BASE_VARIABLES, ...(options.allow ?? [])]);
  const testRoot = options.testRoot === undefined ? undefined : path.resolve(options.testRoot);
  if (testRoot !== undefined && !path.isAbsolute(testRoot)) throw new Error('the test root must be an absolute path');
  const home = testRoot === undefined ? os.homedir() : path.join(testRoot, 'home');
  if (options.liveToolHome !== undefined) {
    if (testRoot === undefined) throw new Error('the live tool home needs test mode');
    if (!path.isAbsolute(options.liveToolHome)) throw new Error('the live tool home must be an absolute path');
  }
  const liveToolHome = options.liveToolHome === undefined ? undefined : paths.normalize(options.liveToolHome);

  return {
    platform,
    paths,
    home: home as AbsPath,
    testRoot: testRoot as AbsPath | undefined,
    ...(liveToolHome === undefined ? {} : { liveToolHome: liveToolHome as AbsPath }),
    variable(name) {
      if (!allowed.has(name)) return undefined;
      const value = source[name];
      if (value === undefined || testRoot === undefined || !PATH_VARIABLES.has(name)) return value;
      if (!paths.isInside(testRoot, paths.normalize(value))) {
        throw new Error(`test mode: ${name} points outside the test root`);
      }
      return value;
    },
  };
}

/** This computer's name, for device.json (PLAN.md §3.1). Tests use a fixed one. */
export function hostName(): string {
  return os.hostname();
}
