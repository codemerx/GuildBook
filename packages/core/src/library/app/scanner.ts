// The scanner (IMPLEMENTATION.md Step 2): reads a LibrarySource into LibraryFacts, the raw material of the snapshot.
// A full scan reads everything; a refresh rescans only the parts the changed paths touch: library.yaml, instructions/,
// one skill folder, or the rest of the library. Links are read as links, never followed (PLAN.md §3.15).
import { LIBRARY_FILE, readSkillHeader } from '@app/schemas';
import { blobId, isFingerprintJunk, linkBlobId } from '../domain/fingerprint.ts';
import { markdownLinks } from '../domain/markdown-links.ts';
import type { EntryFacts, SkillFacts } from '../domain/rules.ts';
import {
  fingerprintOf,
  INSTRUCTIONS_DIR,
  INSTRUCTIONS_FILE,
  type LibraryFacts,
  SKILLS_DIR,
} from '../domain/snapshot.ts';
import type { LibrarySource } from './source.ts';

/** Markdown files larger than this aren't searched for links. */
export const MARKDOWN_SCAN_MAX = 1024 * 1024;

export interface ScanOptions {
  /**
   * The executable bit by library path, where the source can't tell (Windows has none): there, a file's mode is taken
   * from the library's git index (PLAN.md §3.8; Step 3 provides it). Undefined means "as the source says".
   */
  readonly executableFrom?: (path: string) => boolean | undefined;
  readonly signal?: AbortSignal;
}

const decoder = new TextDecoder();
/** Facts are kept sorted by path, whatever order a source lists in, so a refresh and a full scan compare equal. */
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const join = (base: string, name: string) => (base === '' ? name : `${base}/${name}`);

interface Walked {
  readonly entries: EntryFacts[];
  readonly texts: Map<string, string>;
}

/**
 * Every entry below `base` (exclusive), relative to `base`, sorted. Files are hashed as git blobs; Markdown files up
 * to MARKDOWN_SCAN_MAX are decoded for their links. `.DS_Store` and `Thumbs.db` are skipped (PLAN.md §3.8).
 */
async function walk(source: LibrarySource, base: string, options: ScanOptions): Promise<Walked> {
  const entries: EntryFacts[] = [];
  const texts = new Map<string, string>();
  async function visit(relative: string): Promise<void> {
    options.signal?.throwIfAborted();
    const names = await source.list(join(base, relative));
    for (const name of names ?? []) {
      if (isFingerprintJunk(name)) continue;
      const path = join(relative, name);
      const full = join(base, path);
      const stat = await source.stat(full);
      if (!stat) continue;
      const executable = stat.kind === 'file' && (options.executableFrom?.(full) ?? stat.executable);
      if (stat.kind === 'file') {
        const bytes = await source.readBytes(full);
        entries.push({ path, kind: 'file', size: bytes.length, executable, target: null, blob: blobId(bytes) });
        if (/\.md$/i.test(name) && bytes.length <= MARKDOWN_SCAN_MAX) texts.set(path, decoder.decode(bytes));
      } else if (stat.kind === 'link') {
        const target = await source.readLink(full);
        entries.push({ path, kind: 'link', size: stat.size, executable: false, target, blob: linkBlobId(target) });
      } else {
        entries.push({ path, kind: stat.kind, size: 0, executable: false, target: null, blob: null });
        if (stat.kind === 'dir') await visit(path);
      }
    }
  }
  await visit('');
  entries.sort((a, b) => byPath(a.path, b.path));
  return { entries, texts };
}

/**
 * A folder's fingerprint: git's tree id of its content (PLAN.md §3.8), e.g. a real folder found at a link path (S4).
 * On Windows, pass `executableFrom` so a file's mode comes from the library.
 */
export async function fingerprintFolder(
  source: LibrarySource,
  path: string,
  options: ScanOptions = {},
): Promise<string> {
  return fingerprintOf((await walk(source, path, options)).entries);
}

/** One `skills/<folder>`, or undefined when nothing is there any more. */
export async function scanSkill(
  source: LibrarySource,
  folder: string,
  options: ScanOptions = {},
): Promise<SkillFacts | undefined> {
  const path = join(SKILLS_DIR, folder);
  const stat = await source.stat(path);
  if (!stat) return undefined;
  if (stat.kind !== 'dir') return { folder, kind: stat.kind, header: null, entries: [], links: [] };
  const { entries, texts } = await walk(source, path, options);
  const skillMd = entries.find((entry) => entry.path === 'SKILL.md' && entry.kind === 'file');
  const text = skillMd
    ? (texts.get('SKILL.md') ?? decoder.decode(await source.readBytes(join(path, 'SKILL.md'))))
    : null;
  const header = text === null ? null : readSkillHeader(text);
  const links = [...texts.entries()].flatMap(([file, text]) =>
    markdownLinks(text).map((link) => ({ file, line: link.line, target: link.target })),
  );
  return {
    folder,
    kind: 'dir',
    header,
    entries,
    links,
    ...(text === null ? {} : { skillMdLines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0) }),
  };
}

async function scanConfig(source: LibrarySource): Promise<string | null> {
  const stat = await source.stat(LIBRARY_FILE);
  return stat?.kind === 'file' ? decoder.decode(await source.readBytes(LIBRARY_FILE)) : null;
}

