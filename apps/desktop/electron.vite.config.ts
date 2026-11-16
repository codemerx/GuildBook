// Builds main (with the worker), the preload and the renderer (ADR 0005, 0023). Workspace packages are bundled; the
// app has no runtime dependency that can't be. BUILD_VARIANT picks production or test-hooks; `pnpm dev` is always a
// test-hooks build (IMPLEMENTATION.md §2.16).
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { brand } from '../../packages/brand/src/index.ts';
import { bundledPackages } from './scripts/notices.ts';
import { DEV_SERVER_CSP, PACKAGED_CSP } from './src/shared/csp.ts';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig(({ command }) => {
  const dev = command === 'serve';
  const variant = dev ? 'test-hooks' : (process.env.BUILD_VARIANT ?? 'test-hooks');
  if (variant !== 'production' && variant !== 'test-hooks') throw new Error(`unknown BUILD_VARIANT ${variant}`);
  // A release build may carry another version and a generic update feed (apps/desktop/scripts/build.ts).
  const define = {
    __TEST_HOOKS__: JSON.stringify(variant === 'test-hooks'),
    __DEV_BUILD__: JSON.stringify(dev),
    __APP_VERSION__: JSON.stringify(process.env.BUILD_VERSION ?? pkg.version),
    __RELEASE_URL__: JSON.stringify(process.env.BUILD_RELEASE_URL ?? null),
  };
  const cjs = { format: 'cjs' as const, entryFileNames: '[name].cjs', chunkFileNames: 'chunks/[name]-[hash].cjs' };

  const indexHtml: Plugin = {
    name: 'app-index-html',
    transformIndexHtml: (html) =>
      html.replace('%APP_CSP%', dev ? DEV_SERVER_CSP : PACKAGED_CSP).replace('%APP_NAME%', brand.displayName),
  };

  return {
    main: {
      define,
      // Every bundle lists the npm packages that went into it. scripts/notices.ts joins the lists into
      // THIRD_PARTY_NOTICES.txt; build.ts keeps the lists out of the package.
      plugins: [bundledPackages()],
      build: {
        outDir: 'out/main',
        externalizeDeps: true,
        rollupOptions: {
          input: { index: resolve(__dirname, 'src/main/index.ts'), worker: resolve(__dirname, 'src/worker/index.ts') },
          output: cjs,
        },
      },
    },
    preload: {
      define,
      plugins: [bundledPackages()],
      build: {
        outDir: 'out/preload',
        rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') }, output: cjs },
      },
    },
    renderer: {
      define,
      root: resolve(__dirname, 'src/renderer'),
      base: './',
      plugins: [react(), tailwindcss(), indexHtml, bundledPackages()],
      // An address, not "localhost": on Linux the dev server may take ::1 while the test proxy reaches 127.0.0.1.
      server: { host: '127.0.0.1' },
      build: {
        outDir: resolve(__dirname, 'out/renderer'),
        rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
      },
    },
  };
});
