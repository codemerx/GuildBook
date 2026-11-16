// Lint rules for the whole monorepo (IMPLEMENTATION.md §3.2, TESTING.md §8 "Rules for tests").
// Package boundaries are checked by dependency-cruiser (.dependency-cruiser.cjs), not here.
import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import i18next from 'eslint-plugin-i18next';
import playwright from 'eslint-plugin-playwright';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const pureCode = ['packages/{brand,schemas,tools,ipc,core}/src/**/*.ts'];
const appProcesses = ['apps/desktop/src/{main,worker}/**/*.ts'];
const renderer = ['apps/desktop/src/renderer/**/*.{ts,tsx}', 'packages/editor/src/**/*.{ts,tsx}'];
const unitTests = ['**/*.test.{ts,tsx}'];
const e2eTests = ['tests/e2e/**/*.ts', 'packages/testkit/src/e2e/**/*.ts'];

// Time and randomness come from the Clock and Random ports, so tests are deterministic (IMPLEMENTATION.md §2.12).
const clockAndRandom = [
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'Use the Clock port.' },
  { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Use the Clock port.' },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'Use the Random port.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/release/**',
      '**/.cache/**',
      'artifacts/**',
      'coverage/**',
      'reports/**',
      '.stryker-tmp/**',
      'docs/**',
      '**/storybook-static/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/only-throw-error': 'error',
      // Port implementations and fakes are async without awaiting on purpose: a thrown error becomes a rejection,
      // as it is in the real adapters.
      '@typescript-eslint/require-await': 'off',
      // Composition roots declare a few late-bound references that closures read before they're assigned.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { ...tseslint.configs.disableTypeChecked.languageOptions, globals: { ...globals.node } },
  },
  {
    // Global declarations need `var` (types/runtime-globals.d.ts).
    files: ['**/*.d.ts'],
    rules: { 'no-var': 'off' },
  },
  {
    // core and the other pure packages: no clock, randomness or host globals of their own.
    files: [...pureCode, ...appProcesses],
    ignores: unitTests,
    rules: {
      'no-restricted-syntax': ['error', ...clockAndRandom],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Use the Env port.' },
        { name: 'Buffer', message: 'Use Uint8Array.' },
        { name: 'setTimeout', message: 'Use the Clock port.' },
        { name: 'setInterval', message: 'Use the Clock port.' },
        { name: 'fetch', message: 'Network access goes through ports.' },
      ],
    },
  },
  {
    // The composition roots wire real implementations, so they may read the process environment and timers.
    files: [
      'apps/desktop/src/main/index.ts',
      'apps/desktop/src/main/composition.ts',
      'apps/desktop/src/main/electron/**/*.ts',
      'apps/desktop/src/worker/index.ts',
      'apps/desktop/src/worker/worker.ts',
      'apps/desktop/src/worker/setup-worker.ts',
    ],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    files: renderer,
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, i18next },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Every user-visible string goes through i18n (IMPLEMENTATION.md §2.11, §2.13 rule 10).
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-only',
          'jsx-attributes': { include: ['aria-label', 'aria-description', 'title', 'placeholder', 'alt', 'label'] },
          callees: { exclude: ['t', 'i18n.t', 'useTranslation', 'cn', 'cva', 'clsx', 'Error'] },
        },
      ],
    },
  },
  {
    files: ['**/*.stories.tsx', 'apps/desktop/.storybook/**'],
    rules: { 'i18next/no-literal-string': 'off' },
  },
  {
    // Rules for tests (TESTING.md §8): no focused or skipped tests, assertions in every test, none of them
    // conditional, no sleeping, no real home folder.
    files: unitTests,
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*', '*.expect*', 'assert*'] }],
      'vitest/no-conditional-expect': 'error',
      'vitest/no-conditional-in-test': 'error',
      'vitest/valid-title': 'error',
      // Vitest takes a message as expect's second argument.
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Promise'] CallExpression[callee.name='setTimeout']",
          message: 'No sleeping in tests: wait for a condition or for idle (TESTING.md §8).',
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'os', property: 'homedir', message: 'Tests never use the real home folder (TESTING.md §3).' },
      ],
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    files: e2eTests,
    ...playwright.configs['flat/recommended'],
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      'playwright/no-wait-for-timeout': 'error',
      'playwright/no-focused-test': 'error',
      'playwright/no-skipped-test': 'error',
      'playwright/no-conditional-in-test': 'error',
      'playwright/no-conditional-expect': 'error',
      'playwright/expect-expect': ['error', { assertFunctionNames: ['expect*', 'check*', 'shot', 'checkpoint'] }],
      'playwright/no-standalone-expect': 'off',
    },
  },
);
