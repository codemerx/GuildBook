// The prefix lock and the prefix change (IMPLEMENTATION.md Step 14, PLAN.md §3.2 "Locking").
// - The lock is taken from the remote: the prefix is locked once a skill was ever pushed to the company branch.
// - Before the lock, anyone who can push to the company branch corrects the prefix: a one-line commit to library.yaml,
//   pushed at once. After it, an Admin changes it: one commit renames every folder and `name:` line, after a warning
//   that lists the count, the mentions of skill names in the texts (never rewritten), and the open requests.
// - On every device the adjustments follow the change: the user's choices move with git's renames, the owned
//   instruction files and the exclude entries follow the link check, and a new prefix that clashes on the device asks
//   for a local prefix first (in the pull preview, or in "Needs attention" when another git tool pulled). They are a
//   durable operation (IMPLEMENTATION.md §2.6); the link check's gate catches a change the app didn't see coming.
import { editSkillMd, LIBRARY_FILE, type PrefixWarning, withLibraryPrefix } from '@app/schemas';
import type { ActivityLog } from '../../activity/index.ts';
import { defineCommand, defineQuery, type InstanceEngine } from '../../engine/index.ts';
import { mentionsOf } from '../../imports/index.ts';
import type { LibrarySnapshot } from '../../library/index.ts';
import type { OperationDef, OperationRunner } from '../../operations/index.ts';
import type { Clock } from '../../ports/clock.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { GitIdentity, GitRepo, Oid } from '../../ports/git.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Store } from '../../ports/store.ts';
import type { DevicePrefixes, PrefixCheck } from '../../projection/index.ts';
import type { RoleActions } from '../../review/index.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import type { DomainEvent } from '../../shared/events.ts';
import { hashValue } from '../../shared/hash.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import type { PushResult, SyncPrefixHooks } from '../../sync/index.ts';
import {
  newPrefixProblem,
  type NewPrefixProblem,
  newPrefixWarnings,
  type PrefixAction,
  prefixAction,
  type PrefixRefusal,
  type PrefixRename,
  type RenameProblem,
  renamePlan,
} from '../domain/prefix-change.ts';

type NoInput = Record<string, never>;

/**
 * The durable operation of a prefix change (IMPLEMENTATION.md §2.6): on the Admin's device the renames and their
 * commit, then on every device the adjustments. A crash between the folders' move and the commit is finished at the
 * next start, so the renames never stay as uncommitted changes.
 */
export const PREFIX_CHANGE_OPERATION = 'prefix-change';
export const prefixChangeSteps = ['move', 'commit', 'record', 'relink', 'instructions'] as const;

/** Text files larger than this aren't searched for mentions. */
const MENTION_FILE_MAX = 256 * 1024;

/** Why the library isn't ready for a prefix change: each one has its own way out. */
export type PrefixBlocker =
  /** Uncommitted changes: commit or discard them first. */
  | 'changes'
  /** Another branch is checked out: switch to the company branch. */
  | 'branch'
  /** The company branch has new commits: pull first. */
  | 'incoming'
  /** Commits not pushed yet: push them first, so the change commit goes alone. */
  | 'toPush'
  /** A merge, rebase or revert is unfinished. */
  | 'operation';

export interface PrefixMention {
  readonly skill: string | null;
  /** The library path, e.g. `skills/acme-onboarding/SKILL.md`. */
  readonly path: string;
  readonly line: number;
  readonly name: string;
  readonly text: string;
}

/** A branch on the server that the company branch doesn't hold: an open change request (ADR 0032). */
export interface PrefixRequest {
  readonly branch: string;
  /** Its newest commit's subject and author. */
  readonly title: string;
  readonly author: string;
}

/** A prefix change that waits for a local prefix: the new prefix clashes on this device (PLAN.md §3.2 step 3). */
export interface PrefixWaiting {
  readonly from: string;
  readonly to: string;
  readonly since: number;
}

