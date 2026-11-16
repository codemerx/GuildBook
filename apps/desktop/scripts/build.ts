// Builds and packages the app (ADR 0023), in two variants (ADR 0021, A1.6):
//   production  every production fuse set, no test hooks
//   test-hooks  the same, with the test hooks and the --inspect fuse Playwright needs
// Usage: node scripts/build.ts [production|test-hooks ...] [--installers] [--arch=arm64|x64] [--skip-vite]
//          [--version=1.2.3] [--release-url=<url>] [--release] [--targets=AppImage,deb] [--output=<folder>]
// Without --installers it packages an unpacked app folder, which the end-to-end tests use.
// Updates (Step 18, ADR 0027, ADR 0031): a build checks an update feed when brand.releaseRepository is set (GitHub
// Releases), or with --release-url (a generic feed: the local release host of the release rehearsal, A18.5). --version
// builds another version than package.json's.
// Signing (ADR 0028) comes from the environment, as the release pipeline sets it:
//   macOS    CSC_LINK + CSC_KEY_PASSWORD (or CSC_NAME), and for notarization APPLE_API_KEY + APPLE_API_KEY_ID +
//            APPLE_API_ISSUER (or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID)
//   Windows  AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE, AZURE_SIGN_PUBLISHER, with AZURE_TENANT_ID,
//            AZURE_CLIENT_ID and AZURE_CLIENT_SECRET for Azure Trusted Signing
// Without them a build is unsigned (re-signed ad hoc on macOS). --release refuses to build without them.
import { brand } from '../../../packages/brand/src/index.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Arch, build, Platform } from 'electron-builder';
import { afterPackGit } from './git-bundle.ts';
import {
  APP_LICENSE,
  BUNDLED_PACKAGES_FILE,
  DEBIAN_COPYRIGHT_FILE,
  debianCopyright,
  electronDist,
  NOTICES_FILE,
  writeNotices,
} from './notices.ts';

export type BuildVariant = 'production' | 'test-hooks';

const appDir = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const installers = args.includes('--installers');
const skipVite = args.includes('--skip-vite');
const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const arch = (value('arch') ?? process.arch) as 'arm64' | 'x64';
const version = value('version');
const releaseUrl = value('release-url');
const release = args.includes('--release');
/** Only these installers (the rehearsal needs only the AppImage), and another output folder, so it never replaces the
 * builds the end-to-end tests use. */
const targets = value('targets')?.split(',');
const output = value('output');
const requested = args.filter((a) => !a.startsWith('--')).map((a) => (a === 'prod' ? 'production' : a));
const variants = (requested.length ? requested : ['production', 'test-hooks']) as BuildVariant[];

const platform = { darwin: Platform.MAC, win32: Platform.WINDOWS, linux: Platform.LINUX }[process.platform as 'darwin'];
// The zip is what macOS updates download; rpm needs rpmbuild on the build machine (ADR 0024).
const installerTargets = { darwin: ['dmg', 'zip'], win32: ['nsis'], linux: ['AppImage', 'deb', 'rpm'] }[
  process.platform as 'darwin'
];

