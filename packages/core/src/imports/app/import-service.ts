// Imports (PLAN.md §3.18, IMPLEMENTATION.md Step 13): existing skills come into the library, each one reviewed first.
// - The sources: A, a git URL (cloned into the import's temporary folder with the library's sign-in, or the user's SSH
//   agent for an SSH URL) or a local folder; B, a skill folder; C, a `.zip` or `.skill` file, unpacked safely.
// - The layout scanner finds the skills; each gets a name with the prefix and records `metadata.source`.
// - The review gate: a skill is staged as it will be added when it's opened; [Add] needs every selected skill opened.
// - [Add] copies the staged skills into `skills/` as uncommitted changes. Links inside stay links (PLAN.md §3.15).
// - Replacing the original: for a skill from a local folder outside any repo, the app remembers the original on this
//   device, and offers [Replace] once the skill is in the company version.
// The source is never changed: a picked folder is only read, and a URL is cloned outside the library. One import runs at
// a time per instance; its temporary folder `<data folder>/imports/<id>` goes when it ends, and leftovers at start.
import { editSkillMd, type InstanceSettings, readSkillHeader } from '@app/schemas';
import { type ActivityLog, type InstanceTrash } from '../../activity/index.ts';
import { type CommandContext, defineCommand, defineQuery, type InstanceEngine } from '../../engine/index.ts';
import {
  blobId,
  fileKind,
  type FileKind,
  fileSizeIssues,
  type GitUrl,
  headerIssues,
  issue,
  type Issue,
  layoutIssues,
  type LibrarySnapshot,
  markdownLinkIssues,
  parseGitUrl,
  scanSkill,
  skillLengthIssues,
  symlinkIssues,
  workingTreeSource,
} from '../../library/index.ts';
import { mirrorFolder } from '../../links/index.ts';
import type { Archive } from '../../ports/archive.ts';
import type { Clock } from '../../ports/clock.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Git, GitAuth } from '../../ports/git.ts';
import type { Links } from '../../ports/links.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Random } from '../../ports/random.ts';
import type { Store } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import { randomToken } from '../../shared/ids.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import { baseName, type LayoutKind, type NotImported } from '../domain/layout.ts';
import { importedName, nameUsable } from '../domain/naming.ts';
import { type Mention, mentionsOf, reviewGate, type SkillFlags, skillFlags } from '../domain/review.ts';
import { type SourceFacts, sourceRecord } from '../domain/source-record.ts';
import { scanSource } from './source-scan.ts';
import { unpackArchive } from './unpack.ts';

export type ImportSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'folder'; readonly path: string }
  | { readonly kind: 'archive'; readonly path: string };

export interface ImportCandidate {
  readonly id: string;
  /** Where it was found in the source, with forward slashes; '' when the source is the skill. */
  readonly foundAt: string;
  readonly layout: LayoutKind;
  /** The name it had: its header's `name:`, else its folder's name. */
  readonly oldName: string;
  /** The name it gets in the library. */
  readonly name: string;
  /** The old name didn't follow the Agent Skills rules (PLAN.md §3.18 "name fixed to match the standard"). */
  readonly fixed: boolean;
  readonly scripts: boolean;
  readonly allowedTools: boolean;
  /** Its name is already used: in the library, or by another skill of this import. */
  readonly clash: 'library' | 'import' | null;
  /** Opened in the editor for review (PLAN.md §3.18: a ✓ appears). */
  readonly opened: boolean;
}

export interface ImportSessionView {
  readonly id: string;
  readonly source: { readonly kind: ImportSource['kind']; readonly label: string };
  readonly candidates: readonly ImportCandidate[];
  readonly notImported: readonly NotImported[];
  /** What `metadata.source` records for the source's top, or null for a source without a remote. */
  readonly record: string | null;
  /** The originals stay where they are and can be replaced once the skills are in the company version (§3.18 B). */
  readonly replaceable: boolean;
}

export interface ImportFileEntry {
  /** Relative to the skill's folder, with forward slashes. */
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'link';
  readonly size: number;
}

