// The fixture corpus (TESTING.md §4): real-world and generated SKILL.md and AGENTS.md files, kept byte for byte in
// packages/testkit/corpus (see its README for sources and licences).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const corpusRoot = path.resolve(import.meta.dirname, '..', '..', 'corpus');

export interface CorpusFile {
  /** Relative to the corpus's skills/ or agents/ folder, with forward slashes, e.g. `anthropic/mcp-builder`. */
  readonly id: string;
  readonly file: string;
  /** The exact text, byte order mark and line endings included. */
  readonly text: string;
}

/** Every SKILL.md in the corpus, sorted by id: `<source>/<skill folder>`. */
export function corpusSkills(): CorpusFile[] {
  const root = path.join(corpusRoot, 'skills');
  const found: CorpusFile[] = [];
  for (const source of readdirSync(root).sort()) {
    const dir = path.join(root, source);
    if (!statSync(dir).isDirectory()) continue;
    for (const skill of readdirSync(dir).sort()) {
      const file = path.join(dir, skill, 'SKILL.md');
      if (existsSync(file)) found.push({ id: `${source}/${skill}`, file, text: readFileSync(file, 'utf8') });
    }
  }
  return found;
}

/** Every AGENTS.md in the corpus. */
export function corpusAgents(): CorpusFile[] {
  const root = path.join(corpusRoot, 'agents');
  return readdirSync(root)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ id: name, file: path.join(root, name), text: readFileSync(path.join(root, name), 'utf8') }));
}
