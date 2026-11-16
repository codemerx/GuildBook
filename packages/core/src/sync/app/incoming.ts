// The incoming preview and Pull (PLAN.md §3.10 "Pull, step by step", IMPLEMENTATION.md §2.5): the fetched commits
// with their flags, the library.yaml check, the conflicts git's own merge reports, the local changes that block the
// pull, and the link changes from a dry run over the tree the pull would produce, with the questions it raises
// ("tag gone", a skill that becomes available everywhere). Pull then brings in exactly the previewed commit and checks
// the plan hash before the merge starts. Conflicts stop it with the files as git leaves them; [Mark as resolved],
// [Commit merge] or [Continue], and [Abort merge] follow.
import { hasConflictMarkers, LIBRARY_FILE } from '@app/schemas';
import { gitTreeSource, overlaySource, readLibraryConfig, workingTreeSource } from '../../library/index.ts';
import type { Commit, ConflictKind, ConflictTake, Oid, RepoState, Status } from '../../ports/git.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import type { DomainEvent } from '../../shared/events.ts';
import { hashValue } from '../../shared/hash.ts';
import { groupOf } from '../domain/changes.ts';
import { allowedToolsChanged, type CommitFlags, isScript, skillsOf } from '../domain/flags.ts';
import {
  blobAt,
  onDisk,
  requireIdentity,
  type SyncDeps,
  type SyncPrefixChange,
  type SyncPlacedWhere as PlacedWhere,
  type SyncPlanView,
  textOf,
} from './sync-context.ts';

export interface IncomingCommit extends CommitFlags {
  readonly id: Oid;
  readonly subject: string;
  readonly author: string;
  readonly authorDate: number;
}

export interface SkillMove {
  readonly skill: string;
  readonly from: PlacedWhere;
  readonly to: PlacedWhere;
}

export interface IncomingPreview {
  /** `none`: nothing fetched is new; `ready`: there's something to pull. */
  readonly state: 'none' | 'ready';
  readonly upstream: string | null;
  /** The fetched commit Pull brings in, exactly (§2.5). */
  readonly target: Oid | null;
  readonly commits: readonly IncomingCommit[];
  /** The fetched library.yaml: with a newer `format` or a higher `minAppVersion`, Pull and Push wait for an update. */
  readonly compatibility: 'ok' | 'formatTooNew' | 'appTooOld';
  /** Conflicts git's merge reports, by path. */
  readonly conflicts: ReadonlyArray<{ readonly path: string; readonly type: string; readonly skill: string | null }>;
  /** Uncommitted changes to files the pull changes too (or any, for a rebase): commit first, or stash, pull and re-apply. */
  readonly localChanges: readonly string[];
  readonly skills: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly modified: readonly string[];
    readonly renamed: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  };
  /** Where links move: new skills' places, and skills whose places change (by repo name). */
  readonly moves: readonly SkillMove[];
  readonly plan: SyncPlanView | null;
  /** The links wanted after the pull (dest → target): what the check after the pull makes. */
  readonly links: ReadonlyArray<{ readonly dest: string; readonly target: string; readonly skill: string }>;
  readonly questions: {
    /** A ticked tag no skill carries after the pull (§3.6 Day 12), and the new tags it could become. */
    readonly tagsGone: ReadonlyArray<{
      readonly tag: string;
      readonly repos: ReadonlyArray<{ readonly id: string; readonly name: string }>;
      readonly suggestions: readonly string[];
    }>;
    /** Skills no repo claims after the pull: global by default, with [Change] (§3.6 Day 8). */
    readonly becomesGlobal: ReadonlyArray<{
      readonly skill: string;
      readonly repos: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    }>;
  };
  readonly mode: 'merge' | 'rebase';
  /**
   * The pull brings another git prefix (Step 14): how this device takes it. When it clashes here, Pull waits for a
   * local prefix (PLAN.md §3.2 step 3).
   */
  readonly prefix: SyncPrefixChange | null;
  /** What Pull checks before the merge starts. */
  readonly hash: string;
}

export type PullResult =
  | { readonly kind: 'pulled'; readonly commits: number; readonly merged: boolean }
  | { readonly kind: 'upToDate' }
  | { readonly kind: 'localChanges'; readonly files: readonly string[] }
  | { readonly kind: 'conflicts'; readonly files: readonly string[] }
  /** Pulled, but re-applying the stashed changes conflicted: the stash is kept. */
  | { readonly kind: 'stashConflicts'; readonly files: readonly string[] };

