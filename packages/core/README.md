# @app/core

The domain rules and use cases, in plain TypeScript. Everything outside goes through ports (ADR 0006,
IMPLEMENTATION.md §2.3).

- `ports/`: file system, links, store, clock, random, process, logger, faults, device services, and the ports later
  steps fill in (git, hosts, watcher, archive, catalog source, notifier).
- `shared/`: ids, errors (`AppError` with codes from `schemas`), paths for each OS, content hashes, events, results.
- `engine/`: the instance engine (one command queue per instance, background commands yield to user commands), the
  reconciler framework (plan, preview, apply step by step, with fault points) and the scheduler.
- `operations/`: journaled operations that resume after a crash (§2.6). The first real one is the local prefix's
  (Step 8); a worker resumes unfinished ones after its first library scan. A kind can ask that a failed journal is
  tried again at the next start (relocation, Step 9), and a journal whose operation changed nothing can be forgotten.
- `library/`: the library's language (Step 2). Value objects (`Prefix`, `SkillName`, `Tag`, `LibraryId`, `GitUrl`,
  the effective prefix), library.yaml with its version checks, the validation rules (each issue has a code and the
  message key `issues.<code>`), git-style fingerprints, the `LibrarySource` (the working tree; a git tree from Step 3),
  the scanner with its incremental refresh, the snapshot, and the `LibraryService` that loads and refreshes it as
  commands in the engine.
- `sync/` (Step 3): skill-level changes between two commits with rename detection that also pairs a short SKILL.md
  renamed with its `name:` line, and the applied-state baseline (the commit and skill list links were last adjusted
  for, in instance.db), the input to S6 and every "adjust links". `library/` reads a git tree too (`gitTreeSource`).
- `ports/git.ts`: the Git port, typed operations for the library and the four questions about a code repo.
- `engine/` also has the `WatchSet`, which coalesces watcher events from several folders into one batch.
- `device/`: the device registry (`device.json`), device operations that span main and a worker, the worker
  lifecycle and restart policy, data folders, and the login-shell environment reader.
- `catalog/`, `links/`, `activity/` (Step 5): the tools on this device and the choice of link folders, the
  skill-link reconciler with the health scenarios, and the activity log with the trash.
- `placement/` (Step 6): where each skill goes (PLAN.md §3.6). The pure calculator, placement edits applied to a copy
  for a preview and to instance.db on [Apply], the exclude-entry reconciler for code repos, and the placement service:
  repos and parent folders, worktrees, S10, tag suggestions and "the tag no longer exists". The link engine asks it
  where each skill goes through `LinkPlacement`, an interface the links module declares, so the two modules don't
  depend on each other both ways. The link engine records the link folders it makes in code repos, and its
  made-folder reconciler removes each one again once no link of the app is in it (A6.16).
- `instructions/` (Step 7): the company's instructions in each tool (PLAN.md §3.12). Pure: marked blocks (add,
  refresh and remove the app's block without changing a byte of the user's text), the strategies per tool (owned
  import file, owned copy with an import block, block with Codex's override file, OpenCode's block or config entry),
  the plan with fingerprints only, and the room left. The reconciler follows links to the file they point to and
  writes each shared file under the device lock; the service runs the check, "bring this change in" and "discard it",
  the view and the removal.
- `doctor/` (Step 7): the Doctor view's checks per tool (PLAN.md §3.4), and what the app takes from a tool's version
  and list commands. `device/` has the linking rules per company (`instructions-linking.ts`).
- `projection/` (Step 8): the local prefix and the projected copies (PLAN.md §3.3). Pure: the local prefix's rules,
  the suggestion from the library's URL, the names past 64 characters with a shorter prefix that fits, and the copies'
  plan (each side compared with the fingerprint both had at the last sync: refresh, write-back, or "both changed").
  The reconciler reads both sides with the git name restored and the library's ignored files left out. The service
  names the links under the local prefix for the link engine (`LinkProjection`, an interface the links module
  declares), syncs the copies before and after each link check, keeps the both-changed choice, and runs enabling,
  changing and dropping the local prefix as a durable operation. `onboarding/` asks for a local prefix after the
  download when the git prefix is in use on the device (another instance, or the user's own folders, by name only).
- `relocation/` (Step 9): changing the library's location (PLAN.md §3.9) and S9 (§3.8). Pure: the steps, the
  pre-flight problems besides the location check's, the changes made in the old folder during a copy (carried over
  at cleanup), and the summary by tool. The service runs the durable operation: one rename and a temporary pointer
  on the same disk, or a copy that is verified (files, fingerprints and `git status`) across disks; then the links
  are rewritten as a plan of retarget actions (the links module's `retargetReconciler`), Claude Code's owned file
  follows, main records the new place, and the worker starts again there. A failed move is tried again at the next
  start. S9's [Locate folder…] checks the library id and the remote; [Download again] clones into the configured
  place. The link engine reports a missing library folder as its own state, and changes nothing meanwhile.
- `recovery/` (Step 9): [Recover connections] (PLAN.md §3.5). When instance.db was lost without a backup, the
  registry is rebuilt from the links in the tool folders and in the repo folders the user adds again: only names that
  may be the library's are looked at, and of each only where it points. Repo links become individual additions, so
  the next check removes their global links; the tools whose folders hold the links are enabled again.
- `prefix/` (Step 14): the prefix lock and the prefix change (PLAN.md §3.2 "Locking"). Pure: who may change the
  prefix (a writer before the lock, an Admin after it), the new prefix's rules, and the rename plan (every folder that
  starts with the old prefix, with the names that would be too long, invalid or taken). The service takes the lock
  from the remote (a skill was ever pushed to the company branch), shows the warning (the renames, the mentions of
  skill names in the texts, the open requests, what blocks the change, and this device's clash), and makes the change
  as one commit that it pushes at once. The adjustments on each device are a durable operation: device.json's git
  prefix, a local prefix chosen for a clash, then the link check and the instruction files. The link check asks the
  service first (`prefixGate`): a new git prefix the device hasn't adjusted to is recorded, or, when it clashes here
  and nobody answered yet, the links wait for a local prefix in "Needs attention". The pull preview asks the same
  question through sync's `SyncPrefixHooks`.
- `samples/` (`@app/core/samples`): test-only samples that prove the operation runner, the reconciler framework and
  device operations (A1.11, A1.19). Test-hooks builds run them; production builds don't contain them.

Each module has `domain/` (pure rules) and `app/` (use cases), and other modules reach it only through its
`index.ts`. Rules, checked by `pnpm arch`: no Node or Electron imports, and no npm packages besides `schemas`,
`tools` and `brand`. So the YAML parsing and SKILL.md's format-preserving edits are in `schemas`, which the renderer
can use too; `library` builds its model on them. SHA-1 and SHA-256 are pure TypeScript in `shared/hash.ts`.