const env = process.env;
const macSigning = Boolean(env.CSC_LINK || env.CSC_NAME);
const macNotarizing = Boolean(
  (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
  (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID),
);
const azureSigning =
  env.AZURE_SIGN_ENDPOINT && env.AZURE_SIGN_ACCOUNT && env.AZURE_SIGN_PROFILE && env.AZURE_SIGN_PUBLISHER
    ? {
        endpoint: env.AZURE_SIGN_ENDPOINT,
        codeSigningAccountName: env.AZURE_SIGN_ACCOUNT,
        certificateProfileName: env.AZURE_SIGN_PROFILE,
        publisherName: env.AZURE_SIGN_PUBLISHER,
      }
    : null;
const signed = { darwin: macSigning && macNotarizing, win32: azureSigning !== null, linux: true }[
  process.platform as 'darwin'
];
if (release && !signed) {
  process.stderr.write('a release build needs its signing secrets (see the top of scripts/build.ts)\n');
  process.exit(1);
}

/** Where the app's updates come from: the generic feed given, or the release repository's GitHub Releases. */
function publishConfig() {
  if (releaseUrl) return [{ provider: 'generic' as const, url: releaseUrl }];
  if (brand.releaseRepository) {
    const { owner, repo } = brand.releaseRepository;
    return [{ provider: 'github' as const, owner, repo, releaseType: 'release' as const }];
  }
  return null;
}

export function releaseDir(variant: BuildVariant, targetArch: string = arch): string {
  return output ? path.resolve(output) : path.join(appDir, 'release', `${variant}-${process.platform}-${targetArch}`);
}

/** The fuses of ADR 0021: only --inspect differs, because Playwright attaches through it. */
export function fuses(variant: BuildVariant) {
  return {
    runAsNode: false,
    enableCookieEncryption: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: variant === 'test-hooks',
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
    // An unsigned build (ADR 0028): flipping fuses breaks Electron's ad-hoc signature, which Apple Silicon requires,
    // so it's redone. A signed build is signed after the fuses are set.
    resetAdHocDarwinSignature: process.platform === 'darwin' && !macSigning,
  };
}

for (const variant of variants) {
  const started = Date.now();
  if (!skipVite) {
    const vite = spawnSync(
      process.execPath,
      [path.join(appDir, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'],
      {
        cwd: appDir,
        stdio: 'inherit',
        env: {
          ...process.env,
          BUILD_VARIANT: variant,
          ...(version ? { BUILD_VERSION: version } : {}),
          ...(releaseUrl ? { BUILD_RELEASE_URL: releaseUrl } : {}),
        },
      },
    );
    if (vite.status !== 0) process.exit(vite.status ?? 1);
  }
  // The notices of third-party software (ADR 0035): every installer holds THIRD_PARTY_NOTICES.txt. A production build stops
  // on a license that nobody approved; a test-hooks build is never published and only reports it.
  const notices = writeNotices({
    appDir,
    outDir: path.join(appDir, 'out'),
    productName: brand.displayName,
    vendor: brand.vendor,
    homepage: brand.homepage,
    enforce: variant === 'production',
  });
  process.stdout.write(
    `notices of ${notices.packages} npm packages written to ${path.relative(appDir, notices.file)}\n`,
  );
  for (const problem of notices.problems)
    process.stderr.write(`notices (not enforced in a ${variant} build): ${problem}\n`);
  // The deb's /usr/share/doc/<package>/copyright (ADR 0035, decision 9). electron-builder installs the app in /opt/<product name>.
  const copyrightFile = path.join(appDir, 'out', DEBIAN_COPYRIGHT_FILE);
  writeFileSync(
    copyrightFile,
    debianCopyright({
      productName: brand.displayName,
      vendor: brand.vendor,
      homepage: brand.homepage,
      license: readFileSync(path.join(appDir, '../../LICENSE'), 'utf8'),
      installDir: path.posix.join('/opt', brand.displayName),
    }),
  );
  const electron = electronDist(appDir);
  await build({
    projectDir: appDir,
    targets: platform.createTarget(installers ? (targets ?? installerTargets) : ['dir'], Arch[arch]),
    publish: 'never',
    config: {
      appId: brand.appId,
      productName: brand.displayName,
      executableName: brand.packageName,
      copyright: `Copyright © ${brand.vendor}`,
      artifactName: `${brand.packageName}-${variant}-\${version}-\${os}-\${arch}.\${ext}`,
      directories: { output: releaseDir(variant), buildResources: 'resources' },
      files: [
        'out/**/*',
        'resources/**/*',
        'package.json',
        // The lists of the packages in the bundles and the notices are not part of the app code; the notices go to the resources.
        `!out/**/${BUNDLED_PACKAGES_FILE}`,
        `!out/${NOTICES_FILE}`,
        `!out/${DEBIAN_COPYRIGHT_FILE}`,
      ],
      // The license of the app, the notice of the files from other projects and their licenses, next to the app (ADR 0035).
      extraResources: [
        { from: `out/${NOTICES_FILE}`, to: NOTICES_FILE },
        { from: '../../LICENSE', to: 'LICENSE' },
        { from: '../../NOTICE', to: 'NOTICE' },
      ],
      // The latest*.yml files next to the installers: the update feed that the app reads (update-feed.ts).
      publish: publishConfig(),
      extraMetadata: {
        ...(version ? { version } : {}),
        name: brand.packageName,
        productName: brand.displayName,
        description: brand.displayName,
        homepage: brand.homepage,
        // The window's app id on Linux (WM_CLASS), so the desktop links the window to the app's menu entry (ADR 0023).
        desktopName: `${brand.packageName}.desktop`,
        author: { name: brand.vendor },
        // The `License` field of the deb and of the rpm (ADR 0035, decision 9).
        license: APP_LICENSE,
        main: 'out/main/index.cjs',
      },
      asar: true,
      // dugite runs its own git, which must be a real file: it finds it under app.asar.unpacked (ADR 0013, 0023).
      asarUnpack: ['**/node_modules/dugite/git/**'],
      // dugite's Git folder holds Git Credential Manager, which the app never starts. It is deleted from the packaged copy
      // after the files are copied and before the app is signed; node_modules stays as it is (ADR 0035, decision 7).
      afterPack: afterPackGit({ enforce: variant === 'production', arch }),
      // Nothing is compiled for Electron: SQLite is built in (ADR 0011, 0023).
      npmRebuild: false,
      // The AppImage's runtime (ADR 0030): the static type2 runtime. The default one needs libz.so, which most arm64
      // systems have only with zlib's development package, so the AppImage didn't start there.
      toolsets: { appimage: '1.0.3' },
      electronFuses: fuses(variant),
      icon: 'resources/icon.png',
      mac: {
        category: 'public.app-category.developer-tools',
        // Electron's macOS archive holds LICENSE and LICENSES.chromium.html next to Electron.app, and electron-builder drops
        // them. On Windows and Linux it keeps them in the folder of the program.
        extraResources: [
          { from: path.join(electron, 'LICENSE'), to: 'LICENSE.electron.txt' },
          { from: path.join(electron, 'LICENSES.chromium.html'), to: 'LICENSES.chromium.html' },
        ],
        // Signed and notarized with the release's Developer ID, or unsigned (ADR 0028).
        ...(macSigning
          ? {
              hardenedRuntime: true,
              entitlements: 'resources/entitlements.mac.plist',
              entitlementsInherit: 'resources/entitlements.mac.plist',
              notarize: macNotarizing,
            }
          : { identity: null }),
      },
      win: { executableName: brand.packageName, ...(azureSigning ? { azureSignOptions: azureSigning } : {}) },
      // The uninstaller runs Remove everything in the no-window mode (PLAN.md §3.8 S12).
      nsis: { include: 'resources/uninstall.nsh' },
      linux: {
        category: 'Development',
        maintainer: brand.vendor,
        executableName: brand.packageName,
        syncDesktopName: true,
        desktop: { entry: { Name: brand.displayName } },
      },
      // fpm takes these after its options, as files to add: the copyright file where Debian packages keep it.
      deb: { fpm: [`${copyrightFile}=/usr/share/doc/${brand.packageName}/copyright`] },
    },
  });
  process.stdout.write(
    `packaged ${variant} for ${process.platform}-${arch} in ${Math.round((Date.now() - started) / 1000)} s\n`,
  );
}
