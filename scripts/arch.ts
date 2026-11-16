// The architecture rules: pnpm arch [dependency-cruiser options]. dependency-cruiser checks the folders apps and packages,
// and the folder tests where it exists: the test cases are not in the public repository (.gitignore).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const folders = ['apps', 'packages', ...(existsSync(path.join(repo, 'tests', 'package.json')) ? ['tests'] : [])];
const run = spawnSync(
  process.execPath,
  [
    path.join(repo, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs'),
    ...folders,
    '--config',
    '.dependency-cruiser.cjs',
    ...process.argv.slice(2),
  ],
  { cwd: repo, stdio: 'inherit' },
);
process.exit(run.status ?? 1);
