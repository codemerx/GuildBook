// The Git port's guard (IMPLEMENTATION.md §2.10, ADR 0017). git reads files itself, outside the guarded file system,
// so every command passes here first:
// - in the library (and the folders it's downloaded or moved to), anything the port offers runs;
// - in any other repo, a code repo, only what PLAN.md §3.7 rule 4 allows: its remote, its worktree list, where its
//   exclude file is, and whether one path is committed;
// - in a folder picked to import from, or the app's clone of an import URL (PLAN.md §3.18), only its remote, its current
//   commit and where the folder sits in its repo;
// - with no repo at all, only commands that read no repo: the version, `ls-remote`, and a clone into a library root
//   or an import folder.
import { AppError, type PathFlavour } from '@app/core';

export type GitRole = 'library' | 'code' | 'import' | 'none';

export interface GitCommand {
  /** The folder git runs in. */
  readonly cwd: string;
  readonly args: readonly string[];
}

export interface GitGuardOptions {
  readonly paths: PathFlavour;
  /** The folders whose repos are libraries: the library, its temporary download folder, its relocation targets. */
  readonly libraryRoots: () => readonly string[];
  /** The folder repo-less commands run in (outside every repo). */
  readonly neutralDir: string;
  /** Folders picked to import from, and the folder the app clones import URLs into (PLAN.md §3.18). */
  readonly importRoots?: () => readonly string[];
}

const isPathArg = (arg: string | undefined): arg is string =>
  arg !== undefined && arg !== '' && !arg.startsWith('-') && !arg.includes('\0');

/** The exact command shapes allowed in a code repo (PLAN.md §3.7 rule 4). */
export function allowedInCodeRepo(args: readonly string[]): boolean {
  const [a, b, c, d, e, f] = args;
  switch (args.length) {
    case 3:
      // git remote get-url <name>
      return a === 'remote' && b === 'get-url' && isPathArg(c) && /^[A-Za-z0-9._-]+$/.test(c);
    case 4:
      // git worktree list --porcelain -z | git rev-parse --path-format=absolute --git-path info/exclude
      return (
        (a === 'worktree' && b === 'list' && c === '--porcelain' && d === '-z') ||
        (a === 'rev-parse' && b === '--path-format=absolute' && c === '--git-path' && d === 'info/exclude')
      );
    case 6:
      // git ls-tree -z --name-only HEAD -- <path>
      return a === 'ls-tree' && b === '-z' && c === '--name-only' && d === 'HEAD' && e === '--' && isPathArg(f);
    default:
      return false;
  }
}

/** The exact command shapes allowed in an import source (PLAN.md §3.18): what `metadata.source` records. */
export function allowedInImportSource(args: readonly string[]): boolean {
  const shape = args.join(' ');
  return (
    shape === 'remote get-url origin' ||
    shape === 'rev-parse --verify --quiet HEAD^{commit}' ||
    shape === 'rev-parse --show-prefix'
  );
}

/**
 * Repo-less commands, in their exact shapes: options that run programs (`--upload-pack`, `--config`, …) can't slip
 * in, and a URL always follows `--`.
 */
export function allowedWithoutRepo(args: readonly string[], options: GitGuardOptions): boolean {
  const [command] = args;
  if (args.length === 1 && command === '--version') return true;
  if (command === 'ls-remote') {
    // git ls-remote --symref -- <url> HEAD refs/heads/*
    return (
      args.length === 6 &&
      args[1] === '--symref' &&
      args[2] === '--' &&
      isPathArg(args[3]) &&
      args[4] === 'HEAD' &&
      args[5] === 'refs/heads/*'
    );
  }
  if (command === 'clone') {
    // git clone --progress [--depth 1] [--branch <name>] -- <url> <dest>, into a library root or an import folder
    const rest = args.slice(2);
    const shallow = rest[0] === '--depth' && rest[1] === '1' ? rest.splice(0, 2) : undefined;
    const branch = rest[0] === '--branch' ? rest.splice(0, 2)[1] : undefined;
    const [dashes, url, dest] = rest;
    return (
      args[1] === '--progress' &&
      rest.length === 3 &&
      (branch === undefined || isPathArg(branch)) &&
      dashes === '--' &&
      isPathArg(url) &&
      isPathArg(dest) &&
      // A shallow clone only for an import: a library always has its whole history.
      (shallow === undefined ? isInsideAny(options, dest) : isInsideImport(options, dest))
    );
  }
  return false;
}

function isInsideAny(options: GitGuardOptions, path: string): boolean {
  return options.libraryRoots().some((root) => options.paths.isInside(root, path)) || isInsideImport(options, path);
}

function isInsideImport(options: GitGuardOptions, path: string): boolean {
  return (options.importRoots?.() ?? []).some((root) => options.paths.isInside(root, path));
}

export function roleOf(cwd: string, options: GitGuardOptions): GitRole {
  if (options.paths.same(cwd, options.neutralDir)) return 'none';
  if (options.libraryRoots().some((root) => options.paths.isInside(root, cwd))) return 'library';
  return isInsideImport(options, cwd) ? 'import' : 'code';
}

/** Throws `git.notAllowed` for a command that the folder's role doesn't allow. */
export function checkCommand(command: GitCommand, options: GitGuardOptions): GitRole {
  const role = roleOf(command.cwd, options);
  const allowed =
    role === 'library'
      ? true
      : role === 'code'
        ? allowedInCodeRepo(command.args)
        : role === 'import'
          ? allowedInImportSource(command.args)
          : allowedWithoutRepo(command.args, options);
  if (!allowed) throw new AppError('git.notAllowed', { command: command.args[0] ?? '', role });
  return role;
}
