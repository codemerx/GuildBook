# @app/testkit

The fixtures of the development build: `pnpm dev [--world <name>]` starts the app in a fresh test root with a world. Nothing
in the app imports this package (`pnpm arch` checks this).

- `worlds/`: the world builder and the named worlds, for example `empty`, `acme-basic`, `taken-names`, `repos-and-tags`,
  `two-companies` and `incoming-changes`. A world sets up a device in a chosen state: tool folders, libraries, code repos
  and a fake git host. The fixture libraries `acme-valid` and `acme-invalid` are built from the corpus.
- `corpus/`: real and generated `SKILL.md` and `AGENTS.md` files, kept byte for byte. Its README lists the sources and
  the licenses.
- `harness/`: test roots (a fake home folder with app-data and XDG folders) and a recording proxy that refuses every host
  but the ones a run allows.
- `hosts/`: the fake host server: git over HTTPS through `git http-backend`, with a test certificate authority and server
  hooks that refuse pushes to protected branches in the words of GitHub and GitLab. `testGit` runs git as the other side
  of a run would.
- `fakes/memory-fs.ts`: the in-memory file system that the fixture libraries use.
