// The local prefix and projected copies of one instance (IMPLEMENTATION.md Step 8, PLAN.md §3.3). When this library's
// git prefix is in use on the device already, its skills get a local prefix here: each has a projected copy in the data
// folder whose `name:` line and folder name use it, and the tool links point at the copies. The library always keeps
// the git names, so git never sees a local name.
// - The copies follow the library, and edits made through the links go back into it, at every link check: the check
//   runs on the library's and the copies' watcher events, so "right away" (§3.3).
// - Nothing moves while a git operation runs or is unfinished: the link check is paused then, and catches up after.
// - When both sides changed, the copy waits in "Needs attention" until the user chooses which side to keep.
// - Enabling, changing and dropping the local prefix is a durable operation (IMPLEMENTATION.md §2.6): its steps write
//   pending edits back, record the new prefix, and reconcile the copies, links, exclude entries and instruction files
//   to it. Each step is idempotent, so a crash at any point is finished at the next start.
import { PROJECTED_COPY_KIND, PROJECTION_FOLDER, type ProjectedCopyRow, SKILL_LINK_KIND } from '@app/schemas';
import type { ActivityLog, InstanceTrash } from '../../activity/index.ts';
import { defineCommand, defineQuery, type InstanceEngine, type ReconcileRunner } from '../../engine/index.ts';
import type { LibrarySnapshot } from '../../library/index.ts';
import { type AttentionItem, type LinkNaming, type LinkProjection, mirrorFolder } from '../../links/index.ts';
import type { OperationDef, OperationRunner } from '../../operations/index.ts';
import type { Clock } from '../../ports/clock.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { GitRepo } from '../../ports/git.ts';
import type { Links } from '../../ports/links.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Store } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import { hashValue } from '../../shared/hash.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import {
  clashOf,
  type LocalPrefixContext,
  localPrefixCandidates,
  type LocalPrefixProblem,
  localPrefixProblem,
  projectedName,
  shorterSuggestion,
  suggestLocalPrefix,
  tooLongUnder,
} from '../domain/local-prefix.ts';
import type { CopyDecision, ProjectionDesired } from '../domain/projection.ts';
import { projectionReconciler, readCopyRow, renamedSkillMd } from './projection-reconciler.ts';
import { prefixesUsedByFolders } from './user-folders.ts';

/** The durable operation that enables, changes or drops the local prefix (IMPLEMENTATION.md §2.6). */
export const LOCAL_PREFIX_OPERATION = 'local-prefix';
export const localPrefixSteps = ['write-back', 'record', 'relink', 'instructions'] as const;

export const ChangeLocalPrefix = defineCommand<{ prefix: string | null; planHash: string }, LocalPrefixState>(
  'ChangeLocalPrefix',
);
/** Unfinished operations, resumed once the library is read (IMPLEMENTATION.md §2.6). */
export const ResumeOperations = defineCommand<Record<string, never>, number>('ResumeOperations');
export const ResolveCopy = defineCommand<{ key: string; keep: CopyDecision; planHash: string }, LocalPrefixState>(
  'ResolveCopy',
);
export const LocalPrefixQuery = defineQuery<Record<string, never>, LocalPrefixState>('LocalPrefix');
export const PreviewLocalPrefix = defineQuery<{ prefix: string | null }, LocalPrefixPreview>('PreviewLocalPrefix');
export const CopyDifferences = defineQuery<{ key: string; keep: CopyDecision }, CopyConflictView>('CopyDifferences');

export type SkipReason = 'too-long' | 'wrong-prefix';

export interface LocalPrefixState {
  readonly gitPrefix: string | null;
  readonly localPrefix: string | null;
  /** Why the git prefix can't be used here: another instance, or the user's own folders. Null when it's free. */
  readonly clash: { readonly kind: 'instance'; readonly name: string } | { readonly kind: 'folders' } | null;
  /** Skills this device doesn't link under the local prefix (PLAN.md §3.2, §3.3). */
  readonly skipped: ReadonlyArray<{
    readonly skill: string;
    readonly reason: SkipReason;
    readonly name: string | null;
  }>;
  /** Copies waiting for the user: both sides changed. */
  readonly conflicts: number;
  readonly copies: number;
}

