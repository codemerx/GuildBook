// The product name and every value derived from it (PLAN.md §3.16). Nothing else in the code base writes these
// values: it imports them from here, and `pnpm brand:check` fails if any of them appears anywhere else (A1.16).
// Translated texts insert the name through `{{appName}}` (IMPLEMENTATION.md §2.11).

export const brand = {
  /** What users see: window titles, the tray, dialogs. */
  displayName: 'Guild Book',
  /** The npm-style name: installers, the Linux package, the program on Windows and Linux (macOS: displayName). */
  packageName: 'guildbook',
  /** Signing and auto-update identity (macOS bundle id, Windows AppUserModelID). */
  appId: 'com.codemerx.guildbook',
  /** The data folder: ~/Library/Application Support/<this>, %LOCALAPPDATA%\<this>, ~/.config/<this>. */
  dataFolderName: 'GuildBook',
  /** Default library location: ~/<this>/<owner> (PLAN.md §3.16). */
  defaultLibraryFolderName: 'GuildBook',
  /** The marker in instruction files: <!-- guildbook:begin … --> (PLAN.md §3.12). */
  instructionMarker: 'guildbook',
  /** Owned instruction files are named <this><effective prefix>.md (PLAN.md §3.12). */
  ownedFilePrefix: 'guildbook-',
  /** The invite-link scheme: guildbook://… (PLAN.md §3.17). */
  protocolScheme: 'guildbook',
  /** Copy mode's marker file (PLAN.md §3.4). */
  copyModeMarkerFile: '.guildbook-link.json',
  /** The GitHub App users install: github.com/apps/<this> (PLAN.md §3.17). */
  githubAppSlug: 'guild-book',
  /**
   * The public client ids of the app's GitHub App on github.com and its OAuth application on gitlab.com, for the
   * device flow (PLAN.md §3.17 step 2). The GitHub App is registered (organization codemerx). The GitLab application
   * is not: until it is, sign-in on gitlab.com asks for a client id, as self-hosted servers do.
   */
  githubAppClientId: 'Iv23liTb8BL0hVxI7vtK' as string | null,
  gitlabClientId: null as string | null,
  /**
   * The GitHub repository whose releases carry the app's updates (ADR 0027, Step 18). Production builds check its
   * update feed once a day; the tool catalog is inside the app (ADR 0037). Test-hooks builds never check it: they use
   * only a release host that a test gives them (apps/desktop/src/main/release-feed.ts).
   */
  releaseRepository: { owner: 'codemerx', repo: 'GuildBook' } as {
    readonly owner: string;
    readonly repo: string;
  } | null,
  /** Who publishes the app (installer metadata). */
  vendor: 'CodeMerx',
  /** The app's web page in installer metadata: the repository. */
  homepage: 'https://github.com/codemerx/GuildBook',
} as const;

export type Brand = typeof brand;

/** The values the brand check searches for, from the most specific to the most general. */
export function brandNeedles(): string[] {
  return [
    brand.displayName,
    brand.packageName,
    brand.appId,
    brand.dataFolderName,
    brand.instructionMarker,
    brand.githubAppSlug,
  ];
}
