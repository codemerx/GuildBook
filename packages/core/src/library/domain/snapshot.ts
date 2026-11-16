// The library snapshot (IMPLEMENTATION.md Step 2): the skills, their headers and tags, the instructions and every
// validation issue, built by a pure function from what the scanner found. Everything that depends on more than one
// file (the prefix from library.yaml, letter-case conflicts across the library) is computed here, so an incremental
// refresh only has to rescan what changed and still equals a full scan (A2.6).
import { LIBRARY_FILE, tagProblems, tagsOf } from '@app/schemas';
import { type Compatibility, type LibraryConfig, readLibraryConfig } from './library-config.ts';
import { compareIssues, compareText, type Issue } from './issues.ts';
import { type FileMode, treeId } from './fingerprint.ts';
import { localName, type Prefix } from './names.ts';
import {
  caseConflictIssues,
  type EntryFacts,
  fileSizeIssues,
  headerIssues,
  type InstructionLimit,
  instructionIssues,
  layoutIssues,
  markdownLinkIssues,
  skillLengthIssues,
  type SkillFacts,
  symlinkIssues,
  windowsPathIssues,
} from './rules.ts';

export const SKILLS_DIR = 'skills';
export const INSTRUCTIONS_DIR = 'instructions';
export const INSTRUCTIONS_FILE = 'instructions/AGENTS.md';

/** Everything the scanner found, per part of the library, so each part can be rescanned on its own. */
export interface LibraryFacts {
  /** library.yaml's text, or null when it's missing. */
  readonly config: string | null;
  /** Entries under instructions/, relative to the library. */
  readonly instructions: readonly EntryFacts[];
  /** instructions/AGENTS.md's size, when it exists. */
  readonly agents: { readonly bytes: number; readonly characters: number } | null;
  /** What `skills` is at the library's root. */
  readonly skillsDir: 'dir' | 'missing' | 'other';
  /** One entry per name in skills/, sorted by folder. */
  readonly skills: readonly SkillFacts[];
  /** Everything else (not .git), relative to the library: only their paths matter, for the letter-case check. */
  readonly others: readonly EntryFacts[];
}

export interface SnapshotContext {
  readonly appVersion: string;
  readonly platform: 'darwin' | 'win32' | 'linux';
  /** The library folder's absolute path, for the Windows path-length check. */
  readonly libraryRoot: string;
  /** Set when the instance has a local prefix: where its projected copies live (PLAN.md §3.3). */
  readonly projection: { readonly root: string; readonly localPrefix: string } | null;
  readonly instructionLimits: readonly InstructionLimit[];
}

export interface SkillSummary {
  readonly folder: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly source: string | null;
  readonly allowedTools: string | null;
  readonly files: number;
  readonly bytes: number;
  /** Whether it has a `scripts/` folder (flagged in previews, PLAN.md §3.15). */
  readonly scripts: boolean;
  /** git's tree id of the skill folder (PLAN.md §3.8). */
  readonly fingerprint: string;
}

export interface LibrarySnapshot {
  readonly config: Omit<LibraryConfig, 'issues'>;
  readonly compatibility: Compatibility;
  readonly skills: readonly SkillSummary[];
  readonly instructions: { readonly path: string; readonly bytes: number; readonly characters: number } | null;
  /** Every valid tag the skills carry, with the skill folders that carry it, sorted by tag. */
  readonly tags: ReadonlyArray<{ readonly tag: string; readonly skills: readonly string[] }>;
  readonly issues: readonly Issue[];
}

function modeOf(entry: EntryFacts): FileMode {
  if (entry.kind === 'link') return '120000';
  return entry.executable ? '100755' : '100644';
}

/** A folder's fingerprint from its entries (PLAN.md §3.8). */
export function fingerprintOf(entries: readonly EntryFacts[]): string {
  return treeId(
    entries.flatMap((entry) =>
      (entry.kind === 'file' || entry.kind === 'link') && entry.blob !== null
        ? [{ path: entry.path, mode: modeOf(entry), blob: entry.blob }]
        : [],
    ),
  );
}

