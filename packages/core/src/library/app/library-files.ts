// The editor's use cases on the library's files (PLAN.md §3.14, IMPLEMENTATION.md Step 10): open a file, save it,
// create a skill from a template, add and delete a skill's files, rename a skill. Every change is a command in the
// instance's queue (§2.4), and every write is atomic through the guarded file system (§2.10). A save names the version
// it was based on; when the file changed on disk since, it's refused and the editor asks which to keep (A10.4).
import { editSkillMd, skillNameProblems, tagProblems } from '@app/schemas';
import { defineCommand, defineQuery, type InstanceEngine } from '../../engine/index.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Logger } from '../../ports/logger.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import {
  type DropFolder,
  editablePath,
  type FileKind,
  fileKind,
  fileNameOk,
  fileSizeRule,
} from '../domain/editable.ts';
import { blobId } from '../domain/fingerprint.ts';
import type { LibrarySnapshot } from '../domain/snapshot.ts';
import { type NewSkill, skillFiles } from '../domain/templates.ts';

export interface LibraryFile {
  /** Relative to the library, with forward slashes. */
  readonly path: string;
  readonly kind: FileKind;
  /** The text, for Markdown and other text files; null for images and binaries. */
  readonly text: string | null;
  readonly size: number;
  /** The version on disk: git's blob id of its bytes. A save names it as its base. */
  readonly hash: string;
}

export interface SkillFileEntry {
  /** Relative to the skill's folder. */
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'link';
  readonly size: number;
}

export interface SaveResult {
  readonly hash: string;
  /** False when the text was the same as on disk: nothing was written. */
  readonly written: boolean;
}

export interface AddFileResult {
  readonly path: string;
  /** Over 10 MB: added, with a warning (PLAN.md §3.19). */
  readonly large: boolean;
}

type ReadInput = { readonly path: string };

export const ReadLibraryFile = defineQuery<ReadInput, LibraryFile>('ReadLibraryFile');
export const SkillFilesQuery = defineQuery<{ readonly skill: string }, SkillFileEntry[]>('SkillFiles');
export const SaveLibraryFile = defineCommand<
  { readonly path: string; readonly text: string; readonly base: string | null },
  SaveResult
>('SaveLibraryFile');
export const CreateSkill = defineCommand<NewSkill, { readonly folder: string }>('CreateSkill');
export const AddSkillFile = defineCommand<
  {
    readonly skill: string;
    readonly folder: DropFolder | null;
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly replace: boolean;
  },
  AddFileResult
>('AddSkillFile');
export const DeleteSkillFile = defineCommand<{ readonly path: string }, void>('DeleteSkillFile');
export const RenameSkill = defineCommand<{ readonly from: string; readonly to: string }, { readonly folder: string }>(
  'RenameSkill',
);

export interface LibraryFilesDeps {
  readonly engine: InstanceEngine;
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly logger: Logger;
  readonly root: () => string;
  readonly snapshot: () => LibrarySnapshot | null;
  /** A skill was renamed in the editor: its placement choices and links move with it (PLAN.md §3.10, A10.8). */
  readonly renamed: (from: string, to: string) => void;
  /** Skills were created or renamed: the link check runs, so they get linked (A10.6). */
  readonly skillsChanged: (reason: string) => void;
  /** An entry for the activity log (PLAN.md §3.13), written inside the command. */
  readonly record?: (entry: EditorActivity) => void;
}

/** What the editor's commands add to the activity log: a skill created on this device, or renamed. */
export type EditorActivity =
  | { readonly kind: 'modified-locally'; readonly path: string; readonly details: { readonly created: string } }
  | {
      readonly kind: 'renamed';
      readonly path: string;
      readonly details: { readonly from: string; readonly to: string };
    };

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();

export class LibraryFiles {
  readonly #deps: LibraryFilesDeps;