export interface PrefixState {
  /** The library's git prefix, from library.yaml. */
  readonly prefix: string | null;
  readonly locked: boolean;
  readonly action: PrefixAction;
  readonly refusal: PrefixRefusal | null;
  readonly skills: number;
  readonly waiting: PrefixWaiting | null;
}

export interface PrefixChangePreview {
  readonly from: string;
  readonly prefix: string;
  readonly action: PrefixAction;
  readonly refusal: PrefixRefusal | null;
  readonly problem: NewPrefixProblem | null;
  readonly warnings: readonly PrefixWarning[];
  readonly renames: readonly PrefixRename[];
  readonly untouched: readonly string[];
  readonly renameProblems: readonly RenameProblem[];
  readonly mentions: readonly PrefixMention[];
  readonly requests: readonly PrefixRequest[];
  readonly blockers: readonly PrefixBlocker[];
  /** The new prefix on this device: a clash asks for a local prefix first. */
  readonly device: PrefixCheck;
  readonly hash: string;
}

export interface PrefixChangeResult {
  readonly commit: Oid;
  readonly push: PushResult;
}

/** What a pull that brings a prefix change shows and asks (the pull preview, PLAN.md §3.2 step 3). */
export interface PullPrefixChange extends PrefixCheck {
  readonly from: string;
  /** The local prefix isn't needed any more after the pull: the app offers to drop it. */
  readonly dropOffered: boolean;
}

export const PrefixQuery = defineQuery<NoInput, PrefixState>('Prefix');
export const PreviewPrefixChange = defineQuery<{ prefix: string; localPrefix: string | null }, PrefixChangePreview>(
  'PreviewPrefixChange',
);
/** The waiting change's question in "Needs attention": the local prefix typed, checked. */
export const PreviewAdoptPrefix = defineQuery<{ localPrefix: string | null }, PrefixCheck & { hash: string }>(
  'PreviewAdoptPrefix',
);
export const ChangePrefix = defineCommand<
  { prefix: string; localPrefix: string | null; planHash: string },
  PrefixChangeResult
>('ChangePrefix');
export const AdoptPrefix = defineCommand<{ localPrefix: string; planHash: string }, PrefixState>('AdoptPrefix');

/** What the prefix module tells the user outside the app (PLAN.md §3.19 "Notifications"). */
export type PrefixNotice =
  | { readonly type: 'waiting'; readonly from: string; readonly to: string }
  | { readonly type: 'changed'; readonly from: string; readonly to: string }
  | { readonly type: 'drop-offered'; readonly to: string; readonly local: string };

export interface PrefixServiceDeps {
  readonly engine: InstanceEngine;
  readonly operations: OperationRunner;
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly activity: ActivityLog;
  readonly repo: GitRepo;
  readonly libraryRoot: () => string;
  readonly snapshot: () => LibrarySnapshot | null;
  readonly device: DevicePrefixes;
  readonly store: Store;
  /** The local prefix on this device, its check of a new git prefix, and the step that records an answer. */
  readonly projection: {
    readonly localPrefix: string | null;
    prefixCheck(gitPrefix: string, typed: string | null, folders: readonly string[]): Promise<PrefixCheck>;
    useLocalPrefix(prefix: string): Promise<void>;
  };
  /** The role's actions (Step 12); null when nothing is gated (a library without a sign-in). */
  readonly actions: () => RoleActions | null;
  readonly companyBranch: () => Promise<string>;
  /** The branches on the server that the company branch doesn't hold, for the warning (PLAN.md §3.2 step 4). */
  readonly openRequests: () => Promise<readonly PrefixRequest[]>;
  /** The git screens' parts a prefix change uses: the author, signing, the app's own HEAD moves, and push. */
  readonly sync: {
    identity(): GitIdentity | null;
    signingKeyNeeded(): boolean;
    own<T>(fn: () => Promise<T>): Promise<T>;
    recordBaseline(): Promise<void>;
    push(emit: (event: DomainEvent) => void): Promise<PushResult>;
    trailers(): Readonly<Record<string, string>>;
    changed(): Promise<void>;
  };
  /** A skill renamed by the change: its placement choices and answers move with it (as the editor's rename does). */
  readonly renamed: (from: string, to: string) => void;
  /** The links (with their exclude entries) and the instruction files, reconciled again inside a command. */
  readonly reconcile: {
    links(emit: (event: DomainEvent) => void): Promise<void>;
    instructions(emit: (event: DomainEvent) => void): Promise<void>;
  };
  readonly notify: (notice: PrefixNotice) => void;
  /** The prefix state changed: the renderer asks again. */
  readonly onChange: () => void;
}

