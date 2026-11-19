// The notices of the third-party software in the app (ADR 0035). Whoever gives out the app must give out the license text of
// each part with it. The parts come from four places:
//   bundled   npm packages that Vite copies into the three bundles of the app (main, preload, renderer). The Vite plugin
//             bundledPackages() writes a list of them next to each bundle.
//   shipped   npm packages that stay as files in the app: dugite, @parcel/watcher and what they need.
//   style     packages whose CSS and font files Vite copies, although no JavaScript module imports them.
//   programs  Electron with Chromium, and the Git program that dugite brings. Both differ from system to system.
// writeNotices() joins them, stops a production build on a license that nobody approved (ALLOWED_LICENSES), and writes
// THIRD_PARTY_NOTICES.txt, which build.ts puts into the resources of the installers.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export const BUNDLED_PACKAGES_FILE = 'bundled-packages.json';
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';
const BUNDLES = ['main', 'preload', 'renderer'] as const;

/**
 * Packages whose CSS or font files go into the renderer without a JavaScript import (src/renderer/styles.css). A font
 * file in the renderer that none of them holds stops the build, so a new font cannot slip in without its license.
 */
export const STYLE_PACKAGES = ['tailwindcss', '@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono'];

/**
 * The licenses (SPDX identifiers) that the owner approved for software in the app. All of them ask only for the copyright
 * notice and the license text, which this file passes on. A package under any other license stops a production build:
 * copyleft licenses (GPL, LGPL, AGPL, MPL, EPL) and licenses with limits (CC-BY-NC, SSPL, BUSL) need a decision first.
 */
export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'Zlib',
  'Python-2.0',
  'Unlicense',
  'CC0-1.0',
  // The license of fonts: the notice goes with the font files.
  'OFL-1.1',
]);

/** One part of the app and the texts that its license asks us to give out. */
export interface Notice {
  name: string;
  version: string;
  /** The SPDX expression that the package states, or UNKNOWN. */
  license: string;
  url: string | null;
  /** The license and notice files of the package, each text once. */
  texts: string[];
  /** The package has no license file: the text is the standard text of its license, with the author as holder. */
  generated: boolean;
}

/** True when the expression ("MIT", "(MPL-2.0 OR Apache-2.0)", "A AND B") holds only approved licenses, or has one in each OR. */
export function licenseAllowed(expression: string, allowed: ReadonlySet<string> = ALLOWED_LICENSES): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const fail = (): never => {
    throw new Error(`"${expression}" is not a license expression`);
  };
  const atom = (): boolean => {
    const token = tokens[at++];
    if (token === undefined || token === ')' || token === 'AND' || token === 'OR' || token === 'WITH') return fail();
    if (token === '(') {
      const inner = either();
      if (tokens[at++] !== ')') fail();
      return inner;
    }
    if (tokens[at] === 'WITH') {
      const exception = tokens[at + 1] ?? fail();
      at += 2;
      return allowed.has(`${token} WITH ${exception}`);
    }
    return allowed.has(token);
  };
  const both = (): boolean => {
    let ok = atom();
    while (tokens[at] === 'AND') {
      at++;
      const next = atom();
      ok = ok && next;
    }
    return ok;
  };
  const either = (): boolean => {
    let ok = both();
    while (tokens[at] === 'OR') {
      at++;
      const next = both();
      ok = ok || next;
    }
    return ok;
  };
  const result = either();
  if (at !== tokens.length) fail();
  return result;
}

/**
 * The root folder of the npm package that holds a module, or null for a module of this repository. A module id is a
 * real path (pnpm keeps packages in node_modules/.pnpm/<name>@<version>/node_modules/<name>) with a prefix and a query
 * that the plugins of Vite add.
 */
export function packageRoot(moduleId: string): string | null {
  const file = moduleId.replace(/^\0/, '').replace(/\?.*$/, '').replaceAll('\\', '/');
  const marker = '/node_modules/';
  const at = file.lastIndexOf(marker);
  if (at < 0) return null;
  const parts = file.slice(at + marker.length).split('/');
  const name = parts[0]?.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
  if (name.length === 0 || name.some((part) => part === '') || (parts[0]?.startsWith('@') && name.length < 2))
    return null;
  return `${file.slice(0, at + marker.length)}${name.join('/')}`;
}