  constructor(deps: LibraryFilesDeps) {
    this.#deps = deps;
    const { engine } = deps;
    engine.handleQuery(ReadLibraryFile, ({ path }) => this.read(path));
    engine.handleQuery(SkillFilesQuery, ({ skill }) => this.skillFiles(skill));
    engine.handle(SaveLibraryFile, ({ path, text, base }) => this.#save(path, text, base));
    engine.handle(CreateSkill, (input) => this.#create(input));
    engine.handle(AddSkillFile, (input) => this.#addFile(input));
    engine.handle(DeleteSkillFile, ({ path }) => this.#delete(path));
    engine.handle(RenameSkill, ({ from, to }) => this.#rename(from, to));
  }

  async read(path: string): Promise<LibraryFile> {
    const at = this.#at(path);
    const entry = await this.#deps.fs.lstat(at);
    if (entry?.kind !== 'file') throw new AppError('editor.notFound', { path });
    const bytes = await this.#deps.fs.readBytes(at);
    const kind = fileKind(path, bytes);
    return {
      path,
      kind,
      text: kind === 'markdown' || kind === 'text' ? decoder.decode(bytes) : null,
      size: bytes.length,
      hash: blobId(bytes),
    };
  }

  /** A skill's files and folders, sorted, without following links (PLAN.md §3.15). */
  async skillFiles(skill: string): Promise<SkillFileEntry[]> {
    const { fs, paths } = this.#deps;
    const folder = this.#at(`skills/${skill}/SKILL.md`, { skillFolder: true });
    if ((await fs.lstat(folder))?.kind !== 'dir') throw new AppError('editor.notFound', { path: `skills/${skill}` });
    const found: SkillFileEntry[] = [];
    const visit = async (relative: string): Promise<void> => {
      const dir = (relative === '' ? folder : paths.join(folder, ...relative.split('/'))) as AbsPath;
      for (const name of await fs.list(dir)) {
        if (name === '.git') continue;
        const child = relative === '' ? name : `${relative}/${name}`;
        const entry = await fs.lstat(paths.join(folder, ...child.split('/')) as AbsPath);
        if (!entry) continue;
        const kind = entry.kind === 'dir' ? 'dir' : entry.kind === 'link' ? 'link' : 'file';
        found.push({ path: child, kind, size: kind === 'file' ? entry.size : 0 });
        if (kind === 'dir') await visit(child);
      }
    };
    await visit('');
    return found;
  }

  async #save(path: string, text: string, base: string | null): Promise<SaveResult> {
    const { fs } = this.#deps;
    const at = this.#at(path);
    const entry = await fs.lstat(at);
    if (entry && entry.kind !== 'file') throw new AppError('editor.notEditable', { path });
    const current = entry ? await fs.readBytes(at) : null;
    const currentHash = current ? blobId(current) : null;
    if (currentHash !== base) throw new AppError('editor.changedOnDisk', { path });
    if (current && fileKind(path, current) !== 'markdown' && fileKind(path, current) !== 'text') {
      throw new AppError('editor.notText', { path });
    }
    const bytes = encoder.encode(text);
    const hash = blobId(bytes);
    if (hash === currentHash) return { hash, written: false };
    await fs.mkdirp(this.#deps.paths.dirname(at) as AbsPath);
    await fs.writeTextAtomic(at, text);
    return { hash, written: true };
  }

  async #create(skill: NewSkill): Promise<{ folder: string }> {
    const { fs, paths } = this.#deps;
    const prefix = this.#prefix();
    this.#checkName(skill.name, prefix);
    for (const tag of skill.tags)
      if (tagProblems(tag).length > 0) throw new AppError('editor.nameInvalid', { name: tag });
    const folder = this.#at(`skills/${skill.name}/SKILL.md`, { skillFolder: true });
    if (await this.#taken(skill.name)) throw new AppError('editor.skillExists', { name: skill.name });
    for (const [relative, text] of Object.entries(skillFiles(skill, prefix))) {
      const file = paths.join(folder, ...relative.split('/')) as AbsPath;
      await fs.mkdirp(paths.dirname(file) as AbsPath);
      await fs.writeTextAtomic(file, text);
    }
    this.#deps.logger.info('skill created', { skill: skill.name, template: skill.template });
    this.#deps.record?.({
      kind: 'modified-locally',
      path: `skills/${skill.name}`,
      details: { created: skill.template },
    });
    this.#deps.skillsChanged('skill created');
    return { folder: skill.name };
  }

  async #addFile(input: {
    skill: string;
    folder: DropFolder | null;
    name: string;
    bytes: Uint8Array;
    replace: boolean;
  }): Promise<AddFileResult> {
    const { fs, paths } = this.#deps;
    if (!fileNameOk(input.name)) throw new AppError('editor.notEditable', { path: input.name });
    const path = `skills/${input.skill}/${input.folder === null ? '' : `${input.folder}/`}${input.name}`;
    const at = this.#at(path);
    if (path === `skills/${input.skill}/SKILL.md`) throw new AppError('editor.notEditable', { path });
    const skillFolder = this.#at(`skills/${input.skill}/SKILL.md`, { skillFolder: true });
    if ((await fs.lstat(skillFolder))?.kind !== 'dir') throw new AppError('editor.notFound', { path: input.skill });
    const rule = fileSizeRule(input.bytes.length);
    if (rule === 'tooLarge') throw new AppError('editor.fileTooLarge', { name: input.name });
    const existing = await fs.lstat(at);
    if (existing && (!input.replace || existing.kind !== 'file')) {
      throw new AppError('editor.fileExists', { name: input.name });
    }
    await fs.mkdirp(paths.dirname(at) as AbsPath);
    await fs.writeBytesAtomic(at, input.bytes);
    return { path, large: rule === 'large' };
  }

  async #delete(path: string): Promise<void> {
    const target = editablePath(path);
    if (target?.kind !== 'skill' || target.file === 'SKILL.md') throw new AppError('editor.notEditable', { path });
    const at = this.#at(path);
    const entry = await this.#deps.fs.lstat(at);
    if (!entry) throw new AppError('editor.notFound', { path });
    if (entry.kind === 'dir') throw new AppError('editor.notEditable', { path });
    // Inside the library, git keeps every committed version: deleting is an ordinary change (PLAN.md §3.10).
    await this.#deps.fs.remove(at);
  }

