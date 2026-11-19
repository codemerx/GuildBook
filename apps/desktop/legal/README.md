# Texts for the notices of the installers

`scripts/notices.ts` copies these files into `THIRD_PARTY_NOTICES.txt`, which every installer holds. They are kept byte for
byte as the projects publish them (`.gitattributes` turns off line-ending conversion here, and Prettier skips this folder).

| File                   | What it is                                                                          | Source                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `git-COPYING.txt`      | The license of Git (GPL version 2) with the note of Linus Torvalds, tag `v2.56.1`   | https://raw.githubusercontent.com/git/git/v2.56.1/COPYING                 |
| `git-lfs-LICENSE.md`   | The license of Git LFS (MIT), tag `v3.8.1`                                          | https://raw.githubusercontent.com/git-lfs/git-lfs/v3.8.1/LICENSE.md       |
| `git-lfs-modules/`     | The software inside the program `git-lfs`: the Go modules and the Go standard library | The Go module proxy, see below                                            |
| `gitleaks-LICENSE.txt` | The license of gitleaks (MIT). The secret rules of the app are adapted from it      | The same text as in `packages/core/src/sync/domain/secrets.ts`            |
| `versions.json`        | The versions that the files above belong to                                         | https://github.com/desktop/dugite-native/blob/v2.56.1/dependencies.json   |

The Git folder of dugite also holds Git Credential Manager (GCM) with the .NET runtime. The app never starts it, so the
build deletes it from the packaged app (`scripts/git-bundle.ts`, ADR 0035, decision 7). The installers do not hold GCM,
and this folder has no text for it.

## The Go software inside Git LFS

`git-lfs` is a Go program. It holds the Go standard library and Go modules of other projects, each under its own license,
and the license of Git LFS only points to them. `git-lfs-modules/` holds one license text for each module, in the folder
`<module>@<version>/`, as the file of the module root has it. `modules.json` lists the modules with their version, the
`h1:` hash that the program holds, the license, the hash of the text and the systems whose program holds the module. The
Windows programs hold 3 modules that the macOS and Linux programs do not, and the macOS and Linux programs hold 8 that the
Windows programs do not (20 modules are in all six programs), so the list for Git LFS v3.8.1 is the union of 31.
`go-LICENSE.txt` is the license of the Go release that built the programs (go1.27.3; the same text as for go1.25). The
`PATENTS` files of the `golang.org/x` modules are a patent grant, not a license text, and are not copied.

A module can hold a copy of another project with its own license file, which the text of the module root does not cover.
When the program holds that part, `more` in `modules.json` names the file too (`part`, `file`, `sha256`), and the notices
print it after the main text. In v3.8.1: `github.com/klauspost/compress`, whose `zstd` holds `xxhash` (MIT,
`zstd/internal/xxhash/LICENSE.txt`). A text with several licenses gets an expression (`MIT AND BSD-3-Clause`).

A production build stops when `modules.json` is for another Git LFS release than `versions.json`, when a text is missing
or is not the text that `modules.json` names (hash), or when a license is not in `ALLOWED_LICENSES` (the MPL-2.0 is the one
more that is allowed for Go modules: the notices then name where the source code is).

To make the list for a new Git LFS release (the programs are in the Git folder of dugite, in `libexec/git-core` or
`<prefix>/libexec/git-core`; the six archives of `dugite-native` hold one for each system):

1. `go version -m <program>` reads the Go build information of a program and does not run it. Each `dep` line names a module,
   its version and its `h1:` hash. The first line names the Go release. Take the union of all programs. The macOS programs of
   v3.8.1 have no `h1:` hashes (a build from a vendor folder): take the hash from the Linux or Windows program, and stop if two
   programs give different hashes. The macOS and Linux programs were built as `command-line-arguments`, so Git LFS itself shows
   as `github.com/git-lfs/git-lfs/v3 (devel)`: it is not a module of the list (its license is `git-lfs-LICENSE.md`).
2. In an empty folder, with a new `GOMODCACHE`: `go mod download -json <module>@<version>` for each module. `Sum` must equal
   the `h1:` hash of the `dep` line (the Go checksum database checks it too), and `Dir` is the folder of the module.
3. Copy the license file of the module root, and the `NOTICE` file if there is one, into `git-lfs-modules/<module>@<version>/`
   without a change. A module without a license file needs a decision. Look for license files below the root too, in the
   packages that the program holds (`strings <program> | grep <module>/` names them), and name them in `more`.
4. Write `modules.json` (license by reading the text, `sha256` of the file, the systems) and the license of the Go release
   into `go-LICENSE.txt`.

## When dugite changes

The Git program in the app comes from the npm package `dugite`, which downloads a build of the project `dugite-native`.
`versions.json` names the release of `dugite-native` that these texts belong to. `scripts/notices.ts` compares it with the
release that `dugite` downloads, and a production build stops when they differ. Then:

1. Read `dependencies.json` of the new `dugite-native` release for the versions of Git, Git for Windows and Git LFS. If it
   names a program that is new, the installers hold it: add its license text here and name it in `scripts/notices.ts`.
2. Download the license files of those tags again, compare them with these files, and update the files that changed.
3. If the version of Git LFS changed, make the list of its Go modules again (the section above).
4. Write the new versions into `versions.json`.
5. Build on each system. `scripts/git-bundle.ts` deletes GCM, and a production build stops when a file of GCM stays,
   when a file that nobody knows stands where GCM stood, when a program that the app needs is gone, or when Git does not
   start. The message names the files. Change the rules in `scripts/git-bundle.ts` for the new layout.