/**
 * A Vite plugin for each bundle: it writes the root folders of the npm packages that went into the bundle. The built-in
 * option build.license is not enough: it takes the nearest package.json of a module, so the folder @hookform/resolvers/zod
 * counts as a package of its own; it reads one license file; and it knows nothing of CSS that Tailwind inlines.
 */
export function bundledPackages(): Plugin {
  return {
    name: 'bundled-packages',
    generateBundle(_options, bundle) {
      const roots = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of output.moduleIds) {
          const root = packageRoot(id);
          if (root) roots.add(root);
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: BUNDLED_PACKAGES_FILE,
        source: `${JSON.stringify([...roots].sort(), null, 2)}\n`,
      });
    },
  };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** The folder of a package as Node would find it from a folder: node_modules of the folder, then of each parent. */
export function resolvePackage(from: string, name: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * The npm packages that electron-builder copies into the app: the production dependencies of the app and, from each
 * package, its production dependencies and its optional dependencies that are installed (the prebuilt files of
 * @parcel/watcher for this system). A missing production dependency is an error.
 */
export function shippedRoots(appDir: string): string[] {
  const found = new Set<string>();
  const visit = (dir: string): void => {
    const manifest = readJson(path.join(dir, 'package.json'));
    const names = (field: string): string[] => Object.keys(manifest[field] ?? {});
    for (const name of names('dependencies')) {
      const root = resolvePackage(dir, name);
      if (!root) throw new Error(`${name}, a dependency of ${dir}, is not installed`);
      if (!found.has(root)) {
        found.add(root);
        visit(root);
      }
    }
    for (const name of names('optionalDependencies')) {
      const root = resolvePackage(dir, name);
      if (root && !found.has(root)) {
        found.add(root);
        visit(root);
      }
    }
  };
  visit(appDir);
  return [...found];
}

const TEXT_FILE = /^(licen[cs]e|copying|notice|patents|unlicen[cs]e)([-_. ].*)?$/i;
const NOT_TEXT = /\.(c?js|mjs|tsx?|jsx|json|map|html?|css|ya?ml|png|jpe?g|gif|svg|ico|woff2?|ttf|otf)$/i;

/** A text as it goes into the notices: no byte order mark, LF line ends, no empty lines around it. */
export function clean(text: string): string {
  const withoutMark = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutMark.replace(/\r\n?/g, '\n').replace(/^\n+/, '').trimEnd();
}

/** The license and notice files in the root folder of a package, each text once. Apache-2.0 asks for the NOTICE file too. */
export function licenseTexts(root: string): string[] {
  const texts: string[] = [];
  const names = readdirSync(root).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    if (!TEXT_FILE.test(name) || NOT_TEXT.test(name) || !statSync(path.join(root, name)).isFile()) continue;
    const text = clean(readFileSync(path.join(root, name), 'utf8'));
    if (text && !texts.includes(text)) texts.push(text);
  }
  return texts;
}

