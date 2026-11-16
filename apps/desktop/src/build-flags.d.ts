// Build-time flags (IMPLEMENTATION.md §2.11, §2.16), replaced by electron-vite's `define`.

/** True in test-hooks builds (tests, development); false in production builds, which then contain no test hooks. */
declare const __TEST_HOOKS__: boolean;
/** True when running from the development server (`pnpm dev`). */
declare const __DEV_BUILD__: boolean;
/** The app's version, from apps/desktop/package.json, or the one a release build was made with (BUILD_VERSION). */
declare const __APP_VERSION__: string;
/**
 * A generic update feed the build was made with (BUILD_RELEASE_URL): the local update server of the release rehearsal
 * (A18.3). Null in every other build, which then uses brand.releaseRepository.
 */
declare const __RELEASE_URL__: string | null;