export interface ImportReview {
  readonly candidate: ImportCandidate;
  /** SKILL.md as it is in the source. */
  readonly original: string;
  /** SKILL.md as it will be added, with the reviewer's edits. */
  readonly staged: string;
  readonly files: readonly ImportFileEntry[];
  readonly flags: SkillFlags;
  /** Validation problems, as the library's checks see the skill (PLAN.md §3.18). */
  readonly issues: readonly Issue[];
  /** Mentions of the old names in the skill's text, for the reviewer to fix by hand. */
  readonly mentions: readonly Mention[];
}

export interface ImportFile {
  readonly path: string;
  readonly kind: FileKind;
  readonly text: string | null;
  readonly size: number;
  readonly hash: string;
}

export interface ImportReport {
  readonly added: ReadonlyArray<{ readonly name: string; readonly foundAt: string }>;
  readonly notImported: readonly NotImported[];
  readonly source: { readonly kind: ImportSource['kind']; readonly label: string };
}

export interface ImportRoots {
  readonly read: readonly string[];
  readonly git: readonly string[];
  readonly originals: readonly string[];
}

export interface OriginalOffer {
  readonly skill: string;
  /** Where the original is on this device. */
  readonly original: string;
}

type IdInput = { readonly id: string };

export const ImportSessionQuery = defineQuery<Record<string, never>, ImportSessionView | null>('ImportSession');
export const ImportFileQuery = defineQuery<IdInput & { readonly path: string }, ImportFile>('ImportFile');
export const ImportOffersQuery = defineQuery<Record<string, never>, OriginalOffer[]>('ImportOffers');
export const StartImport = defineCommand<ImportSource, ImportSessionView>('StartImport');
export const ReviewImportSkill = defineCommand<IdInput, ImportReview>('ReviewImportSkill');
export const RenameImportSkill = defineCommand<IdInput & { readonly name: string }, ImportReview>('RenameImportSkill');
export const SaveImportFile = defineCommand<
  IdInput & { readonly path: string; readonly text: string; readonly base: string | null },
  { readonly hash: string; readonly written: boolean }
>('SaveImportFile');
export const AddImportedSkills = defineCommand<{ readonly ids: readonly string[] }, ImportReport>('AddImportedSkills');
export const CancelImport = defineCommand<Record<string, never>, void>('CancelImport');
export const ReplaceOriginal = defineCommand<{ readonly skill: string }, void>('ReplaceOriginal');
export const KeepOriginal = defineCommand<{ readonly skill: string }, void>('KeepOriginal');

export interface ImportServiceDeps {
  readonly engine: InstanceEngine;
  readonly fs: FileSystem;
  readonly links: Links;
  readonly paths: PathFlavour;
  readonly git: Pick<Git, 'clone' | 'importSource'>;
  readonly archive: Archive;
  readonly store: Store;
  readonly random: Random;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly activity: ActivityLog;
  readonly trash: InstanceTrash;
  readonly dataFolder: string;
  readonly libraryRoot: () => string;
  readonly snapshot: () => LibrarySnapshot | null;
  /** How a URL is cloned: the library's sign-in for its host, or the user's SSH agent for an SSH URL. */
  readonly auth: (url: GitUrl) => Promise<GitAuth>;
  /** Whether `skills/<skill>` is in the company version: pushed, or the request merged (PLAN.md §3.18 B). */
  readonly inCompany: (skill: string) => Promise<boolean>;
  /** New skills are in the library: the link check runs, so they get linked as any new skill (PLAN.md §3.8 S1). */
  readonly skillsChanged: (reason: string) => void;
  /** The session, its review or the offers changed. */
  readonly onChange?: () => void;
}

interface Candidate {
  id: string;
  foundAt: string;
  layout: LayoutKind;
  oldName: string;
  name: string;
  fixed: boolean;
  scripts: boolean;
  allowedTools: boolean;
  original: string;
  opened: boolean;
  /** The staged copy's name, once it's staged: its folder is `staged/<id>/skills/<name>`. */
  staged: string | null;
}