export interface LocalPrefixPreview {
  readonly prefix: string | null;
  readonly problem: LocalPrefixProblem | null;
  /** Skills that would go over 64 characters under it, and a shorter prefix that fits. */
  readonly tooLong: readonly string[];
  readonly shorter: string | null;
  /** A free prefix from the library's URL (PLAN.md §3.3). */
  readonly suggestion: string | null;
  readonly hash: string;
}

export interface FileComparison {
  readonly path: string;
  readonly change: 'added' | 'removed' | 'changed';
  /** The text on each side, for small text files; null when the side has none or it isn't text. */
  readonly library: string | null;
  readonly copy: string | null;
}

export interface CopyConflictView {
  readonly key: string;
  readonly skill: string;
  readonly name: string;
  readonly files: readonly FileComparison[];
  readonly hash: string;
}

/** What the worker shows as a notification, translated there. */
export type ProjectionNotice =
  | { readonly type: 'skipped'; readonly skill: string; readonly reason: SkipReason }
  | { readonly type: 'both-changed'; readonly skill: string };

/**
 * Main's record of the device (device.json): this instance's git prefix (the one its links were last adjusted to,
 * PLAN.md §3.2) and local prefix, and the other instances' prefixes.
 */
export interface DevicePrefixes {
  context(): Promise<{
    readonly gitPrefix?: string | null | undefined;
    readonly localPrefix: string | null;
    readonly instances: ReadonlyArray<{ readonly prefix: string; readonly name: string }>;
  }>;
  setLocalPrefix(prefix: string | null): Promise<void>;
  /** After a prefix change (Step 14): other instances and setups see the new prefix in use at once. */
  setGitPrefix(prefix: string): Promise<void>;
}

/** A new git prefix as this device sees it (PLAN.md §3.2 step 3): whether it clashes, and the local prefix answer. */
export interface PrefixCheck {
  readonly gitPrefix: string;
  /** Why the new git prefix can't be used here: another instance, or the user's own folders. Null when it's free. */
  readonly clash: LocalPrefixState['clash'];
  /** The local prefix this instance keeps (it has one), or null. */
  readonly localPrefix: string | null;
  /** A free local prefix for the new git prefix, from the library's URL. */
  readonly suggestion: string | null;
  /** The local prefix the user typed, checked against the new git prefix; null when none was typed. */
  readonly answer: {
    readonly prefix: string;
    readonly problem: LocalPrefixProblem | null;
    readonly tooLong: readonly string[];
    readonly shorter: string | null;
  } | null;
}

export interface ProjectionServiceDeps {
  readonly engine: InstanceEngine;
  readonly runner: ReconcileRunner;
  readonly operations: OperationRunner;
  readonly store: Store;
  readonly fs: FileSystem;
  readonly links: Links;
  readonly trash: InstanceTrash;
  readonly activity: ActivityLog;
  readonly paths: PathFlavour;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly dataFolder: string;
  readonly libraryRoot: () => string;
  readonly snapshot: () => LibrarySnapshot | null;
  readonly repo: Pick<GitRepo, 'state' | 'ignored'>;
  readonly gitUrl: () => { readonly host: string; readonly path: string } | null;
  /** Every tool's skills folders on this device, enabled or not: only the names of their folders are looked at. */
  readonly skillFolders: () => readonly string[];
  readonly device: DevicePrefixes;
  /** The links (with their exclude entries) and the instruction files, reconciled again inside a command. */
  readonly reconcile: { links(): Promise<void>; instructions(): Promise<void> };
  readonly notify: (notice: ProjectionNotice) => void;
}

const MAX_TEXT = 256 * 1024;

export class ProjectionService implements LinkProjection {
  readonly #deps: ProjectionServiceDeps;
  readonly root: string;
  #localPrefix: string | null = null;
  #loaded = false;
  /** Skills not linked under the local prefix, with when that was first seen. */
  #skipped = new Map<string, { reason: SkipReason; name: string | null; since: number }>();
  #notified = new Set<string>();

