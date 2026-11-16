// Dependency rules that dependency-cruiser can't see (ADR 0005, IMPLEMENTATION.md §3.4):
// - runtime dependencies that can't be bundled (dugite, @parcel/watcher) are dependencies of apps/desktop, with the
//   same versions as in packages/adapters, because only those are packaged
// - every package pins the same version of a dependency, and exact versions only
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const unbundleable = ['dugite', '@parcel/watcher'];

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifests: Array<{ file: string; manifest: Manifest }> = [
  'package.json',
  // The test cases are not in the public repository (.gitignore): a clone has no tests/package.json.
  ...(existsSync(path.join(repo, 'tests', 'package.json')) ? ['tests/package.json'] : []),
  // Folders only: macOS leaves .DS_Store files around.
  ...readdirSync(path.join(repo, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`),
  ...readdirSync(path.join(repo, 'apps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `apps/${entry.name}/package.json`),
].map((file) => ({ file, manifest: JSON.parse(readFileSync(path.join(repo, file), 'utf8')) as Manifest }));

const problems: string[] = [];
const versions = new Map<string, Map<string, string[]>>();
for (const { file, manifest } of manifests) {
  for (const field of ['dependencies', 'devDependencies'] as const) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (version.startsWith('workspace:')) continue;
      if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`${file}: ${name}@${version} is not an exact version`);
      const seen = versions.get(name) ?? new Map<string, string[]>();
      seen.set(version, [...(seen.get(version) ?? []), file]);
      versions.set(name, seen);
    }
  }
}
for (const [name, seen] of versions) {
  if (seen.size > 1) {
    problems.push(
      `${name} has different versions: ${[...seen].map(([v, files]) => `${v} in ${files.join(', ')}`).join('; ')}`,
    );
  }
}
const adapters = manifests.find((m) => m.manifest.name === '@app/adapters')?.manifest;
const desktop = manifests.find((m) => m.manifest.name === '@app/desktop')?.manifest;
for (const name of unbundleable) {
  const wanted = adapters?.dependencies?.[name];
  if (wanted === undefined) continue;
  if (desktop?.dependencies?.[name] !== wanted) {
    problems.push(`${name} ${wanted} is a runtime dependency of adapters, so apps/desktop needs it too (ADR 0005)`);
  }
}

if (problems.length) {
  process.stderr.write(`dependency check:\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`dependency check: ${versions.size} dependencies, one exact version each\n`);
