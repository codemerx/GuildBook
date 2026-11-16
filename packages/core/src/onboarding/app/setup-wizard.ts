// The setup wizard after the download (PLAN.md §3.17, IMPLEMENTATION.md §2.1, Step 15): the instance is *setting up*
// and nothing outside the library changes until [Finish].
// - An Admin's new library gets its content first: imported skills, the instructions, tags; then its first version is
//   pushed and the invite link is shown (Admin steps 4–8). Those change only the library.
// - Both wizards then ask for the tools, the code repos and their tags, and the names already taken. Each answer is
//   only recorded in the setup's state, which survives a restart.
// - The summary is the plan [Finish] applies: the skill links, the exclude entries and the instruction files, combined
//   into one plan with one hash (IMPLEMENTATION.md §2.5). [Finish] refuses a plan that changed since.
import {
  editSkillMd,
  LIBRARY_FILE,
  SETUP_PAGES,
  type SetupFolderChoice,
  type SetupNameChoice,
  type SetupPage,
  type SetupState,
  SetupStateSchema,
  tagProblems,
  withLibraryTags,
} from '@app/schemas';
import type { ActivityLog } from '../../activity/index.ts';
import { defineCommand, defineQuery, type InstanceEngine } from '../../engine/index.ts';
import type { InstructionService, InstructionSetupPreview } from '../../instructions/index.ts';
import type { LibrarySnapshot } from '../../library/index.ts';
import type { LinkDecision, LinkService, SetupLinkPreview } from '../../links/index.ts';
import type { OverviewView, PlacementService } from '../../placement/index.ts';
import type { Clock } from '../../ports/clock.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { GitRepo } from '../../ports/git.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Store } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import type { DomainEvent } from '../../shared/events.ts';
import { hashValue } from '../../shared/hash.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import { inviteLink } from '../domain/invite-link.ts';

type NoInput = Record<string, never>;

export const SetupWizardQuery = defineQuery<NoInput, SetupWizardView | null>('SetupWizard');
export const SetupSummaryQuery = defineQuery<NoInput, SetupSummary>('SetupSummary');
export const SetupGo = defineCommand<{ page: SetupPage }, void>('SetupGo');
export const SetupChooseTools = defineCommand<{ enabled: readonly string[] }, void>('SetupChooseTools');
export const SetupTickTag = defineCommand<{ repo: string; tag: string; on: boolean }, void>('SetupTickTag');
export const SetupAnswerName = defineCommand<{ dest: string; choice: SetupNameChoice | null }, void>('SetupAnswerName');
export const SetupSetSkillTags = defineCommand<{ skill: string; tags: readonly string[] }, void>('SetupSetSkillTags');
export const SetupSetLibraryTags = defineCommand<
  { suggest: Readonly<Record<string, readonly string[]>>; repoOnlyTags: readonly string[] },
  void
>('SetupSetLibraryTags');
export const FinishSetup = defineCommand<{ planHash: string }, void>('FinishSetup');

/** The wizard changed: the renderer refreshes its page. */
export interface SetupChanged extends DomainEvent {
  readonly type: 'SetupChanged';
}

export interface SetupToolView {
  readonly id: string;
  readonly name: string;
  readonly found: boolean;
  readonly custom: boolean;
  readonly chosen: boolean;
  /** The link folder it reads, with the tools chosen: "Codex, Cursor, Copilot → ~/.agents/skills". */
  readonly folder: string | null;
}

export interface SetupRepoView {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly remote: string | null;
  readonly root: string | null;
  /** The tags ticked: recorded on this page, applied at [Finish]. */
  readonly ticked: readonly string[];
  /** library.yaml's suggestions for its remote, not ticked yet (PLAN.md §3.6). */
  readonly suggestions: readonly string[];
}

export interface SetupTakenName {
  readonly dest: string;
  readonly skill: string;
  readonly folder: string;
  /** What is there: the user's folder or file, a link of someone else's, or a skill the code repo commits. */
  readonly reason: string | null;
  readonly repo: string | null;
  readonly tools: readonly string[];
  readonly choice: SetupNameChoice | null;
  /** A move's suggested name: the name without the prefix, plus `-mine`. */
  readonly suggestion: string;
}