interface Session {
  readonly id: string;
  readonly dir: AbsPath;
  readonly source: { readonly kind: ImportSource['kind']; readonly label: string };
  /** Where the skills are read from: the clone, the picked folder, or the unpacked archive. */
  readonly root: AbsPath;
  /** What the user picked (a folder or a file), readable for the import's length; null for a URL. */
  readonly picked: AbsPath | null;
  readonly facts: SourceFacts;
  readonly replaceable: boolean;
  readonly candidates: Candidate[];
  readonly notImported: NotImported[];
}

const IMPORTS_FOLDER = 'imports';
/** git's answers that mean the sign-in can't read the repo (PLAN.md §3.18: the offer to import a local clone). */
const CANNOT_READ = new Set(['git.notFound', 'git.authFailed', 'git.forbidden']);
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();

export class ImportService {
  readonly #deps: ImportServiceDeps;
  #session: Session | null = null;

  constructor(deps: ImportServiceDeps) {
    this.#deps = deps;
    const { engine } = deps;
    engine.handleQuery(ImportSessionQuery, () => (this.#session ? this.#view(this.#session) : null));
    engine.handleQuery(ImportFileQuery, ({ id, path }) => this.#readFile(id, path));
    engine.handleQuery(ImportOffersQuery, () => this.offers());
    engine.handle(StartImport, (source, context) => this.#start(source, context));
    engine.handle(ReviewImportSkill, ({ id }) => this.#review(id));
    engine.handle(RenameImportSkill, ({ id, name }) => this.#rename(id, name));
    engine.handle(SaveImportFile, ({ id, path, text, base }) => this.#save(id, path, text, base));
    engine.handle(AddImportedSkills, ({ ids }) => this.#add(ids));
    engine.handle(CancelImport, () => this.#cancel());
    engine.handle(ReplaceOriginal, ({ skill }) => this.#replace(skill));
    engine.handle(KeepOriginal, ({ skill }) => this.#keep(skill));
  }

  /** `<data folder>/imports`: every import's temporary folder. */
  get folder(): AbsPath {
    return this.#deps.paths.join(this.#deps.dataFolder, IMPORTS_FOLDER) as AbsPath;
  }

  /**
   * What the guards must allow (IMPLEMENTATION.md §2.10): while an import runs, the picked folder or file is read, and
   * git may ask it, and the import folder, for its remote and commit. The originals waiting for [Replace] may be checked
   * and moved to the trash, and a replaced one put back from the trash. The guard asks at every file operation, so the
   * answer is kept until something here changes.
   */
  roots(): ImportRoots {
    if (this.#roots === null) {
      const picked = this.#session?.picked ?? null;
      const replaced = this.#deps.trash
        .list()
        .filter((entry) => entry.reason === 'imported-original' && entry.state !== 'restored')
        .map((entry) => entry.originalPath);
      this.#roots = {
        read: picked === null ? [] : [picked],
        git: [this.folder, ...(picked === null ? [] : [picked])],
        originals: [...this.#settings().importedOriginals.map((entry) => entry.path), ...replaced],
      };
    }
    return this.#roots;
  }

  #roots: ImportRoots | null = null;

  /** The session or the originals changed: the guards' roots are worked out again. */
  #changed(): void {
    this.#roots = null;
    this.#deps.onChange?.();
  }

  #setSession(session: Session | null): void {
    this.#session = session;
    this.#roots = null;
  }

  /** Leftovers of an import that was under way when the app stopped. */
  async start(): Promise<void> {
    const { fs } = this.#deps;
    if (await fs.lstat(this.folder)) {
      await fs.removeTree(this.folder);
      this.#deps.logger.info('removed leftover import folders');
    }
  }

  /** The originals that may be replaced now: their skill is in the company version, and they're still there. */
  async offers(): Promise<OriginalOffer[]> {
    const { fs } = this.#deps;
    const library = new Set((this.#deps.snapshot()?.skills ?? []).map((skill) => skill.folder));
    const offers: OriginalOffer[] = [];
    for (const entry of this.#settings().importedOriginals) {
      if (!library.has(entry.skill)) continue;
      if (!(await fs.lstat(entry.path as AbsPath))) continue;
      if (await this.#deps.inCompany(entry.skill)) offers.push({ skill: entry.skill, original: entry.path });
    }
    return offers;
  }

  // ---- Starting --------------------------------------------------------------------------------------------------

  async #start(source: ImportSource, context: CommandContext): Promise<ImportSessionView> {
    const { fs, paths, random, logger } = this.#deps;
    await this.#cancel();
    const prefix = this.#prefix();
    const id = `imp_${randomToken(random, 12)}`;
    const dir = paths.join(this.folder, id) as AbsPath;
    await fs.mkdirp(dir);
    try {
      const opened = await this.#open(source, dir, context);
      const session: Session = { id, dir, ...opened, candidates: [], notImported: [] };
      // The picked folder becomes readable from here on (roots()), so the scan can read it.
      this.#setSession(session);
      const scan = await scanSource({ fs, paths }, session.root, context.signal);
      const fallback = this.#sourceName(session);
      scan.skills.forEach((found, index) => {
        const header = found.header;
        const headerName = typeof header?.name === 'string' && header.name.trim() !== '' ? header.name.trim() : null;
        const oldName = headerName ?? baseName(found.path, fallback);
        const named = importedName(oldName, prefix);
        session.candidates.push({
          id: `c${index + 1}`,
          foundAt: found.path,
          layout: found.layout,
          oldName,
          name: named.name,
          fixed: named.fixed,
          scripts: found.scripts,
          allowedTools: header?.['allowed-tools'] !== undefined,
          original: found.text,
          opened: false,
          staged: null,
        });
      });
      session.notImported.push(...scan.notImported);
      logger.info('import started', {
        kind: source.kind,
        skills: session.candidates.length,
        notImported: session.notImported.length,
      });
      this.#changed();
      return this.#view(session);
    } catch (error) {
      this.#setSession(null);
      await fs.removeTree(dir).catch(() => undefined);
      throw error;
    }
  }

  /** Reads the source into reach: the clone, the picked folder, or the unpacked archive. */
  async #open(
    source: ImportSource,
    dir: AbsPath,
    context: CommandContext,
  ): Promise<Pick<Session, 'source' | 'root' | 'picked' | 'facts' | 'replaceable'>> {
    const { fs, paths, git } = this.#deps;
    if (source.kind === 'url') {
      const parsed = parseGitUrl(source.url);
      if (!parsed.ok) throw new AppError('import.urlInvalid', { problem: parsed.error });
      const clone = paths.join(dir, 'clone') as AbsPath;
      try {
        await git.clone({
          url: parsed.value.url,
          dest: clone,
          shallow: true,
          auth: await this.#deps.auth(parsed.value),
          signal: context.signal,
          onProgress: (progress) => {
            if (progress.percent !== null) context.progress(progress.percent, 100);
          },
        });
      } catch (error) {
        if (isAppError(error) && CANNOT_READ.has(error.code)) {
          throw new AppError('import.cannotRead', { host: parsed.value.host, repo: parsed.value.path });
        }
        throw error;
      }
      const head = await git.importSource(clone).head();
      return {
        source: { kind: 'url', label: parsed.value.url },
        root: clone,
        picked: null,
        facts: { remote: parsed.value.url, commit: head, path: '' },
        replaceable: false,
      };
    }
    if (!paths.isAbsolute(source.path)) throw new AppError('import.sourceNotFound', {});
    const picked = paths.normalize(source.path) as AbsPath;
    if (source.kind === 'archive') {
      // The file becomes readable for the unpacking only.
      this.#setSession({ ...placeholder(dir, picked), picked });
      const unpacked = paths.join(dir, 'unpacked') as AbsPath;
      await unpackArchive({ fs, paths, archive: this.#deps.archive }, picked, unpacked, context.signal);
      return {
        source: { kind: 'archive', label: picked },
        root: unpacked,
        picked,
        facts: { remote: null, commit: null, path: '' },
        replaceable: false,
      };
    }
    this.#setSession({ ...placeholder(dir, picked), picked });
    const found = await fs.lstat(picked);
    if (found?.kind !== 'dir' && found?.kind !== 'link') throw new AppError('import.sourceNotFound', {});
    const repo = git.importSource(picked);
    const where = await repo.prefix();
    const facts: SourceFacts =
      where === null
        ? { remote: null, commit: null, path: '' }
        : { remote: await repo.remoteUrl(), commit: await repo.head(), path: where };
    // An original inside a repo stays: replacing it would change that repo (§3.18 "The old repo is never changed").
    return { source: { kind: 'folder', label: picked }, root: picked, picked, facts, replaceable: where === null };
  }

  /** The name a skill at the source's top gets when its header has none: the repo's, folder's or file's name. */
  #sourceName(session: Session): string {
    const { paths } = this.#deps;
    if (session.source.kind === 'url') return paths.basename(session.source.label.replace(/\.git$/, ''));
    const name = paths.basename(session.source.label);
    return session.source.kind === 'archive' ? name.replace(/\.(zip|skill)$/i, '') : name;
  }

  // ---- The review ------------------------------------------------------------------------------------------------

  async #review(id: string): Promise<ImportReview> {
    const session = this.#current();
    const candidate = this.#candidate(session, id);
    if (candidate.staged === null) await this.#stage(session, candidate);
    if (!candidate.opened) {
      candidate.opened = true;
      this.#changed();
    }
    return this.#reviewOf(session, candidate);
  }

  /** The skill as it will be added: a copy with its new name and `metadata.source`, links kept as links. */
  async #stage(session: Session, candidate: Candidate): Promise<void> {
    const { fs, links, paths } = this.#deps;
    const from = this.#sourcePath(session, candidate.foundAt);
    const to = this.#stagedPath(session, candidate, candidate.name);
    const record = sourceRecord({ ...session.facts, path: joinRepoPath(session.facts.path, candidate.foundAt) });
    await fs.mkdirp(paths.dirname(to) as AbsPath);
    // Files are copied as they are (a script keeps its executable bit); then SKILL.md gets its new header.
    await mirrorFolder({ fs, links, paths }, from, to);
    const skillMd = paths.join(to, 'SKILL.md') as AbsPath;
    await fs.writeTextAtomic(
      skillMd,
      withImportHeader(decoder.decode(await fs.readBytes(skillMd)), candidate.name, record),
    );
    candidate.staged = candidate.name;
  }

  async #reviewOf(session: Session, candidate: Candidate): Promise<ImportReview> {
    const { fs, paths } = this.#deps;
    const name = candidate.staged ?? candidate.name;
    const stagedRoot = paths.join(session.dir, 'staged', candidate.id) as AbsPath;
    const facts = await scanSkill(workingTreeSource(fs, paths, stagedRoot), name);
    const entries = facts?.entries ?? [];
    const folder = this.#stagedPath(session, candidate, name);
    const staged = decoder.decode(await fs.readBytes(paths.join(folder, 'SKILL.md') as AbsPath));
    const prefix = this.#prefix();
    const clash = this.#clash(session, candidate);
    const issues: Issue[] = facts
      ? [
          ...layoutIssues(facts),
          ...headerIssues(facts, prefix),
          ...symlinkIssues(facts),
          ...skillLengthIssues(facts),
          ...fileSizeIssues(facts),
          ...markdownLinkIssues(facts),
        ]
      : [];
    if (clash !== null) issues.push(issue('skill.nameTaken', `skills/${name}`, { name, where: clash }, name));
    const oldNames = session.candidates.filter((c) => c.oldName !== c.name).map((c) => c.oldName);
    const mentions: Mention[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'file' || !/\.(md|markdown|txt)$/i.test(entry.path) || entry.size > 1024 * 1024) continue;
      const text = decoder.decode(await fs.readBytes(paths.join(folder, ...entry.path.split('/')) as AbsPath));
      mentions.push(...mentionsOf(entry.path, text, oldNames));
    }
    const header = readSkillHeader(staged);
    return {
      candidate: this.#candidateView(session, candidate),
      original: candidate.original,
      staged,
      files: entries.map((entry) => ({
        path: entry.path,
        kind: entry.kind === 'dir' ? 'dir' : entry.kind === 'link' ? 'link' : 'file',
        size: entry.kind === 'file' ? entry.size : 0,
      })),
      flags: skillFlags(entries, header.status === 'ok' ? header.fields : null),
      issues,
      mentions,
    };
  }

  async #rename(id: string, name: string): Promise<ImportReview> {
    const { fs, paths } = this.#deps;
    const session = this.#current();
    const candidate = this.#candidate(session, id);
    if (!nameUsable(name, this.#prefix())) throw new AppError('import.nameInvalid', { name });
    if (candidate.staged !== null && candidate.staged !== name) {
      const from = this.#stagedPath(session, candidate, candidate.staged);
      const to = this.#stagedPath(session, candidate, name);
      await fs.rename(from, to);
      const file = paths.join(to, 'SKILL.md') as AbsPath;
      const edited = editSkillMd(decoder.decode(await fs.readBytes(file)), { name });
      if (edited.ok) await fs.writeTextAtomic(file, edited.text);
      candidate.staged = name;
    }
    candidate.name = name;
    this.#changed();
    return candidate.staged === null ? this.#review(id) : this.#reviewOf(session, candidate);
  }

  async #readFile(id: string, path: string): Promise<ImportFile> {
    const { fs } = this.#deps;
    const at = this.#stagedFile(id, path);
    const entry = await fs.lstat(at);
    if (entry?.kind !== 'file') throw new AppError('editor.notFound', { path });
    const bytes = await fs.readBytes(at);
    const kind = fileKind(path, bytes);
    return {
      path,
      kind,
      text: kind === 'markdown' || kind === 'text' ? decoder.decode(bytes) : null,
      size: bytes.length,
      hash: blobId(bytes),
    };
  }

  /** The reviewer's edits (PLAN.md §3.18 "The reviewer can edit the content during the review"), saved as in the editor. */
  async #save(id: string, path: string, text: string, base: string | null) {
    const { fs } = this.#deps;
    const at = this.#stagedFile(id, path);
    const entry = await fs.lstat(at);
    if (entry?.kind !== 'file') throw new AppError('editor.notEditable', { path });
    const current = await fs.readBytes(at);
    const currentHash = blobId(current);
    if (currentHash !== base) throw new AppError('editor.changedOnDisk', { path });
    const kind = fileKind(path, current);
    if (kind !== 'markdown' && kind !== 'text') throw new AppError('editor.notText', { path });
    const hash = blobId(encoder.encode(text));
    if (hash === currentHash) return { hash, written: false };
    await fs.writeTextAtomic(at, text);
    this.#changed();
    return { hash, written: true };
  }

  // ---- Adding ----------------------------------------------------------------------------------------------------

  async #add(ids: readonly string[]): Promise<ImportReport> {
    const { fs, links, paths, store, logger } = this.#deps;
    const session = this.#current();
    if (ids.length === 0) throw new AppError('import.nothingSelected', {});
    const chosen = [...new Set(ids)].map((id) => this.#candidate(session, id));
    const gate = reviewGate(
      chosen.map((c) => c.id),
      new Set(chosen.filter((c) => c.opened && c.staged !== null).map((c) => c.id)),
    );
    if (!gate.canAdd) throw new AppError('import.notReviewed', { waiting: gate.waiting.join(', ') });
    const names = new Set<string>();
    for (const candidate of chosen) {
      const key = candidate.name.toLowerCase();
      if (names.has(key) || (await this.#taken(candidate.name))) {
        throw new AppError('import.nameTaken', { name: candidate.name });
      }
      names.add(key);
    }
    const library = this.#deps.libraryRoot();
    for (const candidate of chosen) {
      const from = this.#stagedPath(session, candidate, candidate.staged ?? candidate.name);
      const to = paths.join(library, 'skills', candidate.name) as AbsPath;
      await mirrorFolder({ fs, links, paths }, from, to);
    }
    const record = (candidate: Candidate) =>
      sourceRecord({ ...session.facts, path: joinRepoPath(session.facts.path, candidate.foundAt) });
    store.write((tx) => {
      if (session.replaceable) {
        const settings = tx.settings.get();
        const originals = [
          ...settings.importedOriginals.filter((entry) => !chosen.some((c) => c.name === entry.skill)),
          ...chosen.map((c) => ({ skill: c.name, path: this.#sourcePath(session, c.foundAt) })),
        ];
        tx.settings.set({ ...settings, importedOriginals: originals.slice(-1000) });
      }
      this.#deps.activity.appendIn(
        tx,
        chosen.map((candidate) => ({
          kind: 'imported' as const,
          path: `skills/${candidate.name}`,
          details: { from: session.source.kind, source: record(candidate), oldName: candidate.oldName },
        })),
      );
    });
    logger.info('skills imported', { kind: session.source.kind, count: chosen.length });
    const report: ImportReport = {
      added: chosen.map((c) => ({ name: c.name, foundAt: c.foundAt })),
      notImported: session.notImported,
      source: session.source,
    };
    await this.#cancel();
    this.#deps.skillsChanged('skills imported');
    return report;
  }

  async #cancel(): Promise<void> {
    const session = this.#session;
    this.#setSession(null);
    if (!session) return;
    await this.#deps.fs.removeTree(session.dir).catch((error: unknown) => {
      this.#deps.logger.warn('an import folder was not removed', { error: String(error) });
    });
    this.#changed();
  }

  // ---- Replacing the original ------------------------------------------------------------------------------------

  async #replace(skill: string): Promise<void> {
    const { fs, store, trash, logger } = this.#deps;
    const entry = this.#settings().importedOriginals.find((e) => e.skill === skill);
    if (!entry) throw new AppError('import.unknownSkill', { skill });
    if (!(await this.#deps.inCompany(skill))) throw new AppError('import.notInCompany', { skill });
    const original = entry.path as AbsPath;
    if (!(await fs.lstat(original))) {
      this.#forget(skill);
      throw new AppError('import.originalGone', { skill });
    }
    // Into the trash for 30 days (PLAN.md §3.18): it can be restored from the activity log.
    const kept = await trash.put(original, 'imported-original', skill);
    store.write((tx) => {
      const settings = tx.settings.get();
      tx.settings.set({
        ...settings,
        importedOriginals: settings.importedOriginals.filter((e) => e.skill !== skill),
      });
      this.#deps.activity.appendIn(tx, [
        { kind: 'imported', path: `skills/${skill}`, details: { replacedOriginal: true, trashId: kept.id } },
      ]);
    });
    logger.info('the original of an imported skill was replaced', { skill });
    this.#changed();
    this.#deps.skillsChanged('original replaced');
  }

  async #keep(skill: string): Promise<void> {
    this.#forget(skill);
    this.#changed();
  }

  #forget(skill: string): void {
    this.#roots = null;
    this.#deps.store.write((tx) => {
      const settings = tx.settings.get();
      tx.settings.set({
        ...settings,
        importedOriginals: settings.importedOriginals.filter((e) => e.skill !== skill),
      });
    });
  }

  // ---- Helpers ---------------------------------------------------------------------------------------------------

  #settings(): InstanceSettings {
    return this.#deps.store.read((tx) => tx.settings.get());
  }