async function scanInstructions(
  source: LibrarySource,
  options: ScanOptions,
): Promise<Pick<LibraryFacts, 'instructions' | 'agents'>> {
  const stat = await source.stat(INSTRUCTIONS_DIR);
  if (!stat) return { instructions: [], agents: null };
  const own: EntryFacts = {
    path: INSTRUCTIONS_DIR,
    kind: stat.kind,
    size: 0,
    executable: false,
    target: null,
    blob: null,
  };
  if (stat.kind !== 'dir') return { instructions: [own], agents: null };
  const { entries } = await walk(source, INSTRUCTIONS_DIR, options);
  const agentsStat = await source.stat(INSTRUCTIONS_FILE);
  let agents: LibraryFacts['agents'] = null;
  if (agentsStat?.kind === 'file') {
    const bytes = await source.readBytes(INSTRUCTIONS_FILE);
    agents = { bytes: bytes.length, characters: [...decoder.decode(bytes)].length };
  }
  return {
    instructions: [own, ...entries.map((entry) => ({ ...entry, path: join(INSTRUCTIONS_DIR, entry.path) }))],
    agents,
  };
}

async function scanSkills(
  source: LibrarySource,
  options: ScanOptions,
): Promise<Pick<LibraryFacts, 'skillsDir' | 'skills'>> {
  const stat = await source.stat(SKILLS_DIR);
  if (!stat) return { skillsDir: 'missing', skills: [] };
  if (stat.kind !== 'dir') return { skillsDir: 'other', skills: [] };
  const skills: SkillFacts[] = [];
  for (const folder of (await source.list(SKILLS_DIR)) ?? []) {
    if (isFingerprintJunk(folder)) continue;
    const skill = await scanSkill(source, folder, options);
    if (skill) skills.push(skill);
  }
  return { skillsDir: 'dir', skills: skills.sort((a, b) => byPath(a.folder, b.folder)) };
}

const OWN_ROOT_ENTRIES = new Set(['.git', LIBRARY_FILE, INSTRUCTIONS_DIR, SKILLS_DIR]);

async function scanOthers(source: LibrarySource, options: ScanOptions): Promise<EntryFacts[]> {
  const others: EntryFacts[] = [];
  for (const name of (await source.list('')) ?? []) {
    if (OWN_ROOT_ENTRIES.has(name) || isFingerprintJunk(name)) continue;
    const stat = await source.stat(name);
    if (!stat) continue;
    others.push({ path: name, kind: stat.kind, size: stat.size, executable: false, target: null, blob: null });
    if (stat.kind === 'dir') {
      const { entries } = await walk(source, name, options);
      others.push(...entries.map((entry) => ({ ...entry, path: join(name, entry.path) })));
    }
  }
  return others.sort((a, b) => byPath(a.path, b.path));
}

export async function scanLibrary(source: LibrarySource, options: ScanOptions = {}): Promise<LibraryFacts> {
  return {
    config: await scanConfig(source),
    ...(await scanInstructions(source, options)),
    ...(await scanSkills(source, options)),
    others: await scanOthers(source, options),
  };
}

/** Which parts of the library a set of changed paths touches. */
export interface Affected {
  readonly all: boolean;
  readonly config: boolean;
  readonly instructions: boolean;
  /** The skills/ folder itself changed: every skill is rescanned. */
  readonly skillsDir: boolean;
  readonly skills: ReadonlySet<string>;
  readonly others: boolean;
}

/** Paths are relative to the library, with forward slashes. Changes inside `.git` don't touch the snapshot. */
export function affectedBy(paths: readonly string[]): Affected {
  let all = false;
  let config = false;
  let instructions = false;
  let skillsDir = false;
  let others = false;
  const skills = new Set<string>();
  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '');
    const [first = '', second] = path.split('/');
    if (path === '') all = true;
    else if (first === '.git') continue;
    else if (path === LIBRARY_FILE) config = true;
    else if (first === INSTRUCTIONS_DIR) instructions = true;
    else if (first === SKILLS_DIR) {
      if (second === undefined) skillsDir = true;
      else skills.add(second);
    } else others = true;
  }
  return { all, config, instructions, skillsDir, skills, others };
}

/** Rescans only what the changed paths touch. Equal to a full scan of the same source (A2.6). */
export async function refreshLibrary(
  source: LibrarySource,
  previous: LibraryFacts,
  changed: readonly string[],
  options: ScanOptions = {},
): Promise<LibraryFacts> {
  const affected = affectedBy(changed);
  if (affected.all) return scanLibrary(source, options);
  let next: LibraryFacts = previous;
  if (affected.config) next = { ...next, config: await scanConfig(source) };
  if (affected.instructions) next = { ...next, ...(await scanInstructions(source, options)) };
  if (affected.skillsDir) next = { ...next, ...(await scanSkills(source, options)) };
  else if (affected.skills.size > 0) {
    const stat = await source.stat(SKILLS_DIR);
    if (stat?.kind !== 'dir') next = { ...next, skillsDir: stat ? 'other' : 'missing', skills: [] };
    else {
      const byFolder = new Map(next.skills.map((skill) => [skill.folder, skill]));
      for (const folder of affected.skills) {
        const skill = isFingerprintJunk(folder) ? undefined : await scanSkill(source, folder, options);
        if (skill) byFolder.set(folder, skill);
        else byFolder.delete(folder);
      }
      const skills = [...byFolder.values()].sort((a, b) => byPath(a.folder, b.folder));
      next = { ...next, skillsDir: 'dir', skills };
    }
  }
  if (affected.others) next = { ...next, others: await scanOthers(source, options) };
  return next;
}