export interface SetupWizardView {
  readonly intent: SetupState['intent'];
  readonly page: SetupPage;
  readonly pages: readonly SetupPage[];
  readonly needsUpdate: SetupState['needsUpdate'];
  readonly libraryName: string;
  readonly prefix: string | null;
  /** The Admin's pages: what the library holds so far, and whether its first version is pushed. */
  readonly library: {
    readonly skills: ReadonlyArray<{ readonly skill: string; readonly tags: readonly string[] }>;
    readonly instructions: { readonly bytes: number } | null;
    readonly suggest: Readonly<Record<string, readonly string[]>>;
    readonly repoOnlyTags: readonly string[];
    /** Files changed or commits not pushed yet: the first version isn't on the server. */
    readonly unpublished: number;
    readonly published: boolean;
  };
  /** The invite link, once the first version is pushed (Admin step 8). */
  readonly invite: string | null;
  readonly tools: readonly SetupToolView[];
  readonly repos: readonly SetupRepoView[];
  readonly roots: readonly string[];
  readonly taken: readonly SetupTakenName[];
  readonly folders: readonly SetupFolderChoice[];
}

export interface SetupSummary {
  readonly hash: string;
  readonly skills: {
    readonly total: number;
    readonly everywhere: number;
    /** Skills only in some repos, grouped by those repos, with the ticked tags that put them there. */
    readonly inRepos: ReadonlyArray<{
      readonly repos: readonly string[];
      readonly tags: readonly string[];
      readonly skills: readonly string[];
    }>;
    /** In no repo and not global: e.g. a repo-only tag no repo has ticked. */
    readonly nowhere: readonly string[];
  };
  readonly instructions: {
    /** Whether the library has instructions at all (`instructions/AGENTS.md`). */
    readonly exists: boolean;
    readonly linked: boolean;
    /** The other company whose instructions are linked here instead. */
    readonly linkedBy: string | null;
    readonly tools: InstructionSetupPreview['tools'];
  };
  /** Skills that won't be installed in some tools, and why. */
  readonly notInstalled: ReadonlyArray<{
    readonly skill: string;
    readonly tools: readonly string[];
    readonly why: 'kept' | 'committed' | 'taken';
  }>;
  /** Folders of the user's that move to make room: on the name check, and the prefix check's own folders. */
  readonly moved: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /** Paths whose content goes to the app's trash, replaced by the link. */
  readonly overwritten: readonly string[];
  readonly tools: readonly string[];
}