function standardMit(holder: string): string {
  return `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

function licenseField(manifest: Record<string, unknown>): string {
  const one = (value: unknown): string | null => {
    if (typeof value === 'string') return value.trim() || null;
    const type = (value as { type?: unknown } | null)?.type;
    return typeof type === 'string' ? type.trim() || null : null;
  };
  const single = one(manifest.license);
  if (single) return single;
  if (Array.isArray(manifest.licenses)) {
    const ids = manifest.licenses.map(one).filter((id): id is string => id !== null);
    if (ids.length > 0) return ids.length === 1 ? (ids[0] ?? 'UNKNOWN') : `(${ids.join(' OR ')})`;
  }
  return 'UNKNOWN';
}

function urlField(manifest: Record<string, unknown>): string | null {
  const repository = manifest.repository;
  const fromRepository = typeof repository === 'string' ? repository : (repository as { url?: unknown } | null)?.url;
  const raw = typeof manifest.homepage === 'string' ? manifest.homepage : fromRepository;
  if (typeof raw !== 'string' || raw === '') return null;
  const url = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
}

function authorName(manifest: Record<string, unknown>): string | null {
  const author = manifest.author;
  const name = typeof author === 'string' ? author : (author as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name.replace(/\s*[<(].*$/, '').trim() || null : null;
}

/** What the notices say about the package in a folder. */
export function readPackage(root: string): Notice {
  const manifest = readJson(path.join(root, 'package.json'));
  const name = typeof manifest.name === 'string' ? manifest.name : path.basename(root);
  const license = licenseField(manifest);
  const texts = licenseTexts(root);
  const generated = texts.length === 0 && license === 'MIT';
  if (generated) texts.push(standardMit(authorName(manifest) ?? `the authors of ${name}`));
  return {
    name,
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    license,
    url: urlField(manifest),
    texts,
    generated,
  };
}

/** The reasons to refuse a part: no license text, or a license that nobody approved. */
export function licenseProblems(notices: readonly Notice[]): string[] {
  const problems: string[] = [];
  for (const notice of notices) {
    const id = `${notice.name}@${notice.version}`;
    if (notice.texts.length === 0) problems.push(`${id} has no license file (it states ${notice.license})`);
    let allowed = false;
    try {
      allowed = licenseAllowed(notice.license);
    } catch {
      // Not a license expression: not approved.
    }
    if (!allowed) problems.push(`${id} states the license "${notice.license}", which is not in ALLOWED_LICENSES`);
  }
  return problems;
}

/** The font files of the renderer that none of the style packages holds (a Fontsource package keeps them in files/). */
export function unknownFonts(rendererDir: string, styleRoots: readonly string[]): string[] {
  const assets = path.join(rendererDir, 'assets');
  if (!existsSync(assets)) return [];
  const known = new Set<string>();
  for (const root of styleRoots) {
    const files = path.join(root, 'files');
    if (existsSync(files)) for (const file of readdirSync(files)) known.add(file.replace(/\.[^.]+$/, ''));
  }
  // Vite adds a hash of eight characters: inter-latin-wght-normal-Dx4kXJAl.woff2
  return readdirSync(assets)
    .filter((file) => /\.(woff2?|ttf|otf|eot)$/i.test(file))
    .filter((file) => !known.has(file.replace(/-[\w-]{8}\.[^.]+$/, '')))
    .sort();
}

/** The folder with the files that Electron brings (LICENSE, LICENSES.chromium.html); Electron's own installer fetches it. */
export function electronDist(appDir: string): string {
  const root = resolvePackage(appDir, 'electron');
  if (!root) throw new Error('electron is not installed');
  const dist = path.join(root, 'dist');
  if (!existsSync(path.join(dist, 'LICENSES.chromium.html'))) {
    spawnSync(process.execPath, [path.join(root, 'install.js')], { stdio: 'inherit' });
    if (!existsSync(path.join(dist, 'LICENSES.chromium.html')))
      throw new Error(`Electron is not downloaded to ${dist}`);
  }
  return dist;
}

interface GitVersions {
  dugiteNative: string;
  git: string;
  gitForWindows: string;
  gitLfs: string;
}

export interface NoticesOptions {
  /** apps/desktop */
  appDir: string;
  /** Where the bundles are (apps/desktop/out); the file goes here too. */
  outDir: string;
  productName: string;
  vendor: string;
  /** The address of the project; the offer of source code points to its issues. */
  homepage: string;
  /** A production build stops on a problem; other builds only report it. */
  enforce: boolean;
}

export interface NoticesResult {
  file: string;
  /** The number of npm packages. */
  packages: number;
  problems: string[];
}

const BAR = '='.repeat(80);
const RULE = '-'.repeat(80);

/**
 * The licenses that a Go module inside git-lfs may have: the approved ones, and the MPL-2.0. The MPL asks us to say where the
 * source code of its files is, and gitSection does that for every module under it.
 */
const GO_MODULE_LICENSES: ReadonlySet<string> = new Set([...ALLOWED_LICENSES, 'MPL-2.0']);

/**
 * The Go modules inside the program git-lfs and where their license texts are: legal/git-lfs-modules/modules.json. The
 * texts are the files of the modules, byte for byte. `sum` is the hash of the module that the program itself holds.
 */
export interface GoModules {
  /** The Git LFS release that the list belongs to (versions.json). */
  gitLfs: string;
  /** The Go standard library, which every Go program holds. */
  go: { versions: string[]; license: string; file: string; sha256: string; url: string };
  modules: Array<{
    path: string;
    version: string;
    sum: string;
    license: string;
    /** The license text, relative to legal/git-lfs-modules. */
    file: string;
    sha256: string;
    /**
     * More license texts of the module, for parts that the program holds and that the text of the module root does not
     * cover (a copy of another project inside the module, with its own license file).
     */
    more?: Array<{ part: string; file: string; sha256: string }>;
    /** The programs that hold the module (darwin-arm64, win32-x64, ...). */
    systems: string[];
  }>;
}

/**
 * The Go standard library and the Go modules inside git-lfs, as notices. A problem: the list is for another Git LFS release,
 * a text is missing or is not the one that the list names (hash), or a license is not approved.
 */
export function goModules(
  legalDir: string,
  gitLfs: string,
  problems: string[],
): { manifest: GoModules; notices: Notice[] } {
  const folder = path.join(legalDir, 'git-lfs-modules');
  const list = path.join(folder, 'modules.json');
  if (!existsSync(list)) {
    problems.push(`${list} is missing: it lists the Go modules inside Git LFS (see the README of apps/desktop/legal)`);
    const none = { versions: [], license: '', file: '', sha256: '', url: '' };
    return { manifest: { gitLfs, go: none, modules: [] }, notices: [] };
  }
  const manifest = JSON.parse(readFileSync(list, 'utf8')) as GoModules;
  if (manifest.gitLfs !== gitLfs) {
    problems.push(
      `legal/git-lfs-modules/modules.json is for Git LFS ${manifest.gitLfs}, but versions.json says ${gitLfs}: ` +
        'list the Go modules of the new release (see the README of apps/desktop/legal)',
    );
  }
  const text = (relative: string, sha256: string, what: string): string => {
    const full = path.join(folder, relative);
    if (!existsSync(full)) {
      problems.push(`${what}: the license text ${relative} is missing`);
      return '';
    }
    const bytes = readFileSync(full);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
      problems.push(`${what}: the license text ${relative} is not the one that modules.json names (the hash differs)`);
    }
    return clean(bytes.toString('utf8'));
  };
  const notices: Notice[] = [
    {
      name: 'Go standard library',
      version: manifest.go.versions.join(', '),
      license: manifest.go.license,
      url: manifest.go.url,
      texts: [text(manifest.go.file, manifest.go.sha256, 'the Go standard library')],
      generated: false,
    },
    ...manifest.modules.map((module) => {
      const what = `${module.path} ${module.version}`;
      let allowed = false;
      try {
        allowed = licenseAllowed(module.license, GO_MODULE_LICENSES);
      } catch {
        // Not an expression: the same as an approval that is missing.
      }
      if (!allowed)
        problems.push(`${what} states the license "${module.license}", which nobody approved for Go modules`);
      return {
        name: module.path,
        version: module.version,
        license: module.license,
        url: `https://pkg.go.dev/${module.path}@${module.version}`,
        texts: [
          text(module.file, module.sha256, what),
          ...(module.more ?? []).map(
            (part) => `The files in ${part.part}:\n\n${text(part.file, part.sha256, `${what} ${part.part}`)}`,
          ),
        ],
        generated: false,
      };
    }),
  ];
  return { manifest, notices };
}

