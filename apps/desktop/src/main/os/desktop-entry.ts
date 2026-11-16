// Invite links from an AppImage (IMPLEMENTATION.md Step 15, §0 "links opened from an AppImage"): an
// AppImage isn't installed, so no `.desktop` file tells the desktop which program opens the app's links. The app
// writes one for itself in the user's applications folder, naming the AppImage's own path, and makes it the handler
// of its scheme. A moved AppImage writes it again at its next start.
// Launch at login on Linux (Step 17, PLAN.md §3.19): Electron has no login items there, so the app writes the XDG
// autostart entry itself, in `$XDG_CONFIG_HOME/autostart`, and removes it when the user switches launch at login off.
import { brand } from '@app/brand';
import type { AbsPath, FileSystem, Logger, PathFlavour, ProcessRunner } from '@app/core';
import { OPENED_AT_LOGIN_ARG } from './integrations.ts';

/** The file's name: the desktop looks it up by this name in `~/.local/share/applications`. */
export const DESKTOP_FILE_NAME = `${brand.packageName}-links.desktop`;

/** Quotes a path for the `Exec` line (the Desktop Entry Specification's rules). */
function quoteExec(path: string): string {
  return `"${path.replace(/(["`$\\])/g, '\\$1')}"`;
}

/** The `.desktop` file that opens the app's links with this AppImage. */
export function appImageDesktopEntry(options: { readonly appImage: string; readonly scheme: string }): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${brand.displayName}`,
    `Exec=${quoteExec(options.appImage)} %u`,
    'Terminal=false',
    'NoDisplay=true',
    `MimeType=x-scheme-handler/${options.scheme};`,
    '',
  ].join('\n');
}

/** Whether this start is an AppImage's: the AppImage runtime sets APPIMAGE to the file's path. */
export function appImagePath(env: Readonly<Record<string, string | undefined>>): string | null {
  const path = env.APPIMAGE;
  return path && path.startsWith('/') ? path : null;
}

/**
 * Writes the AppImage's `.desktop` file into the user's applications folder and makes it the scheme's handler with
 * xdg-mime. A failure is logged: links then don't open the app, and everything else works.
 */
export async function registerAppImageLinks(deps: {
  readonly fs: Pick<FileSystem, 'mkdirp' | 'writeTextAtomic'>;
  readonly process: ProcessRunner;
  readonly paths: PathFlavour;
  /** `$XDG_DATA_HOME`, or `~/.local/share`. */
  readonly dataHome: string;
  readonly appImage: string;
  readonly scheme: string;
  readonly logger: Logger;
}): Promise<boolean> {
  const dir = deps.paths.join(deps.dataHome, 'applications');
  try {
    await deps.fs.mkdirp(dir as AbsPath);
    await deps.fs.writeTextAtomic(
      deps.paths.join(dir, DESKTOP_FILE_NAME) as AbsPath,
      appImageDesktopEntry({ appImage: deps.appImage, scheme: deps.scheme }),
    );
    const result = await deps.process.run(
      'xdg-mime',
      ['default', DESKTOP_FILE_NAME, `x-scheme-handler/${deps.scheme}`],
      {
        timeoutMs: 10_000,
      },
    );
    if (result.code !== 0) deps.logger.warn('xdg-mime did not take the link handler', { code: result.code });
    return result.code === 0;
  } catch (error) {
    deps.logger.warn('the link handler for the AppImage was not written', { error: String(error) });
    return false;
  }
}

/** The autostart entry's name, in `$XDG_CONFIG_HOME/autostart` (the Desktop Application Autostart Specification). */
export const AUTOSTART_FILE_NAME = `${brand.packageName}.desktop`;

/** The autostart entry: the app's program, with the argument that says the start came from the login (A15.8). */
export function autostartEntry(options: { readonly program: string }): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${brand.displayName}`,
    `Exec=${quoteExec(options.program)} ${OPENED_AT_LOGIN_ARG}`,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/**
 * Writes or removes the autostart entry. The program is the AppImage's own path from an AppImage (its mounted folder
 * changes at each start), otherwise the app's executable. A failure is logged: the app then doesn't start at login.
 */
export async function setLinuxAutostart(deps: {
  readonly fs: Pick<FileSystem, 'mkdirp' | 'writeTextAtomic' | 'remove' | 'lstat'>;
  readonly paths: PathFlavour;
  /** `$XDG_CONFIG_HOME`, or `~/.config`. */
  readonly configHome: string;
  readonly program: string;
  readonly on: boolean;
  readonly logger: Logger;
}): Promise<boolean> {
  const dir = deps.paths.join(deps.configHome, 'autostart');
  const file = deps.paths.join(dir, AUTOSTART_FILE_NAME) as AbsPath;
  try {
    if (deps.on) {
      await deps.fs.mkdirp(dir as AbsPath);
      await deps.fs.writeTextAtomic(file, autostartEntry({ program: deps.program }));
    } else if (await deps.fs.lstat(file)) await deps.fs.remove(file);
    deps.logger.info('the autostart entry was set', { on: deps.on });
    return true;
  } catch (error) {
    deps.logger.warn('the autostart entry was not set', { on: deps.on, error: String(error) });
    return false;
  }
}