export interface SetupWizardDeps {
  readonly engine: InstanceEngine;
  readonly store: Store;
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly activity: ActivityLog;
  readonly links: LinkService;
  readonly placement: PlacementService;
  readonly instructions: InstructionService;
  readonly repo: Pick<GitRepo, 'status'>;
  readonly libraryRoot: () => string;
  readonly snapshot: () => LibrarySnapshot | null;
  readonly libraryName: () => string;
  readonly gitUrl: () => string | null;
  /** The client id of the app registered on a self-hosted server, for the invite link. */
  readonly clientId: () => string | null;
  /** Whether this library's instructions are linked, and the other one's name when that one's are. */
  readonly instructionsLinked: () => Promise<{ linked: boolean; linkedBy: string | null }>;
  /** The library's files changed (the tags page): the library is read again. */
  readonly reload: (emit: (event: DomainEvent) => void) => Promise<void>;
  /** After [Finish]: the instruction files, and the checks every 3 minutes from now on. */
  readonly finished: (emit: (event: DomainEvent) => void) => Promise<void>;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class SetupWizard {
  readonly #deps: SetupWizardDeps;

  constructor(deps: SetupWizardDeps) {
    this.#deps = deps;
    const { engine } = deps;
    engine.handleQuery(SetupWizardQuery, () => this.view());
    engine.handleQuery(SetupSummaryQuery, () => this.summary());
    engine.handle(SetupGo, ({ page }, context) =>
      this.#change(
        (s) => this.#go(s, page),
        (event) => context.emit(event),
      ),
    );
    engine.handle(SetupChooseTools, async ({ enabled }, context) => {
      const known = new Set(this.#deps.links.toolsSnapshot().tools.map((tool) => tool.id));
      for (const id of enabled) if (!known.has(id)) throw new AppError('tools.unknown', { tool: id });
      await this.#change(
        (s) => ({ ...s, tools: [...new Set(enabled)].sort() }),
        (event) => context.emit(event),
      );
    });
    engine.handle(SetupTickTag, async ({ repo, tag, on }, context) => {
      if (!this.#deps.placement.overview().repos.some((r) => r.id === repo)) {
        throw new AppError('placement.repoNotFound', { repo });
      }
      if (tagProblems(tag).length > 0) throw new AppError('setup.tagInvalid', { tag });
      await this.#change(
        (s) => {
          const rest = s.tags.filter((t) => !(t.repo === repo && t.tag === tag));
          return { ...s, tags: on ? [...rest, { repo, tag }] : rest };
        },
        (event) => context.emit(event),
      );
    });
    engine.handle(SetupAnswerName, async ({ dest, choice }, context) => {
      if (choice?.kind === 'move-aside') {
        this.#deps.links.checkMoveName(choice.name);
        const to = this.#deps.paths.join(this.#deps.paths.dirname(dest), choice.name.trim());
        this.#deps.links.allowPaths([to]);
        if (await this.#deps.fs.lstat(to as AbsPath)) throw new AppError('links.pathTaken', { path: to });
      }
      await this.#change(
        (s) => {
          const names = { ...s.names };
          if (choice === null) delete names[dest];
          else names[dest] = choice.kind === 'move-aside' ? { kind: 'move-aside', name: choice.name.trim() } : choice;
          return { ...s, names };
        },
        (event) => context.emit(event),
      );
    });
    engine.handle(SetupSetSkillTags, ({ skill, tags }, context) =>
      this.#setSkillTags(skill, tags, (event) => context.emit(event)),
    );
    engine.handle(SetupSetLibraryTags, ({ suggest, repoOnlyTags }, context) =>
      this.#setLibraryTags(suggest, repoOnlyTags, (event) => context.emit(event)),
    );
    engine.handle(FinishSetup, ({ planHash }, context) => this.#finish(planHash, (event) => context.emit(event)));
  }

  /** The state while the instance is setting up; undefined once it's ready. */
  state(): SetupState | undefined {
    return this.#deps.store.read((tx) => tx.setupState.get());
  }

  /** What the guard lets [Finish] reach besides the links: the user's own folders it moves (step 5). */
  roots(): string[] {
    const state = this.state();
    if (!state) return [];
    const { paths } = this.#deps;
    return state.folders.flatMap((f) =>
      f.choice === 'move' && f.name ? [f.path, paths.join(paths.dirname(f.path), f.name)] : [],
    );
  }

  // ---- Views ---------------------------------------------------------------------------------------------------

