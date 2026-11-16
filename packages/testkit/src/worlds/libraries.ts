// Fixture libraries (IMPLEMENTATION.md Step 2 "Worlds: fixture libraries from the corpus"): library folders built from
// the fixture corpus, as data, so the same library seeds an in-memory file system in unit tests and a real folder in
// integration tests, journeys and the tour.
import { type AbsPath, posixPaths } from '@app/core';
import { editSkillMd } from '@app/schemas';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { corpusAgents, corpusSkills } from '../corpus/index.ts';
import type { MemoryFileSystem } from '../fakes/memory-fs.ts';

export type FixtureEntry =
  | string
  | { readonly text: string; readonly executable: true }
  | { readonly bytes: Uint8Array }
  | { readonly zeros: number }
  | { readonly link: string };

export interface FixtureLibrary {
  readonly name: string;
  readonly description: string;
  /** Library path → content, with forward slashes. */
  readonly files: Readonly<Record<string, FixtureEntry>>;
  /** Files that only a case-sensitive file system can hold next to the others (e.g. `readme.md` beside `README.md`). */
  readonly caseSensitiveFiles?: Readonly<Record<string, FixtureEntry>>;
}

export const FIXTURE_LIBRARY_ID = 'lib_acacacacacacacacacacacacacacacac';

function corpusSkill(id: string): string {
  const found = corpusSkills().find((file) => file.id === id);
  if (!found) throw new Error(`no corpus skill ${id}`);
  return found.text;
}

/** A corpus skill as a company skill: renamed with the prefix, and tagged. */
function companySkill(id: string, name: string, tags: readonly string[] = []): string {
  const edited = editSkillMd(corpusSkill(id), { name, ...(tags.length > 0 ? { tags } : {}) });
  if (!edited.ok) throw new Error(`can't edit corpus skill ${id}: ${edited.problem}`);
  return edited.text;
}

const agentsMd = () => corpusAgents().find((file) => file.id === 'agentsmd.AGENTS.md')?.text ?? '# Instructions\n';

/** A tiny PNG (1×1, transparent): a binary asset. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function libraryYaml(extra = ''): string {
  return `id: ${FIXTURE_LIBRARY_ID}\nprefix: acme\nformat: 1\nsuggest:\n  backend: ["acme/backend-*"]\nrepoOnlyTags: [frontend]\n${extra}`;
}

/** A library without a single issue: real skills under the prefix, with tags, references, a script and an asset. */
export const validLibrary: FixtureLibrary = {
  name: 'acme-valid',
  description: 'A valid library: six corpus skills under the acme prefix, one hand-made skill with every kind of file',
  files: {
    'library.yaml': libraryYaml(),
    'instructions/AGENTS.md': agentsMd(),
    'README.md': '# Acme agent library\n',
    'skills/acme-internal-comms/SKILL.md': companySkill('anthropic/internal-comms', 'acme-internal-comms', ['writing']),
    'skills/acme-brand-guidelines/SKILL.md': companySkill('anthropic/brand-guidelines', 'acme-brand-guidelines', [
      'design',
      'frontend',
    ]),
    'skills/acme-theme-factory/SKILL.md': companySkill('anthropic/theme-factory', 'acme-theme-factory', ['design']),
    'skills/acme-composition-patterns/SKILL.md': companySkill(
      'vercel/composition-patterns',
      'acme-composition-patterns',
      ['frontend'],
    ),
    'skills/acme-writing-guidelines/SKILL.md': companySkill('vercel/writing-guidelines', 'acme-writing-guidelines', [
      'writing',
    ]),
    'skills/acme-define-goal/SKILL.md': companySkill('openai/define-goal', 'acme-define-goal'),
    'skills/acme-release-notes/SKILL.md': [
      '---',
      'name: acme-release-notes',
      'description: Use when writing release notes for an Acme service. Reads the changelog and follows the guide.',
      'metadata:',
      '  tags: "writing backend"',
      '---',
      '',
      '# Release notes',
      '',
      'Follow [the guide](references/guide.md) and the [latest notes](latest.md). Run `scripts/check.sh` first.',
      '',
      '![Acme logo](assets/logo.png)',
      '',
    ].join('\n'),
    'skills/acme-release-notes/references/guide.md': '# Guide\n\nSee [the skill](../SKILL.md#release-notes).\n',
    'skills/acme-release-notes/scripts/check.sh': { text: '#!/bin/sh\necho ok\n', executable: true },
    'skills/acme-release-notes/assets/logo.png': { bytes: PNG },
    'skills/acme-release-notes/latest.md': { link: 'references/guide.md' },
  },
};

const LONG = 'Use when you need a very long description. '.repeat(26);

