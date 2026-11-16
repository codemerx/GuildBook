// Version history per skill and for the instructions (PLAN.md §3.14, A10.9): past versions with author, date and
// message from git, the text of a past version for the diff against the current one, and [Restore this version].
// Restoring writes the past version into the working tree, so the skill becomes "Modified on this device", to be
// committed and pushed as usual. Nothing is committed here.
import { defineCommand, defineQuery, type InstanceEngine } from '../../engine/index.ts';
import type { GitRepo } from '../../ports/git.ts';
import { AppError } from '../../shared/errors.ts';

export interface VersionEntry {
  readonly commit: string;
  readonly author: string;
  readonly email: string;
  /** Epoch milliseconds. */
  readonly date: number;
  readonly subject: string;
}

/** What history is kept of: a skill's folder or the instructions file, relative to the library. */
export type HistoryPath = string;

const HISTORY_MAX = 200;

export const HistoryQuery = defineQuery<{ readonly path: HistoryPath }, VersionEntry[]>('History');
export const VersionTextQuery = defineQuery<
  { readonly commit: string; readonly path: string },
  { readonly text: string | null }
>('VersionText');
export const RestoreVersion = defineCommand<{ readonly path: HistoryPath; readonly commit: string }, void>(
  'RestoreVersion',
);

export interface FileHistoryDeps {
  readonly engine: InstanceEngine;
  readonly repo: () => GitRepo;
  /** Whether a path is one history may be asked of: a skill's folder or the instructions file. */
  readonly allowed: (path: string) => boolean;
  /** Removes a file of the library's working tree (relative to the library), if it's there. */
  readonly removeFile: (path: string) => Promise<void>;
  /** The restored files changed in the working tree: the editor and the links follow (the watcher does too). */
  readonly restored: (path: HistoryPath) => void;
  /** The activity log's entry (PLAN.md §3.13 "restored"), written inside the command. */
  readonly record?: (entry: {
    readonly kind: 'restored';
    readonly path: string;
    readonly commit: string;
    readonly details: { readonly version: string; readonly subject: string };
  }) => void;
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

export class FileHistory {
  readonly #deps: FileHistoryDeps;

  constructor(deps: FileHistoryDeps) {
    this.#deps = deps;
    deps.engine.handleQuery(HistoryQuery, ({ path }) => this.history(path));
    deps.engine.handleQuery(VersionTextQuery, ({ commit, path }) => this.versionText(commit, path));
    deps.engine.handle(RestoreVersion, ({ path, commit }) => this.#restore(path, commit));
  }

  async history(path: HistoryPath): Promise<VersionEntry[]> {
    this.#check(path);
    const repo = this.#deps.repo();
    if ((await repo.resolve('HEAD')) === null) return [];
    const commits = await repo.log({ paths: [path], max: HISTORY_MAX });
    return commits.map((commit) => ({
      commit: commit.id,
      author: commit.author.name,
      email: commit.author.email,
      date: commit.authorDate,
      subject: commit.subject,
    }));
  }

  /** A file's text in a commit; null when the file wasn't there. */
  async versionText(commit: string, path: string): Promise<{ text: string | null }> {
    const repo = this.#deps.repo();
    this.#check(path);
    const id = await this.#commit(commit, path);
    const entry = (await repo.listTree(id, path)).find((e) => e.path === path && e.kind !== 'dir');
    if (!entry) return { text: null };
    return { text: decoder.decode(await repo.readBlob(entry.oid)) };
  }

  async #restore(path: HistoryPath, commit: string): Promise<void> {
    this.#check(path);
    const id = await this.#commit(commit, path);
    const repo = this.#deps.repo();
    // git restores the old files over the current ones; committed files the old version didn't have go too, so the
    // result is that version exactly. Files never committed are the user's own new work and stay.
    const files = async (treeish: string) =>
      new Set((await repo.listTree(treeish, path)).filter((e) => e.kind !== 'dir').map((e) => e.path));
    const old = await files(id);
    if (old.size === 0) throw new AppError('history.versionNotFound', { path });
    for (const file of await files('HEAD')) if (!old.has(file)) await this.#deps.removeFile(file);
    await repo.restore([path], id);
    const [version] = await repo.log({ range: id, max: 1 });
    this.#deps.record?.({
      kind: 'restored',
      path,
      commit: id,
      details: { version: id.slice(0, 7), subject: version?.subject ?? '' },
    });
    this.#deps.restored(path);
  }

  async #commit(commit: string, path: string): Promise<string> {
    const id = /^[0-9a-f]{7,64}$/.test(commit) ? await this.#deps.repo().resolve(`${commit}^{commit}`) : null;
    if (id === null) throw new AppError('history.versionNotFound', { path });
    return id;
  }

  #check(path: string): void {
    if (!this.#deps.allowed(path)) throw new AppError('editor.notEditable', { path });
  }
}