/** The Admin's commit of a change: made by the operation's first steps, before the adjustments. */
type ChangeCommit = {
  /** HEAD before the change: a HEAD that moved since says the commit was made. */
  base: string | null;
  renames: Array<{ from: string; to: string }>;
  message: string;
  author: { name: string; email: string };
  trailers: Record<string, string>;
  correction: boolean;
};
type ChangeParams = { from: string; to: string; localPrefix: string | null; commit: ChangeCommit | null };
type ChangeState = { commit: string | null };

export class PrefixService {
  readonly #deps: PrefixServiceDeps;
  /** The git prefix this device's links follow (device.json): read once, then kept as it's written. */
  #recorded: string | null | undefined;
  #waiting: PrefixWaiting | null = null;
  #announced: string | null = null;
  #locked: { head: string | null; value: boolean } | null = null;

  /**
   * A pull's answer to the local-prefix question, for its change: its merge may stop on conflicts first, and the app
   * may stop before they are resolved. Kept in the instance settings, so the question isn't asked again.
   */
  get #answer(): { to: string; localPrefix: string } | null {
    return this.#deps.store.read((tx) => tx.settings.get()).prefixAnswer;
  }

  set #answer(answer: { to: string; localPrefix: string } | null) {
    if (answer === null && this.#answer === null) return;
    this.#deps.store.write((tx) => tx.settings.set({ ...tx.settings.get(), prefixAnswer: answer }));
  }

  constructor(deps: PrefixServiceDeps) {
    this.#deps = deps;
    const { engine, operations } = deps;
    operations.register(this.#operation());
    engine.handleQuery(PrefixQuery, () => this.state());
    engine.handleQuery(PreviewPrefixChange, ({ prefix, localPrefix }) => this.#preview(prefix, localPrefix));
    engine.handleQuery(PreviewAdoptPrefix, ({ localPrefix }) => this.#previewAdopt(localPrefix));
    engine.handle(ChangePrefix, (input, context) => this.#change(input, (event) => context.emit(event)));
    engine.handle(AdoptPrefix, ({ localPrefix, planHash }, context) =>
      this.#adopt(localPrefix, planHash, (event) => context.emit(event)),
    );
  }

  /** A change that waits for a local prefix (the link check is held, PLAN.md §3.2 step 3), or null. */
  get waiting(): PrefixWaiting | null {
    return this.#waiting;
  }

  /** The prefix the device's files keep while a change waits: owned instruction files stay as they are. */
  get heldPrefix(): string | null {
    return this.#waiting?.from ?? null;
  }

  async state(): Promise<PrefixState> {
    const prefix = this.#deps.snapshot()?.config.prefix ?? null;
    const locked = await this.#isLocked();
    const { action, refusal } = prefixAction(locked, this.#deps.actions());
    return {
      prefix,
      locked,
      action,
      refusal,
      skills: (this.#deps.snapshot()?.skills ?? []).length,
      waiting: this.#waiting,
    };
  }

  /**
   * The lock, taken from the remote (PLAN.md §3.2 "Locking"): a skill was ever pushed to the company branch. The
   * fetched branch says it; a library that never fetched one looks at its own history.
   */
  async #isLocked(): Promise<boolean> {
    const { repo } = this.#deps;
    const company = await this.#deps.companyBranch();
    const remote = await repo.resolve(`refs/remotes/origin/${company}`).catch(() => null);
    const head = remote ?? (await repo.resolve('HEAD').catch(() => null));
    if (head === null) return false;
    if (this.#locked?.head === head) return this.#locked.value;
    const [pushed] = await repo.log({ range: head, paths: ['skills'], max: 1 }).catch(() => []);
    // Once locked, always locked: a later deletion of every skill doesn't unlock it (the history keeps the push).
    const value = pushed !== undefined;
    this.#locked = { head, value };
    return value;
  }

  // ---- The change ------------------------------------------------------------------------------------------------

  async #preview(prefix: string, localPrefix: string | null): Promise<PrefixChangePreview> {
    const { repo, snapshot } = this.#deps;
    const from = snapshot()?.config.prefix ?? null;
    if (from === null) throw new AppError('links.notReady');
    const locked = await this.#isLocked();
    const { action, refusal } = prefixAction(locked, this.#deps.actions());
    const problem = newPrefixProblem(prefix, from);
    const head = await repo.resolve('HEAD').catch(() => null);
    const folders = head === null ? [] : await this.#skillFolders(head);
    const plan = problem ? { renames: [], untouched: [], problems: [] } : renamePlan(folders, from, prefix);
    const blockers = await this.#blockers();
    const after = [...plan.renames.map((r) => r.to), ...plan.untouched];
    // Checked even for a prefix that breaks the rules: the field shows the rules' message first.
    const device = await this.#deps.projection.prefixCheck(prefix, localPrefix, after);
    const mentions = head === null ? [] : await this.#mentions(head, plan.renames);
    const requests = await this.#deps.openRequests().catch((error: unknown) => {
      this.#deps.logger.info('the branches on the server can not be listed', { error: String(error) });
      return [];
    });
    return {
      from,
      prefix,
      action,
      refusal,
      problem,
      warnings: newPrefixWarnings(prefix),
      renames: plan.renames,
      untouched: plan.untouched,
      renameProblems: plan.problems,
      mentions,
      requests,
      blockers,
      device,
      hash: hashValue({
        from,
        prefix,
        head,
        action,
        refusal,
        problem,
        renames: plan.renames,
        renameProblems: plan.problems,
        blockers,
        clash: device.clash,
        local: device.localPrefix,
        answer: device.answer,
      }),
    };
  }

  /** The skill folders of a commit. */
  async #skillFolders(commit: string): Promise<string[]> {
    const entries = await this.#deps.repo.listTree(commit, 'skills');
    return entries.filter((e) => e.kind === 'dir' && /^skills\/[^/]+$/.test(e.path)).map((e) => e.path.slice(7));
  }

  async #blockers(): Promise<PrefixBlocker[]> {
    const { repo } = this.#deps;
    const [status, state] = await Promise.all([repo.status(), repo.state()]);
    const blockers: PrefixBlocker[] = [];
    if (state.operation !== 'none') blockers.push('operation');
    if (status.branch !== (await this.#deps.companyBranch())) blockers.push('branch');
    if (status.entries.length > 0) blockers.push('changes');
    if (status.behind > 0) blockers.push('incoming');
    if (status.ahead > 0) blockers.push('toPush');
    return blockers;
  }

  /** Mentions of the renamed skills' names in the library's texts: never rewritten, listed for the Admin. */
  async #mentions(head: string, renames: readonly PrefixRename[]): Promise<PrefixMention[]> {
    if (renames.length === 0) return [];
    const { repo } = this.#deps;
    const names = renames.map((r) => r.from);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const out: PrefixMention[] = [];
    for (const entry of await repo.listTree(head)) {
      if (entry.kind !== 'file' && entry.kind !== 'executable') continue;
      if (!/^(skills|instructions)\//.test(entry.path) || entry.size > MENTION_FILE_MAX) continue;
      let text: string;
      try {
        text = decoder.decode(await repo.readBlob(entry.oid));
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue;
      const base = entry.path.slice(entry.path.lastIndexOf('/') + 1);
      const skill = /^skills\/([^/]+)\//.exec(entry.path)?.[1] ?? null;
      for (const mention of mentionsOf(base, text, names)) {
        out.push({ skill, path: entry.path, line: mention.line, name: mention.name, text: mention.text });
      }
    }
    return out;
  }

  async #change(
    input: { prefix: string; localPrefix: string | null; planHash: string },
    emit: (event: DomainEvent) => void,
  ): Promise<PrefixChangeResult> {
    const { repo, sync } = this.#deps;
    // What's on the server decides: a skill pushed meanwhile locks the prefix, new commits ask for a pull first.
    await repo.fetch();
    const preview = await this.#preview(input.prefix, input.localPrefix);
    if (preview.refusal) throw new AppError('prefix.notAllowed', { refusal: preview.refusal });
    if (preview.problem?.code === 'same') throw new AppError('prefix.same', { prefix: input.prefix });
    if (preview.problem) throw new AppError('prefix.invalid', { problem: preview.problem.problem });
    const [blocker] = preview.blockers;
    if (blocker) throw new AppError('prefix.notReady', { reason: blocker });
    const [blocked] = preview.renameProblems;
    if (blocked) throw new AppError('prefix.namesBlocked', { skill: blocked.skill, name: blocked.name });
    const localPrefix = this.#localAnswer(preview.device, input.localPrefix);
    const author = sync.identity();
    if (!author) throw new AppError('sync.identityNeeded');
    if (sync.signingKeyNeeded()) throw new AppError('review.signingKeyNeeded');
    if (preview.hash !== input.planHash) throw new AppError('plan.changed', { kind: PREFIX_CHANGE_OPERATION });

    // Every header and library.yaml are read and edited before anything moves: one the edit can't read stops the
    // change. The operation edits them again, the same way, so a resumed move gives the same files.
    await this.#edits(input.prefix, preview.renames);
    const base = await repo.resolve('HEAD').catch(() => null);
    const commit: ChangeCommit = {
      base,
      renames: preview.renames.map((r) => ({ from: r.from, to: r.to })),
      message:
        preview.action === 'correct'
          ? `Correct the prefix to ${input.prefix}`
          : `Change the prefix from ${preview.from} to ${input.prefix}`,
      author: { name: author.name, email: author.email },
      trailers: { ...sync.trailers() },
      correction: preview.action === 'correct',
    };
    const state = await this.#adjust({ from: preview.from, to: input.prefix, localPrefix, commit }, emit);
    const id = state.commit as Oid;
    // The secrets in these files were pushed before, under the old names: only the names changed.
    const push = await sync.push(emit);
    await sync.changed();
    this.#deps.onChange();
    return { commit: id, push };
  }

  /** The local prefix the change needs on this device: an answer when the new prefix clashes here, else none. */
  #localAnswer(check: PrefixCheck, typed: string | null): string | null {
    const needed = check.clash !== null && check.localPrefix === null;
    if (!needed) return null;
    if (typed === null || !check.answer) {
      throw new AppError('prefix.localPrefixNeeded', {
        prefix: check.gitPrefix,
        name: check.clash?.kind === 'instance' ? check.clash.name : '',
      });
    }
    const problem = check.answer.problem;
    if (problem) {
      if (problem.code === 'rules') throw new AppError('localPrefix.invalid', { problem: problem.problem });
      if (problem.code === 'git-prefix') throw new AppError('localPrefix.invalid', { problem: 'git-prefix' });
      throw new AppError('localPrefix.inUse', { prefix: typed, name: problem.code === 'instance' ? problem.name : '' });
    }
    return typed;
  }

  /** Runs the change as a durable operation (IMPLEMENTATION.md §2.6): its commit, if any, then the adjustments. */
  async #adjust(params: ChangeParams, emit: (event: DomainEvent) => void): Promise<ChangeState> {
    this.#emit = emit;
    try {
      const outcome = await this.#deps.operations.start(PREFIX_CHANGE_OPERATION, params);
      if (outcome.status === 'failed') throw new AppError('operation.failed', { kind: PREFIX_CHANGE_OPERATION });
      return outcome.state as ChangeState;
    } finally {
      this.#emit = null;
    }
  }

  /**
   * The edited `SKILL.md` of each renamed skill and the edited library.yaml, read from the folders as they are now.
   * Idempotent: a folder already moved is read under its new name, and an edited file gives the same text again.
   */
  async #edits(
    to: string,
    renames: readonly { from: string; to: string }[],
  ): Promise<{ skills: Array<{ from: string; to: string; text: string }>; yaml: string }> {
    const { fs, paths } = this.#deps;
    const root = this.#deps.libraryRoot();
    const yaml = withLibraryPrefix(await fs.readText(paths.join(root, LIBRARY_FILE) as AbsPath), to);
    if (yaml === null) throw new AppError('prefix.notReady', { reason: 'config' });
    const decoder = new TextDecoder();
    const skills: Array<{ from: string; to: string; text: string }> = [];
    for (const rename of renames) {
      const moved = (await fs.lstat(paths.join(root, 'skills', rename.from) as AbsPath)) === undefined;
      const folder = moved ? rename.to : rename.from;
      const file = paths.join(root, 'skills', folder, 'SKILL.md') as AbsPath;
      const edited = editSkillMd(decoder.decode(await fs.readBytes(file)), { name: rename.to });
      if (!edited.ok) throw new AppError('editor.headerUnreadable', { path: `skills/${folder}/SKILL.md` });
      skills.push({ ...rename, text: edited.text });
    }
    return { skills, yaml };
  }

  /** The operation's `move` step: the folders get their new names, with their `name:` lines and library.yaml. */
  async #move(commit: ChangeCommit, to: string): Promise<void> {
    const { fs, paths, sync } = this.#deps;
    const root = this.#deps.libraryRoot();
    const { skills, yaml } = await this.#edits(to, commit.renames);
    await sync.own(async () => {
      for (const skill of skills) {
        const from = paths.join(root, 'skills', skill.from) as AbsPath;
        const dest = paths.join(root, 'skills', skill.to) as AbsPath;
        if ((await fs.lstat(from)) !== undefined) await fs.rename(from, dest);
        await fs.writeTextAtomic(paths.join(dest, 'SKILL.md') as AbsPath, skill.text);
      }
      await fs.writeTextAtomic(paths.join(root, LIBRARY_FILE) as AbsPath, yaml);
    });
    // The user's choices move with the folders now, as the editor's rename does (A10.8): the commit is the app's own.
    for (const skill of skills) this.#deps.renamed(skill.from, skill.to);
  }

  /** The operation's `commit` step: one commit of the renames; a HEAD that moved since the start has it already. */
  async #commit(params: ChangeParams & { commit: ChangeCommit }): Promise<ChangeState> {
    const { repo, sync, activity, logger } = this.#deps;
    const { commit } = params;
    const head = await repo.resolve('HEAD').catch(() => null);
    const id =
      head !== null && head !== commit.base
        ? head
        : await sync.own(async () => {
            const made = await repo.commit({
              message: commit.message,
              author: commit.author,
              paths: [...commit.renames.flatMap((r) => [`skills/${r.from}`, `skills/${r.to}`]), LIBRARY_FILE],
              trailers: commit.trailers,
            });
            await sync.recordBaseline();
            return made;
          });
    if (id !== head) {
      activity.append([
        {
          kind: 'prefix-changed',
          path: LIBRARY_FILE,
          author: commit.author.name,
          commit: id,
          details: { from: params.from, to: params.to, skills: commit.renames.length, correction: commit.correction },
        },
      ]);
      logger.info('prefix changed', { from: params.from, to: params.to, skills: commit.renames.length });
    }
    return { commit: id };
  }

  /** The events of the command that runs the operation; a resumed operation's go to the engine's stream. */
  #emit: ((event: DomainEvent) => void) | null = null;

  #operation(): OperationDef<ChangeParams, ChangeState> {
    const { device, projection, reconcile, notify } = this.#deps;
    const emit = (event: DomainEvent) => (this.#emit ?? ((e) => this.#deps.engine.events.emit(e)))(event);
    return {
      kind: PREFIX_CHANGE_OPERATION,
      initialState: () => ({ commit: null }),
      // Each step only brings the device to the new prefix: a crash at any point is finished at the next start.
      retryFailed: true,
      steps: [
        // The Admin's device only: the renames, then their commit (a pull or another git tool brings them elsewhere).
        {
          name: 'move',
          run: async ({ params }) => {
            if (params.commit) await this.#move(params.commit, params.to);
          },
        },
        {
          name: 'commit',
          run: async ({ params }) => {
            const { commit } = params;
            return commit ? this.#commit({ ...params, commit }) : undefined;
          },
        },
        // main's device.json first: other instances and setups see the new prefix in use at once. A local prefix
        // chosen for a clash is recorded with it, so the links are made under it.
        {
          name: 'record',
          run: async ({ params }) => {
            await device.setGitPrefix(params.to);
            this.#recorded = params.to;
            if (params.localPrefix !== null && projection.localPrefix !== params.localPrefix) {
              await projection.useLocalPrefix(params.localPrefix);
            }
            this.#waiting = null;
            this.#answer = null;
          },
        },
        // The links follow git's renames (S6) with their choices, under the new names; exclude entries and projected
        // copies with them.
        { name: 'relink', run: () => reconcile.links(emit) },
        // Owned instruction files are named after the effective prefix (PLAN.md §3.12).
        {
          name: 'instructions',
          run: async ({ params }) => {
            await reconcile.instructions(emit);
            await this.#offerDrop(params.to);
            notify({ type: 'changed', from: params.from, to: params.to });
            this.#deps.onChange();
          },
        },
      ],
    };
  }

  /** A local prefix the new git prefix doesn't need: the library page offers to drop it (PLAN.md §3.2 step 3). */
  async #offerDrop(to: string): Promise<void> {
    const local = this.#deps.projection.localPrefix;
    if (local === null) return;
    const check = await this.#deps.projection.prefixCheck(to, null, []);
    if (check.clash === null) this.#deps.notify({ type: 'drop-offered', to, local });
  }

  // ---- On every device: the gate before the links change ---------------------------------------------------------

  /**
   * Before the links change (the link check calls it): a new git prefix that the device hasn't adjusted to, brought by
   * a pull of the app (its operation ran already), another git tool, or a crash before the adjustments. Free on this
   * device, or with a local prefix here: it's recorded, and the check goes on. Clashing: the check waits until the user
   * chooses a local prefix in "Needs attention" (`waiting`).
   */
  async gate(): Promise<'ok' | 'waiting'> {
    const to = this.#deps.snapshot()?.config.prefix ?? null;
    if (to === null) return 'ok';
    if (this.#recorded === undefined) this.#recorded = (await this.#deps.device.context()).gitPrefix ?? null;
    const from = this.#recorded;
    if (from === to) {
      this.#clearWaiting();
      return 'ok';
    }
    if (from === null) {
      // Nothing recorded yet (a device.json from before Step 14, or a test library): the prefix as it is now.
      await this.#deps.device.setGitPrefix(to);
      this.#recorded = to;
      return 'ok';
    }
    const { projection, notify, activity } = this.#deps;
    if (projection.localPrefix === null) {
      const answer = this.#answer?.to === to ? this.#answer.localPrefix : null;
      const check = await projection.prefixCheck(to, answer, []);
      if (check.clash !== null) {
        if (answer !== null && check.answer?.problem === null) {
          await projection.useLocalPrefix(answer);
        } else {
          if (this.#waiting?.to !== to) this.#waiting = { from, to, since: this.#deps.clock.now() };
          if (this.#announced !== to) {
            this.#announced = to;
            notify({ type: 'waiting', from, to });
            this.#deps.onChange();
          }
          return 'waiting';
        }
      }
    }
    await this.#deps.device.setGitPrefix(to);
    this.#recorded = to;
    this.#answer = null;
    this.#clearWaiting();
    activity.append([{ kind: 'prefix-changed', path: LIBRARY_FILE, details: { from, to, device: true } }]);
    notify({ type: 'changed', from, to });
    await this.#offerDrop(to);
    return 'ok';
  }

  #clearWaiting(): void {
    if (this.#waiting === null) return;
    this.#waiting = null;
    this.#deps.onChange();
  }

  /** The waiting change's question: the local prefix typed, checked against the new git prefix. */
  async #previewAdopt(localPrefix: string | null): Promise<PrefixCheck & { hash: string }> {
    const waiting = this.#waiting;
    if (!waiting) throw new AppError('prefix.nothingToAdopt');
    const folders = (this.#deps.snapshot()?.skills ?? []).map((skill) => skill.folder);
    const check = await this.#deps.projection.prefixCheck(waiting.to, localPrefix, folders);
    return { ...check, hash: hashValue({ waiting, clash: check.clash, answer: check.answer }) };
  }

  /** [Use this local prefix] in "Needs attention": the adjustments run with it. */
  async #adopt(localPrefix: string, planHash: string, emit: (event: DomainEvent) => void): Promise<PrefixState> {
    const waiting = this.#waiting;
    if (!waiting) throw new AppError('prefix.nothingToAdopt');
    const check = await this.#previewAdopt(localPrefix);
    const answer = this.#localAnswer(check, localPrefix);
    if (check.hash !== planHash) throw new AppError('plan.changed', { kind: PREFIX_CHANGE_OPERATION });
    await this.#adjust({ from: waiting.from, to: waiting.to, localPrefix: answer, commit: null }, emit);
    return this.state();
  }

  // ---- The pull preview's part (sync's hooks) ----------------------------------------------------------------------

  /**
   * A pull that brings another prefix (PLAN.md §3.2 step 3): what this device makes of it. `answer` is the local
   * prefix typed in the preview; null when the pull changes nothing about the prefix.
   */
  async pullPreview(library: LibrarySnapshot, answer: string | null): Promise<PullPrefixChange | null> {
    const from = this.#deps.snapshot()?.config.prefix ?? null;
    const to = library.config.prefix;
    if (from === null || to === null || from === to) return null;
    const folders = library.skills.map((skill) => skill.folder);
    const check = await this.#deps.projection.prefixCheck(to, answer, folders);
    return { ...check, from, dropOffered: check.localPrefix !== null && check.clash === null };
  }

  /** The local prefix the pull needs: the preview's answer when the new prefix clashes here, checked. */
  pullAnswer(change: PullPrefixChange, typed: string | null): string | null {
    const answer = this.#localAnswer(change, typed);
    // The merge may stop on conflicts: the answer waits for the change it was given for.
    if (answer !== null) this.#answer = { to: change.gitPrefix, localPrefix: answer };
    return answer;
  }

  /** After the pull's merge: the adjustments, instead of a plain link check. */
  async afterPull(change: PullPrefixChange, answer: string | null, emit: (event: DomainEvent) => void): Promise<void> {
    await this.#adjust({ from: change.from, to: change.gitPrefix, localPrefix: answer, commit: null }, emit);
    this.#deps.activity.append([
      {
        kind: 'prefix-changed',
        path: LIBRARY_FILE,
        details: { from: change.from, to: change.gitPrefix, pulled: true },
      },
    ]);
  }

  /** What the pull asks of the prefix module (sync's hooks). */
  hooks(): SyncPrefixHooks {
    return {
      preview: (library, answer) => this.pullPreview(library, answer),
      answer: (change, typed) => this.pullAnswer(change as PullPrefixChange, typed),
      afterPull: (change, answer, emit) => this.afterPull(change as PullPrefixChange, answer, emit),
    };
  }
}
