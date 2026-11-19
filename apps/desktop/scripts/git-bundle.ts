// What the installers keep of the Git program that the npm package dugite brings (ADR 0035, decision 7).
//
// dugite downloads a whole archive of the project dugite-native, which GitHub Desktop makes. Besides Git and Git LFS the
// archive holds Git Credential Manager (GCM): a .NET program with its own runtime and a window toolkit (Avalonia, SkiaSharp,
// HarfBuzzSharp), 29 to 95 MB per system. The app never starts it: git-env.ts clears every credential helper, and the app
// signs in with a header or an SSH key. GCM would only add files to sign and license texts to pass on.
//
// So the build deletes GCM from the PACKAGED copy of the Git folder, in the afterPack hook of electron-builder: after the
// files are copied and before the app is signed. The folder in node_modules stays as dugite made it. Nobody deletes
// anything by hand after an install, and every build does it again.
//
// The rules that delete are narrow: they name what GCM brings. The checks are wide: a production build stops when a file
// of GCM stays, when an unknown file stands where GCM stood, when a program that the app needs is gone, or when the Git
// of the package does not start. A new dugite-native release can move files; then the build stops and tells which.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { setupEnvironment } from 'dugite';
import type { AfterPackContext } from 'electron-builder';

/** The Git folder of dugite inside the resources folder of the packaged app (`asarUnpack` in build.ts). */
export const PACKAGED_GIT = ['app.asar.unpacked', 'node_modules', 'dugite', 'git'];

/** macOS and Linux: the folder of the helper programs of Git. GCM puts its files here. */
const UNIX_CORE = 'libexec/git-core';

/**
 * Windows: the folders of the Git for Windows build (x64, arm64, x86). GCM puts its files in bin and doc. x64 is `ucrt64`
 * since dugite 3.3 (dugite-native v2.56.1); it was `mingw64` before.
 */
const WINDOWS_PREFIXES = ['ucrt64', 'clangarm64', 'mingw32'];

/**
 * macOS and Linux, files of GCM next to the programs of Git (Git has no file of these names there):
 * the program and its files (`git-credential-manager`, `.deps.json`, `.runtimeconfig.json`), the dump tool of the .NET
 * runtime (`createdump`), the notice and the uninstall script of GCM, and every library (.NET assemblies, runtime
 * libraries, the window toolkit).
 */
const UNIX_GCM = /^(git-credential-manager(\..+)?|createdump|NOTICE|uninstall\.sh|.+\.(dll|dylib|so(\.\d+)*))$/;

/**
 * Windows, files of GCM in bin of the prefix, among the programs and libraries of Git for Windows: the program and its
 * `.exe.config`, its core library, the .NET libraries and the providers (Atlassian, GitHub, GitLab, Microsoft, System),
 * the window toolkit (Avalonia, SkiaSharp, HarfBuzzSharp, ANGLE) and the Microsoft sign-in runtime (msalruntime).
 */
const WINDOWS_GCM =
  /^(git-credential-manager(\..+)?|gcmcore\.dll|(Atlassian|Avalonia|GitHub|GitLab|Microsoft|System)(\..+)?\.dll|MicroCom\.Runtime\.dll|(lib)?(SkiaSharp|HarfBuzzSharp)\.dll|av_libglesv2\.dll|msalruntime[^/]*\.dll)$/;

/** A library of Git for Windows (MinGW): lower case and `lib` first, or zlib1.dll. A .NET library has another name. */
const WINDOWS_GIT_LIBRARY = /^(lib[a-z0-9_+.-]+|zlib1)\.dll$/;

/** Words that only GCM and the .NET runtime bring. The check looks for them in every path of the Git folder. */
const LOOKS_LIKE_GCM =
  /credential-manager|gcmcore|Avalonia|SkiaSharp|HarfBuzzSharp|msalruntime|Microsoft\.Identity|coreclr|hostfxr|hostpolicy|createdump|\.deps\.json$|\.runtimeconfig\.json$/i;

