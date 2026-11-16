// Pure path handling in an injected flavour (IMPLEMENTATION.md §2.2): core never asks the OS how paths work, so the
// Windows rules are unit-tested on every OS. Paths from the Environment are absolute; relative parts are joined to
// them. Normalizing removes `.` and `..` (never above the root) and any trailing separator.

export interface PathFlavour {
  readonly name: 'posix' | 'win32';
  readonly sep: '/' | '\\';
  /** Fully qualified: `/…` on POSIX; `C:\…` or `\\server\share\…` on Windows. */
  isAbsolute(path: string): boolean;
  normalize(path: string): string;
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  /** `path` is `root` or lies below it. */
  isInside(root: string, path: string): boolean;
  /** The part of `path` below `root`, or undefined when it isn't inside. `''` when they're equal. */
  relative(root: string, path: string): string | undefined;
  /** The two paths name the same location, as the OS compares names (case-insensitively on Windows). */
  same(a: string, b: string): boolean;
}

interface Split {
  root: string;
  segments: string[];
}

function resolveSegments(raw: string[], absolute: boolean): string[] {
  const out: string[] = [];
  for (const segment of raw) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  return out;
}

function makeFlavour(
  name: PathFlavour['name'],
  sep: PathFlavour['sep'],
  split: (path: string) => Split,
  absolute: (path: string) => boolean,
  fold: (path: string) => string,
): PathFlavour {
  const format = ({ root, segments }: Split): string => {
    if (segments.length === 0) return root === '' ? '.' : root;
    return root + segments.join(sep);
  };
  const normalize = (path: string): string => format(split(path));

  const flavour: PathFlavour = {
    name,
    sep,
    isAbsolute: absolute,
    normalize,
    join: (...parts) => normalize(parts.filter((part) => part !== '').join(sep)),
    dirname(path) {
      const parts = split(path);
      if (parts.segments.length === 0) return format(parts);
      return format({ root: parts.root, segments: parts.segments.slice(0, -1) });
    },
    basename(path) {
      const { segments } = split(path);
      return segments.at(-1) ?? '';
    },
    isInside(root, path) {
      return flavour.relative(root, path) !== undefined;
    },
    relative(root, path) {
      const base = split(root);
      const target = split(path);
      if (fold(base.root) !== fold(target.root)) return undefined;
      if (target.segments.length < base.segments.length) return undefined;
      for (let i = 0; i < base.segments.length; i++) {
        if (fold(base.segments[i] ?? '') !== fold(target.segments[i] ?? '')) return undefined;
      }
      if (target.segments.slice(base.segments.length).includes('..')) return undefined;
      return target.segments.slice(base.segments.length).join(sep);
    },
    same: (a, b) => fold(normalize(a)) === fold(normalize(b)),
  };
  return flavour;
}

export const posixPaths: PathFlavour = makeFlavour(
  'posix',
  '/',
  (path) => {
    const isAbs = path.startsWith('/');
    return { root: isAbs ? '/' : '', segments: resolveSegments(path.split('/'), isAbs) };
  },
  (path) => path.startsWith('/'),
  (path) => path,
);

const driveRoot = /^([a-zA-Z]):(?:[\\/]|$)/;
const uncRoot = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]|$)/;

export const win32Paths: PathFlavour = makeFlavour(
  'win32',
  '\\',
  (path) => {
    const unc = uncRoot.exec(path);
    if (unc) {
      return {
        root: `\\\\${unc[1]}\\${unc[2]}\\`,
        segments: resolveSegments(path.slice(unc[0].length).split(/[\\/]/), true),
      };
    }
    const drive = driveRoot.exec(path);
    if (drive) {
      return { root: `${drive[1]}:\\`, segments: resolveSegments(path.slice(drive[0].length).split(/[\\/]/), true) };
    }
    return { root: '', segments: resolveSegments(path.split(/[\\/]/), false) };
  },
  (path) => driveRoot.test(path) || uncRoot.test(path),
  (path) => path.toLowerCase(),
);

export function pathFlavourFor(platform: 'darwin' | 'win32' | 'linux'): PathFlavour {
  return platform === 'win32' ? win32Paths : posixPaths;
}
