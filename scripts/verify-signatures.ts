// A18.1: the signatures of a release's installers, checked as the OS will check them (ADR 0028):
//   macOS    codesign --verify --deep --strict on the app; spctl --assess (Gatekeeper accepts a Developer ID app
//            only when it's notarized); xcrun stapler validate (the notarization ticket travels with the app and
//            the dmg)
//   Windows  signtool verify /pa on the installer and the installed program
//   Linux    no OS signature (AppImage, deb and rpm reach users through the release's own checksums): every file
//            in the update feed has the size and sha512 its latest*.yml names
// Usage: node scripts/verify-signatures.ts <release folder>, e.g. apps/desktop/release/production-darwin-arm64
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export interface Check {
  readonly what: string;
  readonly ok: boolean;
  readonly output: string;
}

function run(what: string, command: string, args: readonly string[]): Check {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  return { what, ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

function find(folder: string, test: (name: string) => boolean, depth = 2): string[] {
  const found: string[] = [];
  for (const name of readdirSync(folder)) {
    const at = path.join(folder, name);
    if (test(name)) found.push(at);
    else if (depth > 0 && statSync(at).isDirectory()) found.push(...find(at, test, depth - 1));
  }
  return found;
}

/** The feed's own checks: each file it names has that size and sha512 (base64, as electron-builder writes it). */
export function feedChecks(folder: string): Check[] {
  const checks: Check[] = [];
  for (const name of readdirSync(folder).filter((n) => /^latest.*\.yml$/.test(n))) {
    const feed = parse(readFileSync(path.join(folder, name), 'utf8')) as {
      files: Array<{ url: string; sha512: string; size?: number }>;
    };
    for (const file of feed.files) {
      const bytes = readFileSync(path.join(folder, file.url));
      const sha512 = createHash('sha512').update(bytes).digest('base64');
      const ok = sha512 === file.sha512 && (file.size === undefined || file.size === bytes.length);
      checks.push({ what: `${name}: ${file.url}`, ok, output: ok ? 'size and sha512 match' : 'mismatch' });
    }
  }
  return checks;
}

export function signatureChecks(folder: string, platform: NodeJS.Platform = process.platform): Check[] {
  if (platform === 'darwin') {
    return find(folder, (name) => name.endsWith('.app')).flatMap((app) => [
      run(`codesign ${path.basename(app)}`, 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]),
      run(`Gatekeeper ${path.basename(app)}`, 'spctl', ['--assess', '--type', 'execute', '--verbose=4', app]),
      run(`notarization ticket ${path.basename(app)}`, 'xcrun', ['stapler', 'validate', app]),
      ...find(folder, (name) => name.endsWith('.dmg'), 0).map((dmg) =>
        run(`notarization ticket ${path.basename(dmg)}`, 'xcrun', ['stapler', 'validate', dmg]),
      ),
    ]);
  }
  if (platform === 'win32') {
    return find(folder, (name) => name.endsWith('.exe')).map((exe) =>
      run(`signtool ${path.basename(exe)}`, 'signtool', ['verify', '/pa', '/v', exe]),
    );
  }
  return feedChecks(folder);
}

if (import.meta.main) {
  const folder = process.argv[2];
  if (!folder) {
    process.stderr.write('usage: verify-signatures.ts <release folder>\n');
    process.exit(2);
  }
  const checks = signatureChecks(folder);
  for (const check of checks) {
    process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.what}\n`);
    if (!check.ok) process.stdout.write(`      ${check.output.split('\n').join('\n      ')}\n`);
  }
  process.exit(checks.length > 0 && checks.every((check) => check.ok) ? 0 : 1);
}
