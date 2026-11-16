// The type check of the whole repository: pnpm typecheck [tsc options]. It runs `tsc -b`: on tsconfig.json, which lists the
// product projects and the test projects of the packages, and on the folder tests/. tsconfig.json cannot list tests/: the
// test cases are not in the public repository (.gitignore), a clone has no such folder, and Vite reads the list too.
// ESLint and the editor find the test projects of the packages through the same list, so it keeps them. In a clone,
// there are no test files: the test projects are left out and only the product projects are built.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const { references } = JSON.parse(readFileSync(path.join(repo, 'tsconfig.json'), 'utf8')) as {
  references: Array<{ path: string }>;
};
const projects = existsSync(path.join(repo, 'tests', 'package.json'))
  ? ['tsconfig.json', 'tests']
  : references.map((reference) => reference.path).filter((project) => !project.endsWith('tsconfig.test.json'));
const run = spawnSync(
  process.execPath,
  [path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', ...projects, ...process.argv.slice(2)],
  { cwd: repo, stdio: 'inherit' },
);
process.exit(run.status ?? 1);