  #prefix(): string {
    const prefix = this.#deps.snapshot()?.config.prefix ?? null;
    if (prefix === null) throw new AppError('feature.unavailable', { feature: 'import' });
    return prefix;
  }

  #current(): Session {
    if (!this.#session) throw new AppError('import.noSession', {});
    return this.#session;
  }

  #candidate(session: Session, id: string): Candidate {
    const found = session.candidates.find((c) => c.id === id);
    if (!found) throw new AppError('import.unknownSkill', { skill: id });
    return found;
  }

  #sourcePath(session: Session, relative: string): AbsPath {
    return relative === '' ? session.root : (this.#deps.paths.join(session.root, ...relative.split('/')) as AbsPath);
  }

  #stagedPath(session: Session, candidate: Candidate, name: string): AbsPath {
    return this.#deps.paths.join(session.dir, 'staged', candidate.id, 'skills', name) as AbsPath;
  }

  /** A file of a staged skill, by its path in the skill: never outside its folder. */
  #stagedFile(id: string, path: string): AbsPath {
    const { paths } = this.#deps;
    const session = this.#current();
    const candidate = this.#candidate(session, id);
    if (candidate.staged === null) throw new AppError('import.notReviewed', { waiting: id });
    const parts = path.split('/');
    if (path === '' || parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
      throw new AppError('editor.notEditable', { path });
    }
    const folder = this.#stagedPath(session, candidate, candidate.staged);
    const at = paths.join(folder, ...parts) as AbsPath;
    if (!paths.isInside(folder, at) || paths.same(folder, at)) throw new AppError('editor.notEditable', { path });
    return at;
  }

  #clash(session: Session, candidate: Candidate): 'library' | 'import' | null {
    const key = candidate.name.toLowerCase();
    if ((this.#deps.snapshot()?.skills ?? []).some((s) => s.folder.toLowerCase() === key)) return 'library';
    return session.candidates.some((c) => c !== candidate && c.name.toLowerCase() === key) ? 'import' : null;
  }

  /** A skill folder of that name exists in the library, in any letter case (PLAN.md §1.5). */
  async #taken(name: string): Promise<boolean> {
    const { fs, paths } = this.#deps;
    const skills = paths.join(this.#deps.libraryRoot(), 'skills') as AbsPath;
    if ((await fs.lstat(skills))?.kind !== 'dir') return false;
    return (await fs.list(skills)).some((entry) => entry.toLowerCase() === name.toLowerCase());
  }

  #candidateView(session: Session, c: Candidate): ImportCandidate {
    return {
      id: c.id,
      foundAt: c.foundAt,
      layout: c.layout,
      oldName: c.oldName,
      name: c.name,
      fixed: c.fixed,
      scripts: c.scripts,
      allowedTools: c.allowedTools,
      clash: this.#clash(session, c),
      opened: c.opened,
    };
  }

  #view(session: Session): ImportSessionView {
    return {
      id: session.id,
      source: session.source,
      candidates: session.candidates.map((c) => this.#candidateView(session, c)),
      notImported: session.notImported,
      record: sourceRecord(session.facts),
      replaceable: session.replaceable,
    };
  }
}

/** A session while its source is opened: only the picked path matters then (roots()). */
function placeholder(dir: AbsPath, picked: AbsPath): Session {
  return {
    id: '',
    dir,
    source: { kind: 'folder', label: '' },
    root: picked,
    picked,
    facts: { remote: null, commit: null, path: '' },
    replaceable: false,
    candidates: [],
    notImported: [],
  };
}

const joinRepoPath = (base: string, relative: string) =>
  base === '' ? relative : relative === '' ? base : `${base}/${relative}`;

/**
 * SKILL.md with the imported name and `metadata.source` (PLAN.md §3.18). A file without a header gets one; a header the
 * app can't edit safely stays as it is, and the review shows its problem.
 */
export function withImportHeader(text: string, name: string, record: string | null): string {
  const edited = editSkillMd(text, { name, ...(record === null ? {} : { source: record }) });
  if (edited.ok) return edited.text;
  if (edited.problem !== 'noHeader') return text;
  const source = record === null ? '' : `metadata:\n  source: ${JSON.stringify(record)}\n`;
  return `---\nname: ${name}\n${source}---\n\n${text}`;
}