/** Whose side each part of a conflict is (PLAN.md §3.10: the buttons name it, because a rebase swaps them). */
export type ConflictSide =
  | { readonly kind: 'you' }
  | { readonly kind: 'person'; readonly name: string }
  | { readonly kind: 'stash' }
  | { readonly kind: 'revert'; readonly subject: string };

export interface ConflictsView {
  /** `stash`: re-applying stashed changes conflicted; no merge or rebase is under way. */
  readonly operation: RepoState['operation'] | 'stash';
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: ConflictKind;
    readonly skill: string | null;
    readonly binary: boolean;
    /** Markers are left in the file (a text conflict not yet resolved). */
    readonly markers: boolean;
  }>;
  readonly current: ConflictSide;
  readonly incoming: ConflictSide;
  /** Every conflict is marked as resolved: [Commit merge] or [Continue] can run. */
  readonly ready: boolean;
}

export interface ConflictFile {
  readonly path: string;
  readonly kind: ConflictKind | null;
  readonly binary: boolean;
  /** The file in the folder, with its markers; null when it's deleted or binary. */
  readonly text: string | null;
  /** The three-way view: the common base, the current side and the incoming side; null where a side has none. */
  readonly base: string | null;
  readonly current: string | null;
  readonly incoming: string | null;
}

export type ContinueResult =
  | { readonly kind: 'done' }
  | { readonly kind: 'conflicts'; readonly files: readonly string[] }
  | { readonly kind: 'unresolved'; readonly files: readonly string[] };

/** How many fetched commits the preview lists. */
const PREVIEW_COMMITS = 100;

export class PullFlow {
  readonly #deps: SyncDeps;
  readonly #emit: () => void;
  readonly #flags = new Map<string, CommitFlags>();

  constructor(deps: SyncDeps, emit: () => void) {
    this.#deps = deps;
    this.#emit = emit;
  }

  /** A commit's flags (PLAN.md §3.15), kept by id: a commit never changes. */
  async flags(commit: Commit): Promise<CommitFlags> {
    const known = this.#flags.get(commit.id);
    if (known) return known;
    const { repo } = this.#deps;
    const details = await repo.show(commit.id);
    const paths = details.changes.flatMap((c) => (c.from ? [c.path, c.from] : [c.path]));
    let allowedTools = false;
    const parent = commit.parents[0] ?? null;
    for (const change of details.changes) {
      if (!/^skills\/[^/]+\/SKILL\.md$/.test(change.path) || change.status === 'deleted') continue;
      const before = parent === null ? null : textOf(await blobAt(repo, parent, change.from ?? change.path));
      const after = textOf(await blobAt(repo, commit.id, change.path));
      if (allowedToolsChanged(before, after)) allowedTools = true;
    }
    const flags = { scripts: paths.some(isScript), allowedTools, skills: skillsOf(paths) };
    this.#flags.set(commit.id, flags);
    return flags;
  }

