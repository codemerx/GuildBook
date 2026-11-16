// Where the app's update feed and the signed tool catalog come from (ADR 0027, ADR 0031, PLAN.md §3.19, Step 18):
// - a release build: GitHub Releases of brand.releaseRepository: the feed of the latest release, its release page, and
//   the catalog as an asset of the release `catalog`, so a tool fix doesn't wait for an app release
// - a build made with a generic feed (BUILD_RELEASE_URL, the local release host of the packaging suite): the same
//   files under it
// - a test build started with --test-release-url: the test's release host
// - otherwise none: no update check and no catalog refresh. A test-hooks build (pnpm dev, a journey) never uses the
//   repository, so a development run or a test never calls GitHub.

export interface ReleaseFeed {
  /** The published catalog; its signature is next to it, with `.sig` added. */
  readonly catalogUrl: string | null;
  /** Where the update feed file (update-feed.ts) of the newest version is; null without a feed. */
  feedUrl(file: string): string | null;
  /** The page the user downloads a version from. */
  releasePage(version: string): string | null;
}

export const CATALOG_RELEASE_TAG = 'catalog';
export const CATALOG_FILE = 'catalog.json';

export function releaseFeed(input: {
  readonly buildUrl: string | null;
  readonly repository: { readonly owner: string; readonly repo: string } | null;
  readonly testUrl?: string | undefined;
  /** A test-hooks build: it ignores the repository. */
  readonly testHooks?: boolean | undefined;
}): ReleaseFeed {
  const base = (input.testUrl || input.buildUrl)?.replace(/\/+$/, '');
  if (base) {
    return {
      catalogUrl: `${base}/${CATALOG_RELEASE_TAG}/${CATALOG_FILE}`,
      feedUrl: (file) => `${base}/${file}`,
      releasePage: () => `${base}/`,
    };
  }
  if (input.repository && !input.testHooks) {
    const releases = `https://github.com/${input.repository.owner}/${input.repository.repo}/releases`;
    return {
      catalogUrl: `${releases}/download/${CATALOG_RELEASE_TAG}/${CATALOG_FILE}`,
      // GitHub sends this to the asset of the newest published release that isn't a pre-release.
      feedUrl: (file) => `${releases}/latest/download/${file}`,
      releasePage: (version) => `${releases}/tag/v${version}`,
    };
  }
  return { catalogUrl: null, feedUrl: () => null, releasePage: () => null };
}