  async #rename(from: string, to: string): Promise<{ folder: string }> {
    const { fs, paths } = this.#deps;
    if (from === to) return { folder: to };
    this.#checkName(to, this.#prefix());
    const oldFolder = this.#at(`skills/${from}/SKILL.md`, { skillFolder: true });
    const newFolder = this.#at(`skills/${to}/SKILL.md`, { skillFolder: true });
    if ((await fs.lstat(oldFolder))?.kind !== 'dir') throw new AppError('editor.notFound', { path: `skills/${from}` });
    if (await this.#taken(to)) throw new AppError('editor.skillExists', { name: to });
    // The `name:` line changes with the folder; a header the edit can't read stops the rename before anything moves.
    const skillMd = paths.join(oldFolder, 'SKILL.md') as AbsPath;
    const text = decoder.decode(await fs.readBytes(skillMd));
    const edited = editSkillMd(text, { name: to });
    if (!edited.ok) throw new AppError('editor.headerUnreadable', { path: `skills/${from}/SKILL.md` });
    await fs.rename(oldFolder, newFolder);
    await fs.writeTextAtomic(paths.join(newFolder, 'SKILL.md') as AbsPath, edited.text);
    this.#deps.logger.info('skill renamed', { from, to });
    this.#deps.renamed(from, to);
    this.#deps.record?.({ kind: 'renamed', path: `skills/${to}`, details: { from, to } });
    this.#deps.skillsChanged('skill renamed');
    return { folder: to };
  }

  #prefix(): string | null {
    return this.#deps.snapshot()?.config.prefix ?? null;
  }

  #checkName(name: string, prefix: string | null): void {
    const problems = prefix === null ? ['skillName.prefix'] : skillNameProblems(name, prefix);
    if (problems.length > 0) throw new AppError('editor.nameInvalid', { name });
  }

  /** A skill folder of that name exists, in any letter case: macOS and Windows would see one folder (PLAN.md §1.5). */
  async #taken(name: string): Promise<boolean> {
    const { fs, paths } = this.#deps;
    const skills = paths.join(this.#deps.root(), 'skills') as AbsPath;
    if (!(await fs.lstat(skills))) return false;
    return (await fs.list(skills)).some((entry) => entry.toLowerCase() === name.toLowerCase());
  }

  /** The absolute path of an editable library path; the skill's folder itself with `skillFolder`. */
  #at(path: string, options: { skillFolder?: boolean } = {}): AbsPath {
    const target = editablePath(path);
    if (!target) throw new AppError('editor.notEditable', { path });
    const { paths } = this.#deps;
    const segments = path.split('/');
    const at = paths.join(this.#deps.root(), ...(options.skillFolder ? segments.slice(0, 2) : segments)) as AbsPath;
    if (!paths.isInside(this.#deps.root(), at)) throw new AppError('editor.notEditable', { path });
    return at;
  }
}