/** The address of the zip of a module at the Go module proxy: the exact source code that the program was built from. */
function proxyZip(module: { path: string; version: string }): string {
  const escaped = module.path.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
  return `https://proxy.golang.org/${escaped}/@v/${module.version}.zip`;
}

/** One block of the notices: the name, the license, the address and the license texts of a part. */
function noticeBlock(notice: Notice): string {
  const head = [`${notice.name} ${notice.version}`, `License: ${notice.license}`, ...(notice.url ? [notice.url] : [])];
  const note = notice.generated
    ? [
        '(The package has no license file. This is the standard text of its license, with the author that',
        'package.json names.)',
      ]
    : [];
  return [RULE, ...head, RULE, ...note, notice.texts.join('\n\n')].join('\n');
}

/** Section 2 of the notices: the Git program of dugite, its source code and the texts of its licenses. */
export function gitSection(options: NoticesOptions, legalDir: string, problems: string[]): string {
  const { productName, vendor, homepage } = options;
  const versions = readJson(path.join(legalDir, 'versions.json')) as unknown as GitVersions;
  const dugite = resolvePackage(options.appDir, 'dugite');
  if (!dugite) {
    problems.push('dugite is not installed');
    return '';
  }
  const dugiteVersion = String(readJson(path.join(dugite, 'package.json')).version);
  const embedded = Object.values(readJson(path.join(dugite, 'script', 'embedded-git.json'))) as Array<{ url?: string }>;
  const tags = new Set(embedded.map((entry) => /\/download\/(v[^/]+)\//.exec(entry.url ?? '')?.[1]));
  if (tags.size !== 1 || !tags.has(versions.dugiteNative)) {
    problems.push(
      `dugite ${dugiteVersion} downloads dugite-native ${[...tags].join(', ')}, but apps/desktop/legal/versions.json says ` +
        `${versions.dugiteNative}: update the texts in apps/desktop/legal (see its README)`,
    );
  }
  const read = (file: string): string => clean(readFileSync(path.join(legalDir, file), 'utf8'));
  const number = (tag: string): string => tag.replace(/^v/, '');
  const github = (repository: string, tag: string): string => `https://github.com/${repository}/tree/${tag}`;
  const go = goModules(legalDir, versions.gitLfs, problems);
  // The MPL-2.0 asks us to say where the source code of its files is. Git LFS holds these modules unchanged.
  const mplSources: Array<[string, string[]]> = go.manifest.modules
    .filter((module) => module.license === 'MPL-2.0')
    .map((module) => [
      `${module.path} ${module.version} (a Go module inside Git LFS, MPL-2.0)`,
      [
        ...(module.path.startsWith('github.com/')
          ? [github(module.path.split('/').slice(1, 3).join('/'), module.version)]
          : []),
        proxyZip(module),
      ],
    ]);
  const sources: Array<[string, string[]]> = [
    [`Git ${number(versions.git)} (macOS and Linux)`, [github('git/git', versions.git)]],
    [`Git for Windows ${versions.gitForWindows} (Windows)`, [github('git-for-windows/git', versions.gitForWindows)]],
    [
      'The other programs and libraries of MinGit (Windows)',
      [
        'https://github.com/git-for-windows/MSYS2-packages',
        'https://github.com/git-for-windows/MINGW-packages',
        'https://github.com/msys2/MSYS2-packages',
        'https://github.com/msys2/MINGW-packages',
      ],
    ],
    [`Git LFS ${number(versions.gitLfs)}`, [github('git-lfs/git-lfs', versions.gitLfs)]],
    [
      `The scripts that build the copy (dugite-native ${versions.dugiteNative})`,
      [github('desktop/dugite-native', versions.dugiteNative)],
    ],
  ];
  const where = [...sources, ...mplSources]
    .map(([what, links]) => [`  ${what}`, ...links.map((link) => `    ${link}`)].join('\n'))
    .join('\n');
  return `2. Git
${RULE}

The app contains a copy of the Git program. The app starts Git as a separate program, to work with your repositories.
Git is not a part of ${productName}, and ${productName} does not change it.

The copy comes from the project dugite-native (release ${versions.dugiteNative}), through the npm package
dugite ${dugiteVersion}. It is in the folder app.asar.unpacked/node_modules/dugite/git of the app. The folder holds:

  - On all systems: Git ${number(versions.git)}, under the GNU General Public License, version 2 (GPL-2.0-only),
    and Git LFS ${number(versions.gitLfs)} (MIT License). The texts of both licenses are below.
    Git LFS is a Go program: it holds the Go standard library and ${go.manifest.modules.length} Go modules of other
    projects. Their license texts are below too.
  - On Linux: the file ssl/cacert.pem, a bundle of root certificates of Mozilla, which the curl project publishes
    (Mozilla Public License 2.0, https://www.mozilla.org/MPL/2.0/).
  - On Windows: MinGit of the project Git for Windows (${versions.gitForWindows}). It holds GNU programs and libraries
    under GPL-2.0, GPL-3.0, LGPL-2.1, LGPL-3.0, MIT, BSD, Apache-2.0 and other licenses. The license texts are in the
    Git folder: LICENSE.txt, usr/share/licenses, and ucrt64/share/licenses (x64) or clangarm64/share/licenses (Arm).
    The file etc/package-versions.txt names the programs and their versions.

Source code
${RULE}

The GPL asks us to give you the source code of the programs above, or to say where to get it.${
    mplSources.length > 0
      ? '\nThe Mozilla Public License 2.0 asks the same for the Go modules under it inside Git LFS.'
      : ''
  }
You get it here:

${where}

Written offer: if you cannot get the source code from these places, ask ${vendor} for a copy. Open an issue at
this address:

  ${homepage}/issues

${vendor} will give you the source code, or a link to it, for no more than the cost of doing so. The offer is valid
for three years after ${vendor} last gave out a version of ${productName} that holds the program.

GNU General Public License (Git ${number(versions.git)})
${RULE}
${read('git-COPYING.txt')}

Git LFS: MIT License
${RULE}
${read('git-lfs-LICENSE.md')}

Go software inside Git LFS
${RULE}

Git LFS is a program written in Go. It contains the Go standard library and ${go.manifest.modules.length} Go modules
of other projects. Which modules a program holds depends on the system, and this list names all of them. Each part has
its own license, and its text follows.

${go.notices.map(noticeBlock).join('\n\n')}
`;
}

/** The text of THIRD_PARTY_NOTICES.txt. */
export function renderNotices(
  options: NoticesOptions,
  notices: readonly Notice[],
  extra: { electron: string; electronLicense: string; git: string; adapted: string },
): string {
  const { productName, vendor } = options;
  const list = notices.map((notice) => `  ${notice.name} ${notice.version}  ${notice.license}`).join('\n');
  const details = notices.map(noticeBlock).join('\n\n');
  return `${productName}: notices of third-party software
${BAR}

${productName} is made by ${vendor}. The terms of ${productName} itself are in the file LICENSE in this folder.

The app contains software of other projects. Each part keeps its own license, and the terms of ${productName} do not
change them. This file names each part, says under which license it comes, and gives the license text that the license
asks us to pass on.

Contents
  1. Electron and Chromium
  2. Git
  3. Code adapted in ${productName}
  4. npm packages (${notices.length})

1. Electron and Chromium
${RULE}

The app runs on Electron ${extra.electron}. Electron is under the MIT License:

${extra.electronLicense}

Electron contains Chromium, Node.js and other software with their own licenses. The file LICENSES.chromium.html lists
them. On macOS it is in this folder. On Windows and Linux it is in the folder of the program, above this folder.

${extra.git}
3. Code adapted in ${productName}
${RULE}

The rules that find secrets are adapted from the default configuration of gitleaks (https://github.com/gitleaks/gitleaks),
under the MIT License:

${extra.adapted}

4. npm packages (${notices.length})
${RULE}

${list}

${details}
`;
}

/** Joins the parts of the app, checks their licenses and writes THIRD_PARTY_NOTICES.txt into the output folder. */
export function writeNotices(options: NoticesOptions): NoticesResult {
  const { appDir, outDir } = options;
  const legalDir = path.join(appDir, 'legal');
  const problems: string[] = [];

  const roots = new Set<string>();
  for (const bundle of BUNDLES) {
    const list = path.join(outDir, bundle, BUNDLED_PACKAGES_FILE);
    if (!existsSync(list)) {
      problems.push(`${list} is missing: build the bundles first (electron-vite build)`);
      continue;
    }
    for (const root of JSON.parse(readFileSync(list, 'utf8')) as string[]) roots.add(realpathSync(root));
  }
  for (const root of shippedRoots(appDir)) roots.add(root);
  const styleRoots: string[] = [];
  for (const name of STYLE_PACKAGES) {
    const root = resolvePackage(appDir, name);
    if (root) {
      styleRoots.push(root);
      roots.add(root);
    } else problems.push(`${name}, a style package, is not installed`);
  }
  for (const font of unknownFonts(path.join(outDir, 'renderer'), styleRoots)) {
    problems.push(`the font file ${font} is from a package that STYLE_PACKAGES in scripts/notices.ts does not name`);
  }

  // pnpm keeps a package once per set of peer dependencies: the same name and version can have two folders.
  const notices = [...roots]
    .map(readPackage)
    .filter((notice, at, all) => all.findIndex((o) => o.name === notice.name && o.version === notice.version) === at)
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en', { numeric: true }));
  problems.push(...licenseProblems(notices));

  const dist = electronDist(appDir);
  const electron = String(readJson(path.join(resolvePackage(appDir, 'electron') ?? '', 'package.json')).version);
  const text = renderNotices(options, notices, {
    electron,
    electronLicense: clean(readFileSync(path.join(dist, 'LICENSE'), 'utf8')),
    git: gitSection(options, legalDir, problems),
    adapted: clean(readFileSync(path.join(legalDir, 'gitleaks-LICENSE.txt'), 'utf8')),
  });

  if (options.enforce && problems.length > 0) {
    throw new Error(`The notices of third-party software cannot be written:\n  - ${problems.join('\n  - ')}`);
  }
  const file = path.join(outDir, NOTICES_FILE);
  writeFileSync(file, text);
  return { file, packages: notices.length, problems };
}

/**
 * The name of the app's license in the fields of the Linux packages (the `License` of the deb and of the rpm): the name of
 * the file that the license project publishes. The license has no SPDX identifier.
 */
export const APP_LICENSE = 'NON-AI-APACHE2';
/** The copyright file of the deb, which build.ts writes into the output folder and the deb installs (ADR 0035, decision 9). */
export const DEBIAN_COPYRIGHT_FILE = 'debian-copyright';

export interface DebianCopyrightOptions {
  productName: string;
  vendor: string;
  homepage: string;
  /** The text of the file LICENSE. */
  license: string;
  /** Where the deb installs the app: /opt/<product name>. */
  installDir: string;
}

/**
 * The file /usr/share/doc/<package>/copyright of the deb, in Debian's machine-readable format
 * (https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/). License scanners read it. The license texts are
 * in the resources of the app too: this file names the app's license, holds its text, and says where the notices are.
 */
export function debianCopyright(options: DebianCopyrightOptions): string {
  const { productName, vendor, homepage, installDir } = options;
  const resources = `${installDir}/resources`;
  // A field that continues on more lines: each line starts with a space, and an empty line is " .".
  const lines = clean(options.license)
    .split('\n')
    .map((line) => (line.trim() === '' ? ' .' : ` ${line.trimEnd()}`))
    .join('\n');
  return `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: ${productName}
Source: ${homepage}
Comment: ${productName} also contains software of other projects: Electron with Chromium, Git with Git LFS, and npm
 packages. Each keeps its own license. Their notices and license texts are in ${resources}/THIRD_PARTY_NOTICES.txt,
 ${installDir}/LICENSE.electron.txt and ${installDir}/LICENSES.chromium.html. The notice of ${productName} is in
 ${resources}/NOTICE.

Files: *
Copyright: ${vendor}
License: ${APP_LICENSE}
Comment: Except the software of other projects that the header names.

License: ${APP_LICENSE}
${lines}
`;
}