function isDirectory(folder: string): boolean {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/** The names of the files below a folder, relative to it, with `/`. A link counts as a file and is not followed. */
function walk(root: string, relative = ''): string[] {
  const folder = path.join(root, relative);
  if (!isDirectory(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(root, next) : [next];
  });
}

/** The prefix folders of Git for Windows that this Git folder has. */
function windowsPrefixes(gitDir: string): string[] {
  return WINDOWS_PREFIXES.filter((prefix) => isDirectory(path.join(gitDir, prefix, 'bin')));
}

/** The files of GCM in a Git folder, relative to it, with `/`. Nothing is changed. */
export function credentialManagerFiles(gitDir: string): string[] {
  const found: string[] = [];
  for (const relative of walk(gitDir, UNIX_CORE)) {
    const inside = relative.slice(UNIX_CORE.length + 1);
    const parts = inside.split('/');
    // mergetools/ is a folder of Git. The other folders hold the translated texts of GCM (System.CommandLine.resources.dll).
    if (parts[0] === 'mergetools') continue;
    const name = parts.at(-1) ?? '';
    if (parts.length === 1 ? UNIX_GCM.test(name) : name.endsWith('.dll')) found.push(relative);
  }
  for (const prefix of windowsPrefixes(gitDir)) {
    for (const relative of walk(gitDir, `${prefix}/bin`)) {
      if (relative.split('/').length === 3 && WINDOWS_GCM.test(path.posix.basename(relative))) found.push(relative);
    }
    found.push(...walk(gitDir, `${prefix}/doc/git-credential-manager`));
    const page = `${prefix}/share/doc/git-doc/git-credential-manager.html`;
    if (existsSync(path.join(gitDir, page))) found.push(page);
  }
  return found.sort();
}

/**
 * Deletes the files of GCM, and the folders that this empties. Returns what it deleted, with the size.
 * It changes only the folder it is given.
 */
export function removeCredentialManager(gitDir: string): { files: string[]; bytes: number } {
  const root = path.resolve(gitDir);
  const files = credentialManagerFiles(root);
  let bytes = 0;
  for (const relative of files) {
    const full = path.join(root, relative);
    bytes += lstatSync(full).size;
    // recursive makes rmSync retry when Windows holds the file for a moment (a virus scanner); the path is a file or a link.
    rmSync(full, { recursive: true, maxRetries: 5, retryDelay: 200 });
    // A folder that this deletion emptied goes too (the folders of translated texts, the doc folder of GCM).
    for (
      let folder = path.dirname(full);
      folder !== root && readdirSync(folder).length === 0;
      folder = path.dirname(folder)
    ) {
      rmdirSync(folder);
    }
  }
  return { files, bytes };
}

/** The programs that the app needs, relative to the Git folder, for the layout that the folder has. */
function neededPrograms(gitDir: string): string[] {
  if (isDirectory(path.join(gitDir, UNIX_CORE))) {
    return ['bin/git', `${UNIX_CORE}/git-remote-https`, `${UNIX_CORE}/git-lfs`];
  }
  const prefixes = windowsPrefixes(gitDir);
  if (prefixes.length === 0) return [];
  return [
    'cmd/git.exe',
    ...prefixes.flatMap((p) => [`${p}/bin/git-remote-https.exe`, `${p}/libexec/git-core/git-lfs.exe`]),
  ];
}

/** What is wrong with a Git folder after GCM is deleted. An empty list means nothing. The folder is not changed. */
export function gitFolderProblems(gitDir: string): string[] {
  if (!isDirectory(gitDir)) return [`the Git folder of dugite is not in the app: ${gitDir}`];
  const problems: string[] = [];

  const left = walk(gitDir).filter((relative) => LOOKS_LIKE_GCM.test(relative));
  if (left.length > 0) {
    problems.push(
      `${left.length} files of Git Credential Manager or the .NET runtime stay in the Git folder, for example ${left.slice(0, 3).join(', ')}`,
    );
  }

  // Where GCM stood, only the files of Git may stay. A file that nobody knows may be a new file of GCM.
  const core = path.join(gitDir, UNIX_CORE);
  if (isDirectory(core)) {
    const unknown = readdirSync(core).filter(
      (name) => !/^git/.test(name) && name !== 'scalar' && name !== 'mergetools',
    );
    if (unknown.length > 0) {
      problems.push(`${UNIX_CORE} holds files that are not of Git: ${unknown.slice(0, 5).join(', ')}`);
    }
  }
  for (const prefix of windowsPrefixes(gitDir)) {
    const bin = path.join(gitDir, prefix, 'bin');
    const unknown = readdirSync(bin).filter((name) => name.endsWith('.dll') && !WINDOWS_GIT_LIBRARY.test(name));
    if (unknown.length > 0) {
      problems.push(`${prefix}/bin holds libraries that are not of Git for Windows: ${unknown.slice(0, 5).join(', ')}`);
    }
  }

  const needed = neededPrograms(gitDir);
  if (needed.length === 0) problems.push('the Git folder has no layout that the build knows (macOS, Linux or Windows)');
  for (const relative of needed) {
    if (!existsSync(path.join(gitDir, relative))) problems.push(`${relative} is missing in the Git folder`);
  }
  return problems;
}

/**
 * Starts the Git of the folder: `git --version` and `git lfs version`, with the environment that the app gives it (dugite's
 * own). It proves that the folder works after the deletion. A program of another system or architecture cannot start here.
 */
export function gitRunProblems(gitDir: string): string[] {
  const { env, gitLocation } = setupEnvironment({ LOCAL_GIT_DIRECTORY: gitDir, GIT_CONFIG_GLOBAL: '/dev/null' });
  const problems: string[] = [];
  for (const args of [['--version'], ['lfs', 'version']]) {
    try {
      execFileSync(gitLocation, args, { env, stdio: 'pipe', timeout: 60_000, windowsHide: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push(`git ${args.join(' ')} does not start in the packaged Git folder: ${reason.split('\n')[0]}`);
    }
  }
  return problems;
}

export interface GitHookOptions {
  /** A production build stops on a problem; another build only reports it. */
  enforce: boolean;
  /** The architecture that this build packs (x64, arm64). Git starts here only when it is the architecture of this machine. */
  arch: string;
}

/** The `afterPack` hook of electron-builder: deletes GCM from the app and checks what stays. */
export function afterPackGit(options: GitHookOptions): (context: AfterPackContext) => void {
  return (context) => {
    const gitDir = path.join(context.packager.getResourcesDir(context.appOutDir), ...PACKAGED_GIT);
    const problems: string[] = [];
    if (isDirectory(gitDir)) {
      const { files, bytes } = removeCredentialManager(gitDir);
      process.stdout.write(
        files.length > 0
          ? `Git Credential Manager: ${files.length} files (${(bytes / 1e6).toFixed(1)} MB) deleted from the Git folder of the app\n`
          : 'Git Credential Manager: none in the Git folder of this system\n',
      );
      problems.push(...gitFolderProblems(gitDir));
      if (options.arch === process.arch) problems.push(...gitRunProblems(gitDir));
    } else {
      problems.push(...gitFolderProblems(gitDir));
    }
    if (problems.length === 0) return;
    const text = `Git folder of the app (scripts/git-bundle.ts, ADR 0035):\n  - ${problems.join('\n  - ')}`;
    if (options.enforce) throw new Error(text);
    process.stderr.write(`${text}\n(not enforced in a build with test hooks)\n`);
  };
}
