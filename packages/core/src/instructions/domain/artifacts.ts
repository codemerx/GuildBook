// The instruction strategies (IMPLEMENTATION.md §2.14, PLAN.md §3.12): which files, blocks and config entries make the
// library's `instructions/AGENTS.md` reach each enabled tool. Pure: what the app has seen on disk comes in as facts.
//
// | Tool        | Strategy                                                                             |
// |-------------|--------------------------------------------------------------------------------------|
// | Claude Code | owned file in ~/.claude/rules that imports the library's file (`@path`, escaped)     |
// | Gemini CLI  | owned copy in ~/.gemini, and a block in GEMINI.md that imports it (`@./name`)        |
// | Copilot CLI | owned copy in ~/.copilot/instructions                                                 |
// | Codex       | block with a copy, in AGENTS.override.md while that has text of its own              |
// | OpenCode    | block with a copy in AGENTS.md if it exists; else an `instructions` entry + a copy   |
// | Windsurf    | block with a copy in global_rules.md                                                  |
// | Cursor      | nothing on disk: the page shows the text to copy                                     |
import { brand } from '@app/brand';
import type { InstructionArtifact, InstructionRole } from '@app/schemas';
import type { ResolvedTool } from '../../catalog/index.ts';
import { sha256OfText } from '../../shared/hash.ts';
import type { PathFlavour } from '../../shared/paths.ts';

/** One file, block or entry the app wants, keyed by the path it's at (the path the tool reads, not a link's target). */
export interface DesiredInstruction {
  readonly key: string;
  readonly artifact: InstructionArtifact;
  readonly role: InstructionRole;
  readonly tools: readonly string[];
  /** The text to write: a copy of the library's text, an import line, or the config entry's value. */
  readonly content: string;
  /** The fingerprint of the library's text a copy holds; null for imports and entries. */
  readonly source: string | null;
}

/** What the app saw on disk before planning: the facts that decide where a strategy writes. */
export interface InstructionFacts {
  /** Codex: override files with text of their own besides the app's blocks (PLAN.md §3.12). */
  readonly overridesWithText: readonly string[];
  /** OpenCode: the AGENTS.md files that exist. */
  readonly existing: readonly string[];
  /** OpenCode: config files where this instance's entry is already used: it stays (PLAN.md §3.12). */
  readonly entriesInUse: readonly string[];
}

export interface InstructionInputs {
  /** The company's instructions are linked on this device (PLAN.md §3.12 "Linking and unlinking"). */
  readonly linked: boolean;
  readonly instance: string;
  /** The effective prefix: it names the owned files. */
  readonly prefix: string;
  /** The library's `instructions/AGENTS.md`, absolute; null when the library has none. */
  readonly libraryFile: string | null;
  readonly libraryText: string | null;
  readonly tools: readonly ResolvedTool[];
  readonly enabled: readonly string[];
  readonly facts: InstructionFacts;
}

export const NO_FACTS: InstructionFacts = { overridesWithText: [], existing: [], entriesInUse: [] };

/** An owned file's name: the brand's owned-file prefix, the prefix and the suffix, e.g. `…-acme.md` (PLAN.md §3.12). */
export function ownedFileName(prefix: string, suffix = '.md'): string {
  return `${brand.ownedFilePrefix}${prefix}${suffix}`;
}

/**
 * Claude Code's import line: forward slashes, and spaces escaped with `\`, because Claude doesn't import a quoted path
 * (PLAN.md §3.12).
 */
export function claudeImportLine(file: string): string {
  return `@${file.replace(/\\/g, '/').replace(/ /g, '\\ ')}\n`;
}

/** Gemini's import line: the owned copy next to GEMINI.md, by a relative path. */
export function relativeImportLine(name: string): string {
  return `@./${name}\n`;
}

export function textFingerprint(text: string): string {
  return sha256OfText(text);
}

const includes = (list: readonly string[], path: string, paths: PathFlavour) => list.some((p) => paths.same(p, path));

/** What each enabled tool needs, merged by path: two tools that read the same file share its artifact. */
export function desiredInstructions(inputs: InstructionInputs, paths: PathFlavour): DesiredInstruction[] {
  if (!inputs.linked || inputs.libraryFile === null || inputs.libraryText === null) return [];
  const text = inputs.libraryText;
  const source = textFingerprint(text);
  const enabled = new Set(inputs.enabled);
  const out: DesiredInstruction[] = [];
  const add = (want: Omit<DesiredInstruction, 'key'> & { key: string }) => {
    const key = paths.normalize(want.key);
    const seen = out.findIndex((d) => paths.same(d.key, key));
    if (seen === -1) {
      out.push({ ...want, key });
      return;
    }
    // The first tool decides what's there; the others read the same thing.
    const first = out[seen] as DesiredInstruction;
    out[seen] = { ...first, tools: [...new Set([...first.tools, ...want.tools])].sort() };
  };
  const copy = (key: string, tool: string) =>
    add({ key, artifact: 'owned-file', role: 'copy', tools: [tool], content: text, source });
  const block = (key: string, tool: string) =>
    add({ key, artifact: 'block', role: 'copy', tools: [tool], content: text, source });

  for (const tool of inputs.tools) {
    const how = tool.instructions;
    if (!enabled.has(tool.id) || !how || how.method === 'manual' || how.path === '') continue;
    switch (how.method) {
      case 'import-file':
        add({
          key: paths.join(how.path, ownedFileName(inputs.prefix, how.fileSuffix)),
          artifact: 'owned-file',
          role: 'import',
          tools: [tool.id],
          content: claudeImportLine(inputs.libraryFile),
          source: null,
        });
        break;
      case 'owned-file': {
        const name = ownedFileName(inputs.prefix, how.fileSuffix);
        copy(paths.join(how.path, name), tool.id);
        if (how.importFrom) {
          add({
            key: how.importFrom,
            artifact: 'block',
            role: 'import',
            tools: [tool.id],
            content: relativeImportLine(name),
            source: null,
          });
        }
        break;
      }
      case 'marked-block': {
        if (how.override && includes(inputs.facts.overridesWithText, how.override, paths)) {
          block(how.override, tool.id);
          break;
        }
        const configEntry = how.configEntry;
        if (
          configEntry &&
          (includes(inputs.facts.entriesInUse, configEntry, paths) || !includes(inputs.facts.existing, how.path, paths))
        ) {
          // OpenCode reads the user's ~/.claude/CLAUDE.md only while its own AGENTS.md is missing: the app never
          // creates that file, and lists an owned copy in the config instead (PLAN.md §3.12).
          const copyPath = paths.join(paths.dirname(how.path), ownedFileName(inputs.prefix, how.fileSuffix));
          copy(copyPath, tool.id);
          add({
            key: configEntry,
            artifact: 'config-entry',
            role: 'import',
            tools: [tool.id],
            content: paths.normalize(copyPath),
            source: null,
          });
          break;
        }
        block(how.path, tool.id);
        break;
      }
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The tools whose instructions the app can't write: Cursor's settings, and tools with no known file (PLAN.md §3.4). */
export function manualTools(
  tools: readonly ResolvedTool[],
  enabled: readonly string[],
): {
  manual: string[];
  skillsOnly: string[];
} {
  const on = new Set(enabled);
  const manual: string[] = [];
  const skillsOnly: string[] = [];
  for (const tool of tools) {
    if (!on.has(tool.id)) continue;
    if (tool.instructions?.method === 'manual') manual.push(tool.id);
    else if (!tool.instructions) skillsOnly.push(tool.id);
  }
  return { manual, skillsOnly };
}
