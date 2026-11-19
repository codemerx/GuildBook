// Where the app's update feed comes from (ADR 0027, ADR 0031, PLAN.md §3.19, Step 18):
// - a release build: GitHub Releases of brand.releaseRepository: the feed of the latest release, and its release page
// - a build made with a generic feed (BUILD_RELEASE_URL, the local release host of the packaging suite): the same
//   files under it
// - a test build started with --test-release-url: the test's release host
// - otherwise none: no update check. A test-hooks build (pnpm dev, a journey) never uses the repository, so a
//   development run or a test never calls GitHub.
// The tool catalog is not downloaded: it ships with the app, and a change to it comes with a new version (ADR 0037).

export interface ReleaseFeed {
  /** Where the update feed file (update-feed.ts) of the newest version is; null without a feed. */
  feedUrl(file: string): string | null;
  /** The page the user downloads a version from. */
  releasePage(version: string): string | null;
}

/** A downloaded file: the HTTP status and the body. */
export interface FetchedFile {
  readonly status: number;
  readonly bytes: Uint8Array;
}

/** A feed file is far smaller; anything larger is refused before it's read. */
export const MAX_RELEASE_FILE_BYTES = 2 * 1024 * 1024;

/** The update feed comes only over HTTPS, apart from a loopback address: a test's release host (A18.3). */
export function allowedReleaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname);
}

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
      feedUrl: (file) => `${base}/${file}`,
      releasePage: () => `${base}/`,
    };
  }
  if (input.repository && !input.testHooks) {
    const releases = `https://github.com/${input.repository.owner}/${input.repository.repo}/releases`;
    return {
      // GitHub sends this to the asset of the newest published release that isn't a pre-release.
      feedUrl: (file) => `${releases}/latest/download/${file}`,
      releasePage: (version) => `${releases}/tag/v${version}`,
    };
  }
  return { feedUrl: () => null, releasePage: () => null };
}