function summarize(skill: SkillFacts): SkillSummary {
  const fields = skill.header?.status === 'ok' ? skill.header.fields : {};
  const text = (key: string) => (typeof fields[key] === 'string' ? fields[key] : null);
  const metadata =
    typeof fields.metadata === 'object' && fields.metadata !== null ? (fields.metadata as Record<string, unknown>) : {};
  const files = skill.entries.filter((entry) => entry.kind === 'file' || entry.kind === 'link');
  return {
    folder: skill.folder,
    name: text('name'),
    description: text('description'),
    tags: tagsOf(fields),
    source: typeof metadata.source === 'string' ? metadata.source : null,
    allowedTools: text('allowed-tools'),
    files: files.length,
    bytes: files.reduce((sum, entry) => sum + entry.size, 0),
    scripts: skill.entries.some((entry) => entry.path === 'scripts' && entry.kind === 'dir'),
    fingerprint: fingerprintOf(skill.entries),
  };
}

/** Every path in the library the scanner saw, relative to the library. */
export function libraryPaths(facts: LibraryFacts): string[] {
  const paths: string[] = [];
  if (facts.config !== null) paths.push(LIBRARY_FILE);
  paths.push(...facts.instructions.map((entry) => entry.path));
  if (facts.skillsDir !== 'missing') paths.push(SKILLS_DIR);
  for (const skill of facts.skills) {
    paths.push(`${SKILLS_DIR}/${skill.folder}`);
    paths.push(...skill.entries.map((entry) => `${SKILLS_DIR}/${skill.folder}/${entry.path}`));
  }
  paths.push(...facts.others.map((entry) => entry.path));
  return paths;
}

export function buildSnapshot(facts: LibraryFacts, context: SnapshotContext): LibrarySnapshot {
  const { issues: configIssues, ...config } = readLibraryConfig(facts.config, context.appVersion);
  const issues: Issue[] = [...configIssues];
  for (const skill of facts.skills) {
    issues.push(
      ...layoutIssues(skill),
      ...headerIssues(skill, config.prefix),
      ...markdownLinkIssues(skill),
      ...symlinkIssues(skill),
      ...fileSizeIssues(skill),
      ...skillLengthIssues(skill),
    );
  }
  const paths = libraryPaths(facts);
  issues.push(...caseConflictIssues(paths));
  if (context.platform === 'win32') {
    const projection =
      context.projection && config.prefix
        ? {
            root: context.projection.root,
            localNames: new Map(
              facts.skills.flatMap((skill) => {
                const local = localName(
                  skill.folder,
                  config.prefix as Prefix,
                  context.projection?.localPrefix as Prefix,
                );
                return local === undefined ? [] : [[skill.folder, local] as const];
              }),
            ),
          }
        : null;
    issues.push(...windowsPathIssues(paths, context.libraryRoot, projection));
  }
  const instructions = facts.agents ? { path: INSTRUCTIONS_FILE, ...facts.agents } : null;
  issues.push(...instructionIssues(instructions, context.instructionLimits));

  const skills = facts.skills.filter((skill) => skill.kind === 'dir').map(summarize);
  const byTag = new Map<string, string[]>();
  for (const skill of skills) {
    for (const tag of new Set(skill.tags)) {
      // An invalid tag stays on its skill and is flagged (tag.invalid), but isn't offered for tag rules.
      if (tagProblems(tag).length === 0) byTag.set(tag, [...(byTag.get(tag) ?? []), skill.folder]);
    }
  }
  return {
    config,
    compatibility: config.compatibility,
    skills,
    instructions,
    tags: [...byTag.entries()]
      .sort(([a], [b]) => compareText(a, b))
      .map(([tag, folders]) => ({ tag, skills: folders })),
    issues: issues.sort(compareIssues),
  };
}
