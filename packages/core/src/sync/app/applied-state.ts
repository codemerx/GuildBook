// The applied-state baseline (IMPLEMENTATION.md Step 3, PLAN.md §3.10 "Adjusting links"): the commit and the skill list
// the instance last acted on, kept in instance.db. Comparing it with HEAD tells which skills a pull, a branch switch or
// another git tool added, deleted, changed or renamed, even when the app wasn't watching. It's the input to S6 and to
// every "adjust links".
import type { AppliedSkill, AppliedState } from '@app/schemas';
import type { Clock } from '../../ports/clock.ts';
import type { GitRepo, Oid } from '../../ports/git.ts';
import type { Store } from '../../ports/store.ts';
import {
  NO_SKILL_CHANGES,
  type SkillChanges,
  skillChanges,
  type SkillFiles,
  type SkillSide,
} from '../domain/skill-changes.ts';

export interface BaselineDiff {
  readonly from: Oid;
  readonly to: Oid;
  readonly changes: SkillChanges;
  /**
   * False when the baseline's commit is gone (history rewritten, a fresh clone): the skill lists were compared by
   * fingerprint instead, so a rename shows as a deletion and an addition.
   */
  readonly exact: boolean;
}

export interface AppliedStateDeps {
  readonly repo: Pick<GitRepo, 'resolve' | 'diff' | 'listTree' | 'readBlob'>;
  readonly store: Store;
  readonly clock: Clock;
  readonly skillsDir?: string;
}

const decoder = new TextDecoder();

export class AppliedStateBaseline {
  readonly #deps: AppliedStateDeps;
  readonly #skillsDir: string;

  constructor(deps: AppliedStateDeps) {
    this.#deps = deps;
    this.#skillsDir = deps.skillsDir ?? 'skills';
  }

  current(): AppliedState | undefined {
    return this.#deps.store.read((tx) => tx.appliedState.get());
  }

  /** The skill folders at a commit, with their fingerprints (git's tree ids). */
  async skillsAt(commit: Oid): Promise<AppliedSkill[]> {
    const prefix = `${this.#skillsDir}/`;
    const entries = await this.#deps.repo.listTree(commit, this.#skillsDir);
    return entries
      .filter((e) => e.kind === 'dir' && e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'))
      .map((e) => ({ folder: e.path.slice(prefix.length), fingerprint: e.oid }))
      .sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
  }

  /** Records `revision` (HEAD by default) as the state links were adjusted for. Undefined in a repo without commits. */
  async record(revision = 'HEAD'): Promise<AppliedState | undefined> {
    const commit = await this.#deps.repo.resolve(revision);
    if (commit === null) return undefined;
    const state: AppliedState = { commit, skills: await this.skillsAt(commit), recordedAt: this.#deps.clock.now() };
    this.#deps.store.write((tx) => tx.appliedState.set(state));
    return state;
  }

  /** How the skills changed from the baseline to `revision`; null without a baseline or a commit to compare. */
  async diffSince(revision = 'HEAD'): Promise<BaselineDiff | null> {
    const base = this.current();
    if (!base) return null;
    const { repo } = this.#deps;
    const to = await repo.resolve(revision);
    if (to === null) return null;
    if (to === base.commit) return { from: base.commit, to, changes: NO_SKILL_CHANGES, exact: true };

    const exact = (await repo.resolve(base.commit)) === base.commit;
    const changes = await this.#changes(exact ? base.commit : null, base.skills, to);
    return { from: base.commit, to, changes, exact };
  }

  /**
   * How the skills change from one commit or tree to another: e.g. from HEAD to the tree a pull would produce (the
   * pull preview's renames, IMPLEMENTATION.md §2.5).
   */
  between(from: Oid, to: Oid): Promise<SkillChanges> {
    return this.#changes(from, [], to);
  }

  /** `from` null: its commit is gone, and `fallback` (the stored skill list) is compared by fingerprint instead. */
  async #changes(from: Oid | null, fallback: readonly AppliedSkill[], to: Oid): Promise<SkillChanges> {
    const { repo } = this.#deps;
    const beforeList = from !== null ? await this.skillsAt(from) : fallback;
    const afterList = await this.skillsAt(to);
    const before = new Map(beforeList.map((s) => [s.folder, s.fingerprint]));
    const after = new Map(afterList.map((s) => [s.folder, s.fingerprint]));
    const deleted = [...before.keys()].filter((f) => !after.has(f));
    const added = [...after.keys()].filter((f) => !before.has(f));

    // Files are read only for skills that may pair as renames, and only when the old commit is still there.
    const pairing = from !== null && deleted.length > 0 && added.length > 0;
    const fileChanges = pairing ? await repo.diff(from, to, [this.#skillsDir]) : [];
    const side = async (commit: Oid | null, skills: Map<string, Oid>, folders: string[]): Promise<SkillSide> => {
      const files = new Map<string, SkillFiles>();
      const skillMd = new Map<string, string>();
      if (pairing && commit !== null) {
        for (const folder of folders) {
          const root = `${this.#skillsDir}/${folder}/`;
          const inner = new Map<string, Oid>();
          for (const entry of await repo.listTree(commit, `${this.#skillsDir}/${folder}`)) {
            if (entry.kind === 'dir' || !entry.path.startsWith(root)) continue;
            inner.set(entry.path.slice(root.length), entry.oid);
          }
          files.set(folder, inner);
          const md = inner.get('SKILL.md');
          if (md !== undefined) skillMd.set(folder, decoder.decode(await repo.readBlob(md)));
        }
      }
      return { skills, files, skillMd };
    };
    return skillChanges(fileChanges, await side(from, before, deleted), await side(to, after, added), this.#skillsDir);
  }
}
