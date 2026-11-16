// The allowed imports between packages (IMPLEMENTATION.md §2.2, ADR 0005), checked by `pnpm arch`.
// Workspace packages are imported by name (@app/...), which resolves to packages/<name>/src.

const pkg = (name) => `^packages/${name}/src/`;
const app = (part) => `^apps/desktop/src/${part}/`;
// Tests, stories and the test helpers next to them (folders named testing/ or test/).
const testFiles = '(\\.(test|spec|stories)\\.tsx?$)|(/(testing|test)/)';

/** `from` may import only these workspace packages. */
function onlyPackages(name, from, allowed) {
  const all = ['brand', 'schemas', 'tools', 'ipc', 'core', 'adapters', 'editor', 'testkit'];
  const forbidden = all.filter((p) => !allowed.includes(p) && `^packages/${p}/src/` !== from);
  return {
    name,
    severity: 'error',
    comment: `${from} may import only ${allowed.join(', ') || 'no other workspace package'} (IMPLEMENTATION.md §2.2)`,
    from: { path: from, pathNot: testFiles },
    to: { path: `^packages/(${forbidden.join('|')})/` },
  };
}

module.exports = {
  forbidden: [
    onlyPackages('brand-imports', pkg('brand'), []),
    onlyPackages('schemas-imports', pkg('schemas'), ['brand']),
    onlyPackages('tools-imports', pkg('tools'), ['schemas', 'brand']),
    onlyPackages('core-imports', pkg('core'), ['schemas', 'tools', 'brand']),
    onlyPackages('adapters-imports', pkg('adapters'), ['core', 'schemas', 'tools', 'brand']),
    onlyPackages('ipc-imports', pkg('ipc'), ['schemas', 'brand']),
    onlyPackages('editor-imports', pkg('editor'), ['schemas', 'brand']),
    onlyPackages('main-imports', app('main'), ['core', 'adapters', 'ipc', 'schemas', 'tools', 'brand']),
    onlyPackages('worker-imports', app('worker'), ['core', 'adapters', 'ipc', 'schemas', 'tools', 'brand']),
    onlyPackages('renderer-imports', app('renderer'), ['ipc', 'editor', 'schemas', 'brand']),
    onlyPackages('preload-imports', app('preload'), []),
    onlyPackages('testkit-imports', pkg('testkit'), ['core', 'adapters', 'ipc', 'schemas', 'tools', 'brand']),
    {
      name: 'no-test-code-in-the-app',
      severity: 'error',
      comment: 'Nothing in the app imports testkit or tests/ (IMPLEMENTATION.md §2.2)',
      from: { path: '^(apps|packages)/', pathNot: ['^packages/testkit/', testFiles] },
      to: { path: ['^packages/testkit/', '^tests/'] },
    },
    {
      name: 'pure-core',
      severity: 'error',
      comment: 'core and the other pure packages import nothing from Node or Electron (IMPLEMENTATION.md §2.2)',
      from: { path: '^packages/(brand|schemas|tools|ipc|core|editor)/src/', pathNot: testFiles },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'pure-core-no-npm',
      severity: 'error',
      comment: 'core imports no npm package: only schemas, tools and brand (IMPLEMENTATION.md §2.2)',
      from: { path: pkg('core'), pathNot: testFiles },
      to: { dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'io-only-in-adapters',
      severity: 'error',
      comment:
        'Only adapters import node:fs, node:child_process, dugite, SQLite and @parcel/watcher (IMPLEMENTATION.md §2.2)',
      from: {
        path: '^(apps|packages)/',
        // Build scripts and build configs run at build time, not in the app.
        pathNot: [
          '^packages/(adapters|testkit)/',
          '^apps/desktop/scripts/',
          '^apps/desktop/[^/]+\\.config\\.ts$',
          testFiles,
        ],
      },
      to: { path: '^(node:)?(fs|fs/promises|child_process|sqlite)$|^dugite|^@parcel/watcher' },
    },
    {
      name: 'electron-only-in-the-app',
      severity: 'error',
      comment: 'Only apps/desktop imports electron (IMPLEMENTATION.md §2.2)',
      from: { pathNot: ['^apps/desktop/', '^packages/testkit/src/e2e/', '^tests/'] },
      to: { path: '^electron$' },
    },
    {
      name: 'renderer-without-node',
      severity: 'error',
      comment: 'The renderer is sandboxed and has no Node (IMPLEMENTATION.md §2.1)',
      from: { path: app('renderer'), pathNot: testFiles },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'core-modules-through-their-index',
      severity: 'error',
      comment: 'A core module is reached only through its index.ts (IMPLEMENTATION.md §2.2)',
      from: { path: '^packages/core/src/([^/]+)/', pathNot: testFiles },
      to: {
        path: '^packages/core/src/[^/]+/.+',
        pathNot: [
          '^packages/core/src/$1/',
          '^packages/core/src/(ports|shared)/',
          '^packages/core/src/[^/]+/index\\.ts$',
        ],
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['(^|/)(out|release|\\.cache|artifacts|coverage|reports|node_modules)/', '\\.d\\.ts$'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
    combinedDependencies: false,
    preserveSymlinks: false,
  },
};