  async #compatibility(target: Oid): Promise<IncomingPreview['compatibility']> {
    const bytes = await blobAt(this.#deps.repo, target, LIBRARY_FILE).catch(() => null);
    const result = readLibraryConfig(textOf(bytes), this.#deps.appVersion).compatibility;
    return result === 'formatTooNew' || result === 'appTooOld' ? result : 'ok';
  }

  /** The fetched library.yaml's check alone: the sync bar disables Pull and Push with it (PLAN.md §3.2). */
  async compatibility(status: Status): Promise<IncomingPreview['compatibility']> {
    if (!status.upstream) return 'ok';
    const target = await this.#deps.repo.resolve(status.upstream);
    return target === null ? 'ok' : this.#compatibility(target);
  }

  /**
   * The incoming preview, with the user's answers to its questions applied: `edits` for placement, `localPrefix` for
   * a new git prefix that clashes on this device (Step 14).
   */
  async preview(edits: readonly unknown[], localPrefix: string | null = null): Promise<IncomingPreview> {
    const { repo, store, links, baseline, paths, fs } = this.#deps;
    links.checkPlacement(edits);
    const mode = store.read((tx) => tx.settings.get()).pullMode;
    const status = await repo.status();
    const target = status.upstream ? await repo.resolve(status.upstream) : null;
    const empty: IncomingPreview = {
      state: 'none',
      upstream: status.upstream,
      target,
      commits: [],
      compatibility: 'ok',
      conflicts: [],
      localChanges: [],
      skills: { added: [], removed: [], modified: [], renamed: [] },
      moves: [],
      plan: null,
      links: [],
      questions: { tagsGone: [], becomesGlobal: [] },
      mode,
      prefix: null,
      hash: hashValue({ target, edits }),
    };
    // A branch without a commit has no upstream to be behind: there's nothing to preview.
    const head = status.head;
    if (target === null || head === null || status.behind === 0) return empty;
    const listed = await repo.log({ range: `${head}..${target}`, max: PREVIEW_COMMITS });
    const commits: IncomingCommit[] = [];
    for (const commit of listed) {
      const flags = await this.flags(commit);
      commits.push({
        id: commit.id,
        subject: commit.subject,
        author: commit.author.name,
        authorDate: commit.authorDate,
        ...flags,
      });
    }
    const compatibility = await this.#compatibility(target);
    // The tree git itself would produce (merge-tree), with conflicts as git reports them.
    const merged = await repo.mergeTree(head, target);
    const changedByPull = await repo.diff(head, merged.tree);
    const pulling = new Set(changedByPull.flatMap((c) => (c.from ? [c.path, c.from] : [c.path])));
    const local = status.entries.filter((e) => e.kind !== 'conflicted');
    const localChanges = local
      .filter((e) =>
        mode === 'rebase'
          ? e.kind !== 'untracked'
          : pulling.has(e.path) || (e.kind === 'changed' && e.from !== null && pulling.has(e.from)),
      )
      .map((e) => e.path)
      .sort();
    // Uncommitted changes the pull doesn't touch stay as they are: laid over the tree.
    const overlay = new Map<string, 'present' | 'deleted'>();
    for (const entry of local) {
      if (localChanges.includes(entry.path)) continue;
      if (entry.kind === 'changed' && entry.from !== null) overlay.set(entry.from, 'deleted');
      const deleted =
        entry.kind === 'changed' &&
        (entry.unstaged === 'deleted' || (entry.staged === 'deleted' && entry.unstaged === 'unmodified'));
      overlay.set(entry.path, deleted ? 'deleted' : 'present');
    }
    const source = overlaySource(
      gitTreeSource(repo, merged.tree),
      workingTreeSource(fs, paths, this.#deps.libraryRoot() as AbsPath),
      overlay,
    );
    const snapshot = await this.#deps.scan(source);
    const changes = await baseline.between(head, merged.tree);
    const renames = changes.renamed.map((r) => ({ from: r.from, to: r.to }));
    const prefix = (await this.#deps.prefix?.preview(snapshot, localPrefix)) ?? null;
    // A valid answer to the local-prefix question: the dry run names the links under it.
    const answered =
      prefix?.clash && prefix.localPrefix === null && prefix.answer?.problem === null ? prefix.answer.prefix : null;
    const library = { snapshot, tree: merged.tree, renames, ...(answered === null ? {} : { localPrefix: answered }) };
    const preview = await links.previewLibrary(library, edits);
    const unanswered = edits.length === 0 ? preview : await links.previewLibrary(library, []);
    const name = (id: string) => links.repoName(id) ?? id;
    const moves: SkillMove[] = [];
    for (const place of preview.places.placements) {
      const to: PlacedWhere = { global: place.global, repos: place.repos.map(name).sort() };
      const renamedFrom = renames.find((r) => r.to === place.skill)?.from;
      const from = preview.before.get(renamedFrom ?? place.skill) ?? { global: false, repos: [] };
      const key = (w: PlacedWhere) => `${w.global}:${w.repos.join(',')}`;
      const isNew = changes.added.includes(place.skill);
      if (isNew || key(from) !== key(to)) moves.push({ skill: place.skill, from, to });
    }
    const currentTags = new Set((this.#deps.snapshot()?.tags ?? []).map((t) => t.tag));
    const newTags = snapshot.tags.map((t) => t.tag).filter((tag) => !currentTags.has(tag));
    const becomesGlobal = unanswered.places.placements
      .filter((p) => p.kind === 'global')
      .flatMap((p) => {
        const was = preview.before.get(renames.find((r) => r.to === p.skill)?.from ?? p.skill);
        if (!was || was.global || was.repos.length === 0) return [];
        const ids = this.#repoIds(was.repos);
        return [{ skill: p.skill, repos: ids.map((id) => ({ id, name: name(id) })) }];
      });
    return {
      state: 'ready',
      upstream: status.upstream,
      target,
      commits,
      compatibility,
      conflicts: merged.conflicts.map((c) => ({ path: c.path, type: c.type, skill: groupOf(c.path).skill })),
      localChanges,
      skills: {
        added: [...changes.added],
        removed: [...changes.deleted],
        modified: [...changes.modified],
        renamed: renames,
      },
      moves,
      plan: preview.view,
      links: preview.links,
      questions: {
        tagsGone: unanswered.places.tagsGone.map((gone) => ({
          tag: gone.tag,
          repos: gone.repos.map((id) => ({ id, name: name(id) })).sort((a, b) => (a.name < b.name ? -1 : 1)),
          suggestions: newTags,
        })),
        becomesGlobal,
      },
      mode,
      prefix,
      hash: hashValue({
        target,
        plan: preview.hash,
        edits,
        mode,
        localChanges,
        prefix: prefix && {
          to: prefix.gitPrefix,
          clash: prefix.clash,
          local: prefix.localPrefix,
          answer: prefix.answer,
        },
      }),
    };
  }

  /** Repo names (as `PlacedWhere` has them) back to their ids, through the link engine's names. */
  #repoIds(names: readonly string[]): string[] {
    const ids = this.#deps.store.read((tx) => tx.placement.repos()).filter((r) => !r.hidden);
    return names.flatMap((n) => ids.filter((r) => r.name === n).map((r) => r.id));
  }

  /**
   * Pull (PLAN.md §3.10): exactly the previewed commit, merged or rebased as the setting says, after the plan hash is
   * checked. With `stash`, local changes are stashed and re-applied (git's autostash).
   */
  async pull(
    input: { planHash: string; edits: readonly unknown[]; stash: boolean; localPrefix?: string | null | undefined },
    emit: (event: DomainEvent) => void,
  ): Promise<PullResult> {
    const { repo, links, activity, store } = this.#deps;
    const preview = await this.preview(input.edits, input.localPrefix ?? null);
    if (preview.state === 'none' || preview.target === null || preview.upstream === null) return { kind: 'upToDate' };
    if (preview.compatibility !== 'ok') throw new AppError('sync.libraryTooNew', { reason: preview.compatibility });
    // What the user confirmed is what happens (§2.5): a merge can't be taken back as "not applied".
    if (preview.hash !== input.planHash) throw new AppError('plan.changed', { kind: 'pull' });
    if (preview.localChanges.length > 0 && !input.stash) return { kind: 'localChanges', files: preview.localChanges };
    // A new prefix that clashes here needs its local prefix before the merge (PLAN.md §3.2 step 3).
    const prefixHooks = this.#deps.prefix;
    const answer = preview.prefix && prefixHooks ? prefixHooks.answer(preview.prefix, input.localPrefix ?? null) : null;
    const identity = requireIdentity(store);
    const outcome = await repo.integrate({
      commit: preview.target,
      name: preview.upstream,
      mode: preview.mode,
      autostash: input.stash,
      identity,
    });
    if (outcome.kind === 'wouldBeOverwritten') return { kind: 'localChanges', files: outcome.files };
    if (outcome.kind === 'conflicts') {
      this.#emit();
      return { kind: 'conflicts', files: outcome.files };
    }
    links.persistPlacement(input.edits);
    const authors = [...new Set(preview.commits.map((c) => c.author))].sort();
    activity.append([
      {
        kind: 'pulled',
        path: null,
        commit: preview.target,
        author: authors.join(', '),
        details: {
          commits: preview.commits.length,
          authors,
          added: [...preview.skills.added],
          modified: [...preview.skills.modified],
          removed: [...preview.skills.removed],
          renamed: preview.skills.renamed.map((r) => ({ from: r.from, to: r.to })),
          merged: outcome.kind === 'merged' || outcome.kind === 'rebased',
          local: preview.localChanges.length,
        },
      },
    ]);
    if (preview.prefix && prefixHooks) await prefixHooks.afterPull(preview.prefix, answer, emit);
    else await links.checkNow(emit);
    this.#emit();
    if (outcome.kind === 'upToDate') return { kind: 'upToDate' };
    if (outcome.kind === 'stashConflicts') return { kind: 'stashConflicts', files: outcome.files };
    return { kind: 'pulled', commits: preview.commits.length, merged: outcome.kind !== 'fastForwarded' };
  }

  // ---- Conflicts ----------------------------------------------------------------------------------------------

  async #side(commit: Oid | null): Promise<ConflictSide> {
    if (commit === null) return { kind: 'you' };
    const [details] = await this.#deps.repo.log({ range: commit, max: 1 });
    return details ? { kind: 'person', name: details.author.name } : { kind: 'you' };
  }

  async conflicts(): Promise<ConflictsView> {
    const { repo, fs } = this.#deps;
    const state = await repo.state();
    const list = await repo.conflicts();
    const files = [];
    for (const conflict of list) {
      const file = onDisk(this.#deps, conflict.path);
      const entry = await fs.lstat(file);
      const bytes = entry?.kind === 'file' ? await fs.readBytes(file) : null;
      const text = textOf(bytes);
      files.push({
        path: conflict.path,
        kind: conflict.kind,
        skill: groupOf(conflict.path).skill,
        binary: bytes !== null && text === null,
        markers: text !== null && hasConflictMarkers(text),
      });
    }
    const heads = await repo.operationHeads();
    let current: ConflictSide = { kind: 'you' };
    let incoming: ConflictSide = { kind: 'you' };
    if (state.operation === 'merging') incoming = await this.#side(heads.incoming);
    else if (state.operation === 'rebasing') current = await this.#side(heads.onto);
    else if (state.operation === 'reverting') {
      const [reverted] = heads.incoming ? await repo.log({ range: heads.incoming, max: 1 }) : [];
      incoming = { kind: 'revert', subject: reverted?.subject ?? '' };
    } else if (list.length > 0) {
      // Re-applying a stash: "current" is what the branch has now, "incoming" the stashed changes.
      current = await this.#side(await repo.resolve('HEAD'));
      incoming = { kind: 'stash' };
    }
    return {
      operation: state.operation === 'none' && list.length > 0 ? 'stash' : state.operation,
      files,
      current,
      incoming,
      ready: state.operation !== 'none' && list.length === 0,
    };
  }

  async file(path: string): Promise<ConflictFile> {
    const { repo, fs } = this.#deps;
    const kind = (await repo.conflicts()).find((c) => c.path === path)?.kind ?? null;
    const disk = onDisk(this.#deps, path);
    const entry = await fs.lstat(disk);
    const bytes = entry?.kind === 'file' ? await fs.readBytes(disk) : null;
    const versions = kind ? await repo.conflictVersions(path) : { base: null, ours: null, theirs: null };
    const read = async (oid: Oid | null) => (oid === null ? null : repo.readBlob(oid));
    const [base, ours, theirs] = await Promise.all([read(versions.base), read(versions.ours), read(versions.theirs)]);
    const binary = [bytes, base, ours, theirs].some((b) => b !== null && textOf(b) === null);
    return {
      path,
      kind,
      binary,
      text: binary ? null : textOf(bytes),
      base: binary ? null : textOf(base),
      current: binary ? null : textOf(ours),
      incoming: binary ? null : textOf(theirs),
    };
  }

  /** [Keep mine] / [Use theirs] for a binary file, [Keep it] / [Delete it] for edit vs delete. */
  async take(path: string, take: ConflictTake): Promise<void> {
    const { repo, activity } = this.#deps;
    if (!(await repo.conflicts()).some((c) => c.path === path)) throw new AppError('sync.notConflicted', { path });
    await repo.takeConflict(path, take);
    activity.append([{ kind: 'conflict-resolved', path, details: { take } }]);
    this.#emit();
  }

  /** [Mark as resolved]: refused while a file still has conflict markers (PLAN.md §3.10). */
  async markResolved(paths: readonly string[]): Promise<void> {
    const { repo, fs, activity } = this.#deps;
    const conflicted = new Set((await repo.conflicts()).map((c) => c.path));
    for (const path of paths) {
      if (!conflicted.has(path)) throw new AppError('sync.notConflicted', { path });
      const file = onDisk(this.#deps, path);
      if ((await fs.lstat(file))?.kind !== 'file') continue;
      const text = textOf(await fs.readBytes(file));
      if (text !== null && hasConflictMarkers(text)) throw new AppError('sync.markersLeft', { path });
    }
    await repo.markResolved(paths);
    activity.append(paths.map((path) => ({ kind: 'conflict-resolved' as const, path, details: { take: 'edited' } })));
    this.#emit();
  }

  /** [Commit merge] with git's message, or [Continue] a rebase or revert; a stash's conflicts end when all are resolved. */
  async continue(emit: (event: DomainEvent) => void): Promise<ContinueResult> {
    const { repo, links, activity, store } = this.#deps;
    const state = await repo.state();
    const outcome = await repo.continue(requireIdentity(store));
    if (outcome.kind !== 'done') {
      this.#emit();
      return outcome;
    }
    const kind = state.operation === 'reverting' ? 'reverted' : 'merged';
    activity.append([{ kind, path: null, commit: outcome.head, details: { operation: state.operation } }]);
    await links.checkNow(emit);
    this.#emit();
    return { kind: 'done' };
  }

  /** [Abort merge]: back to the state before the pull, local changes included (PLAN.md §3.10). */
  async abort(emit: (event: DomainEvent) => void): Promise<void> {
    const { repo, links, activity } = this.#deps;
    const state = await repo.state();
    await repo.abort();
    activity.append([{ kind: 'merge-aborted', path: null, details: { operation: state.operation } }]);
    await links.checkNow(emit);
    this.#emit();
  }
}