  async view(): Promise<SetupWizardView | null> {
    const state = this.state();
    if (!state) return null;
    const { deps } = { deps: this.#deps };
    const snapshot = deps.snapshot();
    const tools = await this.#tools(state);
    const overview = deps.placement.overview();
    const library = await this.#library(snapshot);
    const gitUrl = deps.gitUrl();
    const taken = state.page === 'names' || state.page === 'summary' ? await this.#taken(state) : [];
    return {
      intent: state.intent,
      page: state.page,
      pages: [...SETUP_PAGES[state.intent]],
      needsUpdate: state.needsUpdate,
      libraryName: deps.libraryName(),
      prefix: snapshot?.config.prefix ?? null,
      library,
      invite:
        state.intent === 'create' && library.published && gitUrl !== null
          ? inviteLink({ url: gitUrl, clientId: deps.clientId() })
          : null,
      tools,
      repos: this.#repos(state, overview),
      roots: [...overview.roots],
      taken,
      folders: state.folders,
    };
  }

  /** The summary (PLAN.md §3.17 step 9): what [Finish] does, from the combined plan. */
  async summary(): Promise<SetupSummary> {
    const state = this.#stateOrFail();
    const { deps } = { deps: this.#deps };
    const inputs = await this.#linkInputs(state);
    const links = await deps.links.previewSetup(inputs);
    const instructions = await deps.instructions.previewSetup(inputs.enabled);
    const linking = await deps.instructionsLinked();
    const overview = deps.placement.overview();
    const repoName = (id: string) => overview.repos.find((r) => r.id === id)?.name ?? id;
    const snapshot = deps.snapshot();
    const tagsOf = new Map((snapshot?.skills ?? []).map((s) => [s.folder, s.tags]));
    const rules = this.#rules(state, overview);
    const groups = new Map<string, { repos: string[]; tags: Set<string>; skills: string[] }>();
    let everywhere = 0;
    const nowhere: string[] = [];
    for (const skill of links.skills) {
      if (skill.global) {
        everywhere++;
        continue;
      }
      if (skill.repos.length === 0) {
        nowhere.push(skill.skill);
        continue;
      }
      const repos = skill.repos.map(repoName).sort(byText);
      const key = repos.join('\u0000');
      const group = groups.get(key) ?? { repos, tags: new Set<string>(), skills: [] };
      group.skills.push(skill.skill);
      const tags = tagsOf.get(skill.skill) ?? [];
      for (const rule of rules)
        if (skill.repos.includes(rule.repo) && tags.includes(rule.tag)) group.tags.add(rule.tag);
      groups.set(key, group);
    }
    const notInstalled = new Map<string, { skill: string; tools: Set<string>; why: 'kept' | 'committed' | 'taken' }>();
    for (const item of links.skipped) {
      const why = item.status === 'suppressed' ? 'kept' : state.names[item.dest] ? 'kept' : 'taken';
      const reason = links.taken.find((t) => t.dest === item.dest)?.reason;
      const kind = reason === 'committed' ? 'committed' : why;
      const key = `${item.skill}\u0000${kind}`;
      const entry = notInstalled.get(key) ?? { skill: item.skill, tools: new Set<string>(), why: kind };
      for (const tool of item.tools) entry.tools.add(tool);
      notInstalled.set(key, entry);
    }
    const { paths } = deps;
    const moved = [
      ...Object.entries(state.names).flatMap(([dest, choice]) =>
        choice.kind === 'move-aside' ? [{ from: dest, to: paths.join(paths.dirname(dest), choice.name) }] : [],
      ),
      ...state.folders.flatMap((f) =>
        f.choice === 'move' && f.name ? [{ from: f.path, to: paths.join(paths.dirname(f.path), f.name) }] : [],
      ),
    ].sort((a, b) => byText(a.from, b.from));
    const unique = moved.filter((m, i) => moved.findIndex((n) => n.from === m.from) === i);
    const toolNames = (await this.#tools(state)).filter((tool) => tool.chosen).map((tool) => tool.name);
    return {
      hash: this.#hash(state, links, instructions),
      skills: {
        total: links.skills.length,
        everywhere,
        inRepos: [...groups.values()]
          .map((g) => ({ repos: g.repos, tags: [...g.tags].sort(byText), skills: g.skills.sort(byText) }))
          .sort((a, b) => byText(a.repos.join(','), b.repos.join(','))),
        nowhere: nowhere.sort(byText),
      },
      instructions: {
        exists: (snapshot?.instructions ?? null) !== null,
        linked: linking.linked,
        linkedBy: linking.linkedBy,
        tools: instructions.tools,
      },
      notInstalled: [...notInstalled.values()]
        .map((n) => ({ skill: n.skill, tools: [...n.tools].sort(byText), why: n.why }))
        .sort((a, b) => byText(a.skill, b.skill)),
      moved: unique,
      overwritten: Object.entries(state.names)
        .filter(([, choice]) => choice.kind === 'overwrite')
        .map(([dest]) => dest)
        .sort(byText),
      tools: toolNames,
    };
  }

  // ---- Commands --------------------------------------------------------------------------------------------------

  async #finish(planHash: string, emit: (event: DomainEvent) => void): Promise<void> {
    const state = this.#stateOrFail();
    if (state.page === 'needsUpdate') throw new AppError('setup.needsUpdate', { reason: state.needsUpdate ?? '' });
    const { deps } = { deps: this.#deps };
    if (state.intent === 'create' && !(await this.#library(deps.snapshot())).published) {
      throw new AppError('setup.notPublished');
    }
    const inputs = await this.#linkInputs(state);
    const links = await deps.links.previewSetup(inputs);
    const instructions = await deps.instructions.previewSetup(inputs.enabled);
    if (this.#hash(state, links, instructions) !== planHash) {
      throw new AppError('plan.changed', { kind: 'setup' });
    }
    // The prefix check's own folders first (step 5): one at a company skill's path is moved by the link plan itself.
    const wanted = new Set(links.links.filter((link) => link.op === 'move-aside').map((link) => link.dest));
    const moved: Array<{ from: string; to: string }> = [];
    const { fs, paths } = deps;
    deps.links.allowPaths(this.roots());
    for (const folder of state.folders) {
      if (folder.choice !== 'move' || !folder.name || wanted.has(folder.path)) continue;
      const to = paths.join(paths.dirname(folder.path), folder.name);
      if (!(await fs.lstat(folder.path as AbsPath))) continue;
      if (await fs.lstat(to as AbsPath)) throw new AppError('links.pathTaken', { path: to });
      await fs.rename(folder.path as AbsPath, to as AbsPath);
      moved.push({ from: folder.path, to });
    }
    const edits = this.#edits(state);
    const chosenNames = (await this.#tools(state)).filter((tool) => tool.chosen).map((tool) => tool.name);
    await deps.links.applySetup(
      inputs,
      links.hash,
      () =>
        deps.store.write((tx) => {
          tx.settings.set({ ...tx.settings.get(), enabledTools: [...inputs.enabled] });
          deps.activity.appendIn(tx, [
            {
              kind: 'instance-added',
              path: null,
              details: {
                intent: state.intent,
                tools: chosenNames,
                moved: moved.map((m) => ({ from: m.from, to: m.to })),
              },
            },
          ]);
        }),
      emit,
    );
    // The tag ticks are placement's own rows: written after the links followed them, as a confirmed change is.
    if (edits.length > 0) deps.placement.persist(edits);
    deps.store.write((tx) => tx.setupState.clear());
    deps.logger.info('setup finished', { intent: state.intent, tools: inputs.enabled.length });
    await deps.finished(emit);
    emit({ type: 'SetupChanged', at: deps.clock.now() } satisfies SetupChanged);
  }

  async #setSkillTags(skill: string, tags: readonly string[], emit: (event: DomainEvent) => void): Promise<void> {
    const state = this.#stateOrFail();
    if (state.intent !== 'create') throw new AppError('setup.wrongStep', { step: state.page });
    for (const tag of tags) if (tagProblems(tag).length > 0) throw new AppError('setup.tagInvalid', { tag });
    const { fs, paths } = this.#deps;
    if (!this.#deps.snapshot()?.skills.some((s) => s.folder === skill))
      throw new AppError('editor.notFound', { path: skill });
    const file = paths.join(this.#deps.libraryRoot(), 'skills', skill, 'SKILL.md') as AbsPath;
    const edited = editSkillMd(await fs.readText(file), { tags: [...new Set(tags)] });
    if (!edited.ok) throw new AppError('editor.headerUnreadable', { problem: edited.problem });
    await fs.writeTextAtomic(file, edited.text);
    await this.#deps.reload(emit);
    emit({ type: 'SetupChanged', at: this.#deps.clock.now() } satisfies SetupChanged);
  }

  /** library.yaml's tag hints (PLAN.md §3.6): only those two fields change; the rest of the file stays as it is. */
  async #setLibraryTags(
    suggest: Readonly<Record<string, readonly string[]>>,
    repoOnlyTags: readonly string[],
    emit: (event: DomainEvent) => void,
  ): Promise<void> {
    const state = this.#stateOrFail();
    if (state.intent !== 'create') throw new AppError('setup.wrongStep', { step: state.page });
    for (const tag of [...Object.keys(suggest), ...repoOnlyTags]) {
      if (tagProblems(tag).length > 0) throw new AppError('setup.tagInvalid', { tag });
    }
    for (const patterns of Object.values(suggest)) {
      for (const pattern of patterns) {
        if (!/^[A-Za-z0-9._*/-]{1,200}$/.test(pattern)) throw new AppError('setup.patternInvalid', { pattern });
      }
    }
    const { fs, paths } = this.#deps;
    const file = paths.join(this.#deps.libraryRoot(), LIBRARY_FILE) as AbsPath;
    const text = withLibraryTags(await fs.readText(file), { suggest, repoOnlyTags });
    if (text === null) throw new AppError('setup.libraryYamlUnreadable');
    await fs.writeTextAtomic(file, text);
    await this.#deps.reload(emit);
    emit({ type: 'SetupChanged', at: this.#deps.clock.now() } satisfies SetupChanged);
  }

  /** Going back is always allowed; going on past the first push needs the push (Admin step 7). */
  async #go(state: SetupState, page: SetupPage): Promise<SetupState> {
    if (state.page === 'needsUpdate' || page === 'needsUpdate') {
      throw new AppError('setup.needsUpdate', { reason: state.needsUpdate ?? '' });
    }
    const pages: readonly SetupPage[] = SETUP_PAGES[state.intent];
    if (!pages.includes(page)) throw new AppError('setup.wrongStep', { step: page });
    if (state.intent === 'create' && pages.indexOf(page) > pages.indexOf('publish')) {
      if (!(await this.#library(this.#deps.snapshot())).published) throw new AppError('setup.notPublished');
    }
    // The tools found are ticked until the user chose (PLAN.md §3.17 step 6).
    const tools = state.tools ?? (await this.#tools(state)).flatMap((tool) => (tool.chosen ? [tool.id] : []));
    return { ...state, page, tools: pages.indexOf(page) > pages.indexOf('tools') ? tools : state.tools };
  }

  async #change(
    update: (state: SetupState) => SetupState | Promise<SetupState>,
    emit: (event: DomainEvent) => void,
  ): Promise<void> {
    const state = this.#stateOrFail();
    const next = SetupStateSchema.parse(await update(state));
    this.#deps.store.write((tx) => tx.setupState.set(next));
    emit({ type: 'SetupChanged', at: this.#deps.clock.now() } satisfies SetupChanged);
  }

  // ---- Inputs ----------------------------------------------------------------------------------------------------

  #stateOrFail(): SetupState {
    const state = this.state();
    if (!state) throw new AppError('setup.wrongStep', { step: 'done' });
    return state;
  }

  /** The tools: chosen ones, or until the user chose, the ones found on this device. */
  async #tools(state: SetupState): Promise<SetupToolView[]> {
    const tools = (await this.#deps.links.tools()).tools;
    const chosen = new Set(state.tools ?? tools.filter((tool) => tool.found || tool.custom).map((tool) => tool.id));
    const folders = this.#deps.links.linkFolders([...chosen]);
    const { paths } = this.#deps;
    return tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      found: tool.found,
      custom: tool.custom,
      chosen: chosen.has(tool.id),
      folder:
        tool.skillDirs.find((dir) => folders.some((folder) => paths.same(folder, dir))) ?? tool.skillDirs[0] ?? null,
    }));
  }

  #rules(state: SetupState, overview: OverviewView): Array<{ repo: string; tag: string }> {
    const stored = overview.repos.flatMap((repo) => repo.rules.map((tag) => ({ repo: repo.id, tag })));
    const ticked = state.tags.filter((t) => !stored.some((s) => s.repo === t.repo && s.tag === t.tag));
    return [...stored, ...ticked];
  }

  #repos(state: SetupState, overview: OverviewView): SetupRepoView[] {
    return overview.repos
      .filter((repo) => repo.missingSince === null)
      .map((repo) => {
        const ticked = [
          ...new Set([...repo.rules, ...state.tags.filter((t) => t.repo === repo.id).map((t) => t.tag)]),
        ].sort(byText);
        return {
          id: repo.id,
          name: repo.name,
          path: repo.path,
          remote: repo.remote,
          root: repo.root,
          ticked,
          suggestions: repo.suggestions.filter((tag) => !ticked.includes(tag)),
        };
      });
  }

  /** The tag ticks as placement edits, for the plan. */
  #edits(state: SetupState): Array<{ op: 'rule'; repo: string; tag: string; on: true }> {
    const known = new Set(this.#deps.placement.overview().repos.map((repo) => repo.id));
    return state.tags
      .filter((t) => known.has(t.repo))
      .map((t) => ({ op: 'rule' as const, repo: t.repo, tag: t.tag, on: true as const }));
  }

  async #linkInputs(
    state: SetupState,
  ): Promise<{ enabled: string[]; decisions: Record<string, LinkDecision>; change: unknown }> {
    const enabled = (await this.#tools(state)).flatMap((tool) => (tool.chosen ? [tool.id] : []));
    const decisions: Record<string, LinkDecision> = {};
    for (const [dest, choice] of Object.entries(state.names)) {
      decisions[dest] =
        choice.kind === 'move-aside' ? { kind: 'move-aside', name: choice.name, rewriteName: false } : choice;
    }
    // An own folder the prefix check moves, at a company skill's path: the link plan moves it aside.
    for (const folder of state.folders) {
      if (folder.choice === 'move' && folder.name && decisions[folder.path] === undefined) {
        decisions[folder.path] = { kind: 'move-aside', name: folder.name, rewriteName: false };
      }
    }
    const edits = this.#edits(state);
    return { enabled, decisions, change: edits.length > 0 ? edits : undefined };
  }

  async #taken(state: SetupState): Promise<SetupTakenName[]> {
    const preview = await this.#deps.links.previewSetup(await this.#linkInputs(state));
    const prefix = this.#deps.snapshot()?.config.prefix ?? null;
    // A folder the prefix check moves (step 5) is answered already.
    const moved = new Set(state.folders.filter((f) => f.choice === 'move').map((f) => f.path));
    return preview.taken
      .filter((item) => !moved.has(item.dest))
      .map((item) => {
        const base = prefix && item.skill.startsWith(`${prefix}-`) ? item.skill.slice(prefix.length + 1) : item.skill;
        return { ...item, choice: state.names[item.dest] ?? null, suggestion: `${base}-mine` };
      });
  }

  async #library(snapshot: LibrarySnapshot | null): Promise<SetupWizardView['library']> {
    const status = await this.#deps.repo.status().catch(() => null);
    const unpublished = status === null ? 0 : status.entries.length + status.ahead + (status.upstream ? 0 : 1);
    const config = snapshot?.config.value ?? {};
    return {
      skills: (snapshot?.skills ?? []).map((s) => ({ skill: s.folder, tags: [...s.tags] })),
      instructions: snapshot?.instructions ? { bytes: snapshot.instructions.bytes } : null,
      suggest: config.suggest ?? {},
      repoOnlyTags: config.repoOnlyTags ?? [],
      unpublished,
      published: status !== null && status.head !== null && unpublished === 0,
    };
  }

  #hash(state: SetupState, links: SetupLinkPreview, instructions: InstructionSetupPreview): string {
    return hashValue({
      links: links.hash,
      instructions: instructions.hash,
      folders: state.folders,
      url: this.#deps.gitUrl(),
    });
  }
}
