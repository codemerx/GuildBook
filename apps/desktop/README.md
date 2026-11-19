# @app/desktop

The Electron app (ADR 0003, IMPLEMENTATION.md §2.1).

- `src/main/`: main. The composition root (`composition.ts`), launch configuration (`config.ts`), the worker
  supervisor, instances, device services (locks, secrets, device facts), the port broker, the asset protocol, the
  tray, and thin wrappers around Electron in `electron/`. `test-hooks/` holds the test API; only test-hooks builds
  include it. Step 7: linking instructions per company in `instances.ts`, and the tools' version and list commands
  (`tool-commands.ts`, scripted in test mode). A macOS test window is transparent and never takes the focus
  (`electron/window.ts`, TESTING.md §3). Step 8: an instance's local prefix in `device.json` (`instances.ts`), which
  its worker's operation records through the device services, and the setup's local-prefix page (`setups.ts`). Step 9:
  a moved library's new place in `device.json`, recorded the same way, and the worker started again there
  (`instances.ts`); Settings → Remove everything as a device operation (`remove-everything.ts`), which the Windows
  uninstaller runs in the no-window mode (`resources/uninstall.nsh`).
- `src/worker/`: one utility process per instance. It opens `instance.db`, runs the engine and answers the renderer.
  Step 8: it watches the projected copies with the library, and resumes unfinished operations after the first scan.
  Step 9: it opens `instance.db` with its backups (`openInstanceDatabase`), backs it up daily, and runs relocation
  and [Recover connections] beside the link engine; a move pauses the watchers and the checks until the worker starts
  again at the new place.
- `src/preload/`: hands the renderer its message ports and nothing else.
- `src/renderer/`: React. The app shell, router, query client, i18n, theme and feature folders (Step 7:
  `instructions/` and `doctor/`; Step 8: `projection/` for the local prefix and the both-changed dialog, and the
  setup's local-prefix page; Step 9: `relocation/` for the library's location card, the move dialog and its summary,
  and S9's and recovery's answers in "Needs attention", and Settings → Remove everything).
- `src/shared/`: code main and the renderer both use (translations, CSP, asset URLs).

Builds (`scripts/build.ts`, ADR 0021 and 0023): `pnpm build:prod` (every production fuse, no test hooks) and
`pnpm build:test` (the same plus the test hooks and the `--inspect` fuse). Without `--installers` they package an
unpacked app. `pnpm dev` runs a development build in a fresh test root.
`pnpm storybook` shows the UI components.

Every build also writes `THIRD_PARTY_NOTICES.txt` into the resources folder of the app, with `LICENSE` and `NOTICE`
(`scripts/notices.ts`, ADR 0035): the name, version and license text of each npm package in the app, of Electron and of
Git. A production build stops on a license that nobody approved (`ALLOWED_LICENSES`). `legal/` holds the license texts
of Git and the other programs that `dugite` brings; its README says how to update them.

The Git folder of `dugite` also holds Git Credential Manager, which the app never starts. Every build deletes it from
the packaged app, after the files are copied and before the app is signed ad hoc (`scripts/git-bundle.ts`, ADR 0035); the
folder in `node_modules` stays as it is. A production build stops when a file of it stays, when an unknown file stands
where it stood, or when the Git of the package does not start.

- **Imports:** main and the worker use `core`, `adapters`, `ipc`, `schemas`, `tools` and `brand`; the renderer uses
  `ipc`, `editor`, `schemas` and `brand`; the preload imports nothing.
