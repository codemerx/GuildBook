# @app/adapters

The Node implementations of `core`'s ports (IMPLEMENTATION.md §2.2). It's the only package that imports `node:fs`,
`node:child_process` and SQLite.

- `fs/`: `NodeFileSystem`, and `GuardedFileSystem`, which refuses writes outside the allowed roots and keeps an audit
  log in test mode (A1.7); `treeOf` for state dumps. A link folder the app made in a code repo may be removed only
  while it's empty (`removeEmptyFolder`, A6.16). Step 9: a root that is a link itself (relocation's pointer at the
  old place) is read and removed as an entry, never followed.
- `links/`: links on every OS (symlinks, junctions on Windows; ADR 0017).
- `store/`: `SqliteStore` on `node:sqlite` (ADR 0011) with migrations and a backup before each one (A1.4). Step 9:
  `instance-database.ts` keeps automatic backups in `<data folder>/backups/` (one a day, the newest three), restores
  the latest one when `instance.db` is missing or damaged (the damaged file is kept beside it), and says when neither
  is possible, so the connections wait for [Recover connections]. A file that isn't SQLite is damage, never "newer
  data".
- `logging/`: the file logger and redaction (ADR 0020).
- `clock/`: `OffsetClock`, the clock test mode moves (TESTING.md §6), and `nodeRandom`.
- `process/`, `env/`, `network/`: programs the app starts, the environment, and the certificate bundle.
- `watcher/`: `ParcelWatcher`, the Watcher port on @parcel/watcher (a native module, also a dependency of
  `apps/desktop`, ADR 0005).
- `git/`: `DugiteGit`, the Git port on dugite's bundled git (ADR 0013, Step 3). Each command gets an environment built
  from scratch (`git-env.ts`): the token as a per-origin header through `GIT_CONFIG_*`, the proxy and the certificate
  bundle, an app-kept SSH key as a 0600 file for one command, the settings the app relies on whatever the user's git
  config says, no editor, `LC_ALL=C`, and dates from the clock (ADR 0014, 0015). `guard.ts` lets a code repo answer
  only PLAN.md §3.7's four questions (ADR 0017); `parse.ts` reads git's NUL-separated output; `classify.ts` turns its
  messages into `git.*` errors and push rejections. Step 8: `ignored()` asks `git check-ignore` which paths the
  library's ignore rules match, so a projected copy never writes them back.
- `volumes/`: `NodeVolumes`: the kind of disk, the free space, write access, and (Step 9) the disk's number, so a
  relocation knows whether one rename can move the library. Test mode simulates any of them.
- `catalog/`: `CatalogLoader`, the bundled tool catalog unless a refreshed one has a valid ed25519 signature from a
  trusted key (ADR 0026); `verifySignedCatalog`.

- **Imports:** `core`, `schemas`, `tools`, `brand`.
