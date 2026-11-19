// A18.1: the installers of a release, checked before they are published. The releases are unsigned (ADR 0036):
//   every OS  each file in the update feed has the size and sha512 its latest*.yml names, and a feed exists
//   macOS     codesign --verify --deep --strict on the app: the ad-hoc signature is whole (Apple Silicon starts no
//             app without one), so the only warning users see is the one for an app from an unknown developer
// Windows and Linux have no signature to check.
// Usage: node scripts/verify-installers.ts <release folder>, e.g. apps/desktop/release/production-darwin-arm64
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
  const feeds = readdirSync(folder).filter((n) => /^latest.*\.yml$/.test(n));
  if (feeds.length === 0) return [{ what: 'update feed', ok: false, output: `no latest*.yml in ${folder}` }];
  const checks: Check[] = [];
  for (const name of feeds) {
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

export function installerChecks(folder: string, platform: NodeJS.Platform = process.platform): Check[] {
  if (platform !== 'darwin') return feedChecks(folder);
  const apps = find(folder, (name) => name.endsWith('.app'));
  const signatures = apps.map((app) =>
    run(`ad-hoc signature ${path.basename(app)}`, 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]),
  );
  if (apps.length === 0) signatures.push({ what: 'the app', ok: false, output: `no .app in ${folder}` });
  return [...signatures, ...feedChecks(folder)];
}

if (import.meta.main) {
  const folder = process.argv[2];
  if (!folder) {
    process.stderr.write('usage: verify-installers.ts <release folder>\n');
    process.exit(2);
  }
  const checks = installerChecks(folder);
  for (const check of checks) {
    process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.what}\n`);
    if (!check.ok) process.stdout.write(`      ${check.output.split('\n').join('\n      ')}\n`);
  }
  process.exit(checks.length > 0 && checks.every((check) => check.ok) ? 0 : 1);
}