/** Every kind of issue the validation rules report, on top of real corpus skills. */
export const invalidLibrary: FixtureLibrary = {
  name: 'acme-invalid',
  description: 'An invalid library: every validation rule fires at least once',
  files: {
    'library.yaml': libraryYaml('minAppVersion: "99.0.0"\nsomeFutureField: {x: 1}\n'),
    'instructions/AGENTS.md': `# Acme instructions\n\n${'Keep the build green. '.repeat(240)}\n`,
    // Real-world: the skill links to reference files that weren't copied.
    'skills/acme-mcp-builder/SKILL.md': companySkill('anthropic/mcp-builder', 'acme-mcp-builder', ['backend']),
    // Real-world: its name differs from its folder, and it has no prefix.
    'skills/composition-patterns/SKILL.md': corpusSkill('vercel/composition-patterns'),
    'skills/acme-Upper/SKILL.md': '---\nname: acme-Upper\ndescription: Has an uppercase letter.\n---\n',
    'skills/acme-no-description/SKILL.md': '---\nname: acme-no-description\n---\n\nNo description.\n',
    'skills/acme-claude-helper/SKILL.md': '---\nname: acme-claude-helper\ndescription: Uses a reserved word.\n---\n',
    'skills/acme-no-skill-md/README.md': '# Not a skill yet\n',
    'skills/acme-no-header/SKILL.md': '# Just Markdown, no header\n',
    'skills/acme-bad-yaml/SKILL.md': '---\nname: acme-bad-yaml\ndescription: [unclosed\n---\n',
    'skills/acme-long-description/SKILL.md': `---\nname: acme-long-description\ndescription: ${LONG}\nmetadata:\n  tags: "Backend ok"\n---\n`,
    'skills/acme-bad-metadata/SKILL.md': `---\nname: acme-bad-metadata\ndescription: Fields of the wrong type.\nallowed-tools: [Bash, Read]\ncompatibility: ${'x'.repeat(501)}\nmetadata:\n  version: 1\n---\n`,
    'skills/acme-links/SKILL.md':
      '---\nname: acme-links\ndescription: Links that lead nowhere, or out of the skill.\n---\n\n[missing](references/missing.md) · [other skill](../acme-release-notes/SKILL.md) · [absolute](/etc/hosts)\n',
    'skills/acme-links/README.md': '# Read me\n',
    'skills/acme-links/credentials': { link: '/home/someone/.aws/credentials' },
    'skills/acme-links/assets/big.bin': { zeros: 10 * 1024 * 1024 + 1 },
    'skills/notes.txt': 'A file where skill folders belong.\n',
  },
  caseSensitiveFiles: {
    'skills/acme-links/readme.md': '# The same name in another case\n',
  },
};

export const fixtureLibraries = { 'acme-valid': validLibrary, 'acme-invalid': invalidLibrary } as const;
export type FixtureLibraryName = keyof typeof fixtureLibraries;

function entries(fixture: FixtureLibrary, caseSensitive: boolean): Array<[string, FixtureEntry]> {
  return [...Object.entries(fixture.files), ...(caseSensitive ? Object.entries(fixture.caseSensitiveFiles ?? {}) : [])];
}

/** Writes a fixture library into a real folder. Leave out the case-sensitive files on macOS and Windows. */
export function writeFixtureLibrary(
  fixture: FixtureLibrary,
  dir: string,
  options: { caseSensitive?: boolean } = {},
): void {
  mkdirSync(dir, { recursive: true });
  for (const [relative, entry] of entries(fixture, options.caseSensitive ?? process.platform === 'linux')) {
    const file = path.join(dir, ...relative.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    if (typeof entry === 'string') writeFileSync(file, entry);
    else if ('link' in entry) symlinkSync(entry.link, file);
    else if ('bytes' in entry) writeFileSync(file, entry.bytes);
    else if ('zeros' in entry) writeFileSync(file, new Uint8Array(entry.zeros));
    else {
      writeFileSync(file, entry.text);
      chmodSync(file, 0o755);
    }
  }
}

/** Seeds a fixture library into an in-memory file system (POSIX paths unless the fake says otherwise). */
export async function seedFixtureLibrary(
  fixture: FixtureLibrary,
  fs: MemoryFileSystem,
  root: string,
  options: {
    caseSensitive?: boolean;
    /** Writes large files as one byte: hashing 10 MB is slow under mutation testing's instrumentation. */
    smallFiles?: boolean;
  } = {},
): Promise<void> {
  const paths = fs.paths ?? posixPaths;
  await fs.mkdirp(root as AbsPath);
  for (const [relative, entry] of entries(fixture, options.caseSensitive ?? paths.name === 'posix')) {
    const file = paths.join(root, ...relative.split('/')) as AbsPath;
    await fs.mkdirp(paths.dirname(file) as AbsPath);
    if (typeof entry === 'string') await fs.writeTextAtomic(file, entry);
    else if ('link' in entry) await fs.links.create(entry.link as AbsPath, file);
    else if ('bytes' in entry) await fs.writeBytesAtomic(file, entry.bytes);
    else if ('zeros' in entry) await fs.writeBytesAtomic(file, new Uint8Array(options.smallFiles ? 1 : entry.zeros));
    else {
      await fs.writeTextAtomic(file, entry.text);
      fs.chmod(file, 0o755);
    }
  }
}