  constructor(deps: ProjectionServiceDeps) {
    this.#deps = deps;
    this.root = deps.paths.join(deps.dataFolder, PROJECTION_FOLDER);
    const { engine, operations } = deps;
    operations.register(this.#operation());
    engine.handle(ChangeLocalPrefix, ({ prefix, planHash }) => this.#change(prefix, planHash));
    engine.handle(ResumeOperations, async () => (await operations.resumeAll()).length);
    engine.handle(ResolveCopy, ({ key, keep, planHash }) => this.#resolve(key, keep, planHash));
    engine.handleQuery(LocalPrefixQuery, () => this.state());
    engine.handleQuery(PreviewLocalPrefix, ({ prefix }) => this.#preview(prefix));
    engine.handleQuery(CopyDifferences, ({ key, keep }) => this.#differences(key, keep));
  }

  get localPrefix(): string | null {
    return this.#localPrefix;
  }

  /** Reads this instance's local prefix from main's record, and keeps a copy in the instance's settings. */
  async load(): Promise<void> {
    const { localPrefix } = await this.#deps.device.context();
    this.#set(localPrefix);
    this.#loaded = true;
  }

  #set(prefix: string | null): void {
    this.#localPrefix = prefix;
    const { store } = this.#deps;
    if (store.read((tx) => tx.settings.get()).localPrefix !== prefix) {
      store.write((tx) => tx.settings.set({ ...tx.settings.get(), localPrefix: prefix }));
    }
  }

  /** What the guarded file system lets it reach: the tools' skills folders, for their names (PLAN.md §3.3). */
  roots(): { exact: string[]; lists: string[] } {
    const folders = [...this.#deps.skillFolders()];
    if (this.#roots?.source !== folders.join('\u0000')) {
      this.#roots = { source: folders.join('\u0000'), exact: folders, lists: folders };
    }
    return { exact: this.#roots.exact, lists: this.#roots.lists };
  }

  #roots: { source: string; exact: string[]; lists: string[] } | undefined;

  // ---- The link engine's view (LinkProjection) -----------------------------------------------------------------

  naming(view?: { readonly gitPrefix: string | null; readonly localPrefix: string | null }): LinkNaming | null {
    const local = view ? view.localPrefix : this.#localPrefix;
    const gitPrefix = view ? view.gitPrefix : (this.#deps.snapshot()?.config.prefix ?? null);
    // A preview (a pull's dry run, Step 14) names the skills of another library, or under another local prefix: it
    // changes none of the skipped skills, and notifies nothing.
    if (view) return local === null || gitPrefix === null ? null : this.#previewNaming(gitPrefix, local);
    if (local === null || gitPrefix === null) {
      this.#skipped.clear();
      return null;
    }
    const now = this.#deps.clock.now();
    const seen = new Set<string>();
    const skip = (folder: string, reason: SkipReason, projected: string | null): null => {
      if (this.#skipped.get(folder)?.reason !== reason)
        this.#skipped.set(folder, { reason, name: projected, since: now });
      return null;
    };
    const name = (folder: string): string | null => {
      seen.add(folder);
      const projected = projectedName(folder, gitPrefix, local);
      if (projected === undefined) return skip(folder, 'wrong-prefix', null);
      if (tooLongUnder([folder], gitPrefix, local).length > 0) return skip(folder, 'too-long', projected);
      this.#skipped.delete(folder);
      return projected;
    };
    return {
      root: this.root,
      name,
      target: (linkName) => this.#deps.paths.join(this.root, linkName),
      done: () => {
        for (const folder of [...this.#skipped.keys()]) if (!seen.has(folder)) this.#skipped.delete(folder);
        for (const [folder, skip] of this.#skipped) {
          const id = `${folder}:${skip.reason}`;
          if (this.#notified.has(id)) continue;
          this.#notified.add(id);
          this.#deps.notify({ type: 'skipped', skill: folder, reason: skip.reason });
        }
      },
    };
  }

  #previewNaming(gitPrefix: string, local: string): LinkNaming {
    return {
      root: this.root,
      name: (folder) => {
        const projected = projectedName(folder, gitPrefix, local);
        return projected === undefined || tooLongUnder([folder], gitPrefix, local).length > 0 ? null : projected;
      },
      target: (linkName) => this.#deps.paths.join(this.root, linkName),
      done: () => {},
    };
  }

  /** Before the links change: copies made and refreshed, edits written back. Nothing is removed yet. */
  async before(skills: readonly string[]): Promise<number> {
    return this.#sync(skills, false);
  }

  /** After the links changed: copies nobody links to any more go. */
  async after(skills: readonly string[]): Promise<number> {
    return this.#sync(skills, true);
  }

  async #sync(skills: readonly string[], removals: boolean): Promise<number> {
    const { runner } = this.#deps;
    const before = this.#rows();
    if (this.#localPrefix === null && before.length === 0) return 0;
    const waiting = new Set(before.filter(([, row]) => row.status === 'both-changed').map(([key]) => key));
    const written: string[] = [];
    const report = await runner.apply(
      this.#reconciler({ removals }, (skill) => written.push(skill)),
      {
        copies: this.#desired(skills),
      },
    );
    // An edit made through a link reached the library (PLAN.md §3.3): it shows up as a change on this device.
    if (written.length > 0) {
      this.#deps.activity.append(
        written.map((skill) => ({ kind: 'written-back' as const, path: `skills/${skill}`, details: { skill } })),
      );
    }
    for (const [key, row] of this.#rows()) {
      if (row.status === 'both-changed' && !waiting.has(key))
        this.#deps.notify({ type: 'both-changed', skill: row.skill });
    }
    return report.applied;
  }

  #desired(skills: readonly string[]): ProjectionDesired[] {
    const local = this.#localPrefix;
    const gitPrefix = this.#deps.snapshot()?.config.prefix ?? null;
    if (local === null || gitPrefix === null) return [];
    const present = new Map((this.#deps.snapshot()?.skills ?? []).map((skill) => [skill.folder, skill.files]));
    const out: ProjectionDesired[] = [];
    for (const skill of skills) {
      const name = projectedName(skill, gitPrefix, local);
      if (name === undefined || tooLongUnder([skill], gitPrefix, local).length > 0) continue;
      out.push({
        key: this.#deps.paths.join(this.root, name),
        skill,
        name,
        libraryEmpty: (present.get(skill) ?? 0) === 0,
      });
    }
    return out;
  }

  #reconciler(
    scope: { removals: boolean; decisions?: Record<string, CopyDecision>; only?: string[] },
    onWriteBack?: (skill: string) => void,
  ) {
    const d = this.#deps;
    return projectionReconciler(
      {
        fs: d.fs,
        links: d.links,
        trash: d.trash,
        paths: d.paths,
        logger: d.logger,
        clock: d.clock,
        libraryRoot: d.libraryRoot,
        ignored: async (paths) => new Set(await d.repo.ignored(paths)),
        ...(onWriteBack ? { onWriteBack } : {}),
      },
      scope,
    );
  }

  /** "Needs attention": copies waiting for a choice, and skills this device skips (PLAN.md §3.3). */
  attention(): AttentionItem[] {
    const items: Array<[string, AttentionItem]> = [];
    const base = {
      dest: null,
      folder: null,
      tools: [],
      takenBy: null,
      repoId: null,
      repo: null,
      tag: null,
      repos: [],
    } as const;
    for (const [key, row] of this.#rows()) {
      if (row.status !== 'both-changed') continue;
      const item: AttentionItem = {
        ...base,
        id: key,
        kind: 'copy-conflict',
        skill: row.skill,
        reason: row.name,
        since: row.since,
      };
      items.push([`${row.skill}\u0000${key}`, item]);
    }
    for (const [skill, skip] of this.#skipped) {
      items.push([
        `${skill}\u0000${skip.reason}`,
        {
          ...base,
          id: `${skip.reason}:${skill}`,
          kind: skip.reason === 'too-long' ? 'name-too-long' : 'wrong-prefix',
          skill,
          reason: skip.name,
          since: skip.since,
        },
      ]);
    }
    // By skill: the sort keys are unique.
    return items.sort(([a], [b]) => (a < b ? -1 : 1)).map(([, item]) => item);
  }

  // ---- The local prefix ----------------------------------------------------------------------------------------

  async state(): Promise<LocalPrefixState> {
    const gitPrefix = this.#deps.snapshot()?.config.prefix ?? null;
    const rows = this.#rows();
    const context = gitPrefix === null ? null : await this.#context(gitPrefix, [gitPrefix]);
    return {
      gitPrefix,
      localPrefix: this.#localPrefix,
      clash: context ? clashOf(context) : null,
      skipped: [...this.#skipped].map(([skill, skip]) => ({ skill, reason: skip.reason, name: skip.name })),
      conflicts: rows.filter(([, row]) => row.status === 'both-changed').length,
      copies: rows.length,
    };
  }

  /**
   * A new git prefix on this device (PLAN.md §3.2 step 3): checked against the other instances and the user's own
   * folders, as at setup (§3.3 "Detection"). `folders` are the library's skill folders under the new prefix, for the
   * names a typed local prefix would push past 64 characters.
   */
  async prefixCheck(gitPrefix: string, typed: string | null, folders: readonly string[]): Promise<PrefixCheck> {
    const url = this.#deps.gitUrl() ?? { host: '', path: '' };
    const candidates = localPrefixCandidates(gitPrefix, url);
    const local = this.#localPrefix;
    const asked = [gitPrefix, ...(typed === null ? [] : [typed]), ...(local === null ? [] : [local]), ...candidates];
    const context = await this.#context(gitPrefix, asked);
    let answer: PrefixCheck['answer'] = null;
    if (typed !== null) {
      const problem = localPrefixProblem(typed, context);
      const tooLong = problem?.code === 'rules' ? [] : tooLongUnder(folders, gitPrefix, typed);
      let shorter: string | null = null;
      if (tooLong.length > 0) {
        const shorterContext = await this.#context(gitPrefix, [gitPrefix, ...shorterCandidates(typed, candidates)]);
        shorter = shorterSuggestion(typed, folders, shorterContext, url);
      }
      answer = { prefix: typed, problem, tooLong, shorter };
    }
    return {
      gitPrefix,
      clash: clashOf(context),
      localPrefix: local,
      suggestion: suggestLocalPrefix(candidates, context),
      answer,
    };
  }

  /**
   * Records a local prefix chosen for a new git prefix (PLAN.md §3.2 step 3): a step of the prefix change's durable
   * operation, so it's idempotent. The link check that follows makes the copies and the links under it.
   */
  async useLocalPrefix(prefix: string): Promise<void> {
    await this.#deps.device.setLocalPrefix(prefix);
    this.#set(prefix);
  }

  /** What a new local prefix (or none: the git prefix again) would mean, and whether it may be used. */
  async #preview(prefix: string | null): Promise<LocalPrefixPreview> {
    const gitPrefix = this.#gitPrefix();
    const url = this.#deps.gitUrl() ?? { host: '', path: '' };
    const candidates = localPrefixCandidates(gitPrefix, url);
    const typed = prefix === null ? [] : [prefix];
    const context = await this.#context(gitPrefix, [gitPrefix, ...typed, ...candidates]);
    const folders = (this.#deps.snapshot()?.skills ?? []).map((skill) => skill.folder);
    let problem: LocalPrefixProblem | null = null;
    let tooLong: string[] = [];
    let shorter: string | null = null;
    if (prefix === null) {
      const clash = clashOf(context);
      if (clash) problem = clash.kind === 'instance' ? { code: 'instance', name: clash.name } : { code: 'folders' };
    } else {
      problem = localPrefixProblem(prefix, context);
      if (problem === null || problem.code !== 'rules') {
        tooLong = tooLongUnder(folders, gitPrefix, prefix);
        if (tooLong.length > 0) {
          const shorterContext = await this.#context(gitPrefix, [gitPrefix, ...shorterCandidates(prefix, candidates)]);
          shorter = shorterSuggestion(prefix, folders, shorterContext, url);
        }
      }
    }
    const suggestion = suggestLocalPrefix(candidates, context);
    return {
      prefix,
      problem,
      tooLong,
      shorter,
      suggestion,
      hash: hashValue({ from: this.#localPrefix, to: prefix, problem, tooLong }),
    };
  }

  /** The other instances' prefixes from main, and which candidates the user's own folders use. */
  async #context(gitPrefix: string, candidates: readonly string[]): Promise<LocalPrefixContext> {
    const { instances } = await this.#deps.device.context();
    const used = await prefixesUsedByFolders(this.#deps.fs, this.#deps.paths, this.#deps.skillFolders(), candidates, {
      ours: (dir, name) => this.#isOurs(dir, name),
    });
    return { gitPrefix, instances, folderUses: (prefix) => used.has(prefix) };
  }

  /** Whether a name in a tool's skills folder is one of this instance's own links. */
  #isOurs(dir: string, name: string): boolean {
    const dest = this.#deps.paths.join(dir, name);
    return this.#deps.store.read((tx) => tx.registry.get(SKILL_LINK_KIND, dest)) !== undefined;
  }

  #gitPrefix(): string {
    const prefix = this.#deps.snapshot()?.config.prefix ?? null;
    if (prefix === null) throw new AppError('links.notReady');
    return prefix;
  }

  async #change(prefix: string | null, planHash: string): Promise<LocalPrefixState> {
    if (prefix === this.#localPrefix) throw new AppError('localPrefix.same', { prefix: prefix ?? '' });
    const preview = await this.#preview(prefix);
    if (preview.problem) {
      const p = preview.problem;
      if (p.code === 'rules') throw new AppError('localPrefix.invalid', { problem: p.problem });
      if (p.code === 'git-prefix') throw new AppError('localPrefix.invalid', { problem: 'git-prefix' });
      if (prefix === null) throw new AppError('localPrefix.stillInUse', { name: p.code === 'instance' ? p.name : '' });
      throw new AppError('localPrefix.inUse', { prefix: prefix, name: p.code === 'instance' ? p.name : '' });
    }
    if (preview.hash !== planHash) throw new AppError('plan.changed', { kind: LOCAL_PREFIX_OPERATION });
    const state = await this.#deps.repo.state().catch(() => ({ operation: 'none' as const, busy: false }));
    if (state.operation !== 'none' || state.busy) throw new AppError('localPrefix.paused');
    if (this.#rows().some(([, row]) => row.status === 'both-changed')) throw new AppError('localPrefix.unresolved');
    const outcome = await this.#deps.operations.start(LOCAL_PREFIX_OPERATION, { from: this.#localPrefix, to: prefix });
    if (outcome.status === 'failed') throw new AppError('operation.failed', { kind: LOCAL_PREFIX_OPERATION });
    return this.state();
  }

  #operation(): OperationDef<{ from: string | null; to: string | null }, Record<string, never>> {
    const { reconcile, device, activity } = this.#deps;
    return {
      kind: LOCAL_PREFIX_OPERATION,
      initialState: () => ({}),
      steps: [
        // Edits made through the old links reach the library first: nothing waits in a copy that goes.
        { name: 'write-back', run: () => reconcile.links() },
        // main's device.json first: other instances and setups see the new prefix in use at once.
        {
          name: 'record',
          run: async ({ params }) => {
            await device.setLocalPrefix(params.to);
            this.#set(params.to);
          },
        },
        // New copies, then the links (and their exclude entries) under the new names, then the old copies go.
        { name: 'relink', run: () => reconcile.links() },
        // Owned instruction files are named after the effective prefix (PLAN.md §3.12).
        {
          name: 'instructions',
          run: async ({ params }) => {
            await reconcile.instructions();
            activity.append([
              { kind: 'local-prefix-changed', path: null, details: { from: params.from, to: params.to } },
            ]);
          },
        },
      ],
    };
  }

  // ---- Both sides changed ----------------------------------------------------------------------------------------

  async #differences(key: string, keep: CopyDecision): Promise<CopyConflictView> {
    const row = this.#row(key);
    if (!row || row.status !== 'both-changed') throw new AppError('projection.noConflict', { path: key });
    const library = await this.#readTexts(this.#libraryFolder(row.skill), null);
    const copy = await this.#readTexts(key, row.skill);
    const all = [...new Set([...library.keys(), ...copy.keys()])].sort();
    const item = (path: string) => `skills/${row.skill}/${path}`;
    const ignored = new Set(await this.#deps.repo.ignored(all.map(item)));
    const files: FileComparison[] = [];
    for (const path of all) {
      if (ignored.has(item(path))) continue;
      const a = library.get(path);
      const b = copy.get(path);
      if (a !== undefined && b !== undefined && a.key === b.key) continue;
      files.push({
        path,
        change: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed',
        library: a?.text ?? null,
        copy: b?.text ?? null,
      });
    }
    const reconciler = this.#reconciler({ removals: false, decisions: { [key]: keep }, only: [key] });
    const plan = await this.#deps.runner.plan(reconciler, { copies: this.#desired([row.skill]) });
    return { key, skill: row.skill, name: row.name, files, hash: plan.hash };
  }

  #libraryFolder(skill: string): string {
    return this.#deps.paths.join(this.#deps.libraryRoot(), 'skills', skill);
  }

  /**
   * A folder's files for the both-changed dialog: text when it's small UTF-8, a link as its target. `gitName` puts the
   * copy's SKILL.md under the git name, as the library would get it.
   */
  async #readTexts(root: string, gitName: string | null): Promise<Map<string, { text: string | null; key: string }>> {
    const { fs, paths } = this.#deps;
    const out = new Map<string, { text: string | null; key: string }>();
    if ((await fs.lstat(root as AbsPath))?.kind !== 'dir') return out;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const visit = async (relative: string): Promise<void> => {
      const dir = (relative === '' ? root : paths.join(root, ...relative.split('/'))) as AbsPath;
      for (const name of await fs.list(dir)) {
        const child = relative === '' ? name : `${relative}/${name}`;
        const at = paths.join(root, ...child.split('/')) as AbsPath;
        const entry = await fs.lstat(at);
        if (entry?.kind === 'dir') await visit(child);
        else if (entry?.kind === 'link') {
          const target = await fs.readLink(at);
          out.set(child, { text: `→ ${target}`, key: `link:${target}` });
        } else if (entry?.kind === 'file') {
          let bytes = await fs.readBytes(at);
          if (child === 'SKILL.md' && gitName !== null) bytes = renamedSkillMd(bytes, gitName) ?? bytes;
          let text: string | null;
          try {
            text = bytes.length <= MAX_TEXT ? decoder.decode(bytes) : null;
          } catch {
            text = null;
          }
          out.set(child, { text, key: text ?? `bytes:${hashValue([...bytes])}` });
        }
      }
    };
    await visit('');
    return out;
  }

  async #resolve(key: string, keep: CopyDecision, planHash: string): Promise<LocalPrefixState> {
    const row = this.#row(key);
    if (!row || row.status !== 'both-changed') throw new AppError('projection.noConflict', { path: key });
    const written: string[] = [];
    const reconciler = this.#reconciler({ removals: false, decisions: { [key]: keep }, only: [key] }, (skill) =>
      written.push(skill),
    );
    const inputs = { copies: this.#desired([row.skill]) };
    const plan = await this.#deps.runner.plan(reconciler, inputs);
    if (plan.hash !== planHash) throw new AppError('plan.changed', { kind: PROJECTED_COPY_KIND });
    // The side the user doesn't keep goes to the trash first, as a copy, so nothing is lost (PLAN.md §3.8 "Trash").
    const { paths, trash, fs, clock } = this.#deps;
    const lost = keep === 'library' ? key : this.#libraryFolder(row.skill);
    if ((await fs.lstat(lost as AbsPath))?.kind === 'dir') {
      const aside = paths.join(this.#deps.dataFolder, 'tmp', `${row.name}-${clock.now()}`) as AbsPath;
      await mirrorFolder({ fs, links: this.#deps.links, paths }, lost as AbsPath, aside);
      await trash.put(aside, 'projected-copy', row.skill, { restoreTo: lost as AbsPath });
    }
    await this.#deps.runner.apply(reconciler, inputs, { expectedHash: planHash });
    this.#deps.activity.append([
      { kind: 'copy-kept', path: `skills/${row.skill}`, details: { skill: row.skill, kept: keep } },
    ]);
    await this.#deps.reconcile.links();
    return this.state();
  }

  #rows(): Array<[string, ProjectedCopyRow]> {
    return this.#deps.store
      .read((tx) => tx.registry.list(PROJECTED_COPY_KIND))
      .flatMap((record) => {
        const row = readCopyRow(record);
        return row ? [[record.key, row] as [string, ProjectedCopyRow]] : [];
      });
  }

  #row(key: string): ProjectedCopyRow | null {
    return readCopyRow(this.#deps.store.read((tx) => tx.registry.get(PROJECTED_COPY_KIND, key)));
  }

  /** Whether the service read its prefix: before that nothing is linked (the worker loads it at start). */
  get ready(): boolean {
    return this.#loaded;
  }
}

/** The candidates cut short, for a shorter suggestion. */
function shorterCandidates(prefix: string, candidates: readonly string[]): string[] {
  const out: string[] = [];
  for (let length = prefix.length - 1; length >= 3; length--) out.push(prefix.slice(0, length));
  return [...out, ...candidates];
}
