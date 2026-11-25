// The native module of the app: @parcel/watcher (ADR 0005, 0023). Its compiled code is in one package per system and CPU,
// an optional dependency that pnpm installs for the CPUs in pnpm-workspace.yaml (supportedArchitectures), and
// electron-builder copies the ones it finds on disk. If the package for the build's target is missing, the app stops at its
// start ("No prebuild or local build of @parcel/watcher found"). The Intel macOS app of the 1.0.0 draft did (2026-11-25).
// So every build checks the packaged app, after electron-builder made it and before the installers are made from it.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { AfterPackContext } from 'electron-builder';

/** The package that @parcel/watcher's index.js loads on a system and CPU. The Linux builds are for glibc systems. */
export function watcherPackage(platform: string, arch: string): string {
  return `@parcel/watcher-${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`;
}

/** The watcher's native file in the resources folder of a packaged app (electron-builder unpacks .node files). */
export function packagedWatcher(resourcesDir: string, platform: string, arch: string): string {
  const name = watcherPackage(platform, arch).split('/');
  return path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', ...name, 'watcher.node');
}

/** Whether pnpm installed the package next to @parcel/watcher, where electron-builder looks for it. */
function installedFor(appDir: string, platform: string, arch: string): boolean {
  try {
    const watcher = realpathSync(path.join(appDir, 'node_modules', '@parcel', 'watcher'));
    return existsSync(path.join(path.dirname(watcher), path.basename(watcherPackage(platform, arch)), 'watcher.node'));
  } catch {
    return false;
  }
}

/** Part of the `afterPack` hook: the app holds the watcher of its own system and CPU, or the build stops. */
export function checkPackagedWatcher(context: AfterPackContext, arch: string): void {
  const platform = context.electronPlatformName;
  const file = packagedWatcher(context.packager.getResourcesDir(context.appOutDir), platform, arch);
  if (existsSync(file)) return;
  const name = watcherPackage(platform, arch);
  const cause = installedFor(context.packager.info.appDir, platform, arch)
    ? 'pnpm installed it, but electron-builder did not copy it'
    : 'pnpm did not install it: see the pnpm install log, and supportedArchitectures in pnpm-workspace.yaml';
  throw new Error(`The app has no ${name}, so it would stop at its start (${file} is missing). ${cause}.`);
}
