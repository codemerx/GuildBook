// The `two-companies` world (TESTING.md §4, Step 7): the Acme and Globex libraries on the plain server, and the
// instruction files of every supported tool with the user's own text in them (PLAN.md §3.12). The user's text carries
// a privacy canary: the app reads these files to find its blocks, but the text must never show up in logs or dumps.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestRoot } from '../harness/test-root.ts';

export const GLOBEX_LIBRARY_ID = `lib_${'9b'.repeat(16)}`;
export const GLOBEX_REPO = 'globex/agent-library';

export const CANARY_INSTRUCTIONS = 'canary-5c3e8a my own instructions';

/** Every tool whose instructions the app reaches, and Cursor, which it shows by hand (PLAN.md §3.12). */
export const INSTRUCTION_TOOLS = [
  'claude-code',
  'codex',
  'gemini-cli',
  'copilot-cli',
  'opencode',
  'windsurf',
  'cursor',
] as const;

export const ACME_INSTRUCTIONS = '# Acme\n\nWe write tests first.\n';
export const GLOBEX_INSTRUCTIONS = '# Globex\n\nUse spaces, never tabs.\n';

const globexSkill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nThe Globex way.\n`;

/** The Globex library: two skills, instructions, and a skill whose name has a reserved word (the Doctor flags it). */
export function globexLibraryFiles(): Record<string, string> {
  return {
    'library.yaml': `id: ${GLOBEX_LIBRARY_ID}\nprefix: globex\nformat: 1\n`,
    'skills/globex-onboarding/SKILL.md': globexSkill(
      'globex-onboarding',
      'Explains how Globex works. Use it in your first week.',
    ),
    'skills/globex-style/SKILL.md': globexSkill('globex-style', 'The Globex code style. Use it for every change.'),
    'skills/globex-claude-tips/SKILL.md': globexSkill(
      'globex-claude-tips',
      'Tips for agents at Globex. Use it when you start a session.',
    ),
    'instructions/AGENTS.md': GLOBEX_INSTRUCTIONS,
    '.gitattributes': '* text=auto eol=lf\n',
  };
}

/** The user's own instruction text in a tool's file. */
export function userInstructions(tool: string): string {
  return `# My own notes for ${tool}\n\nAlways answer in English. ${CANARY_INSTRUCTIONS}\n`;
}

export const OPENCODE_CONFIG = `{
  // My OpenCode settings: ${CANARY_INSTRUCTIONS}
  "$schema": "https://opencode.ai/config.json",
  "theme": "system", /* I like it */
  "instructions": [
    "~/notes/rules.md", // my own rules
  ],
}
`;

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * The instruction files the user already has: Codex's, Gemini's, Windsurf's and Claude Code's with text of their own,
 * Copilot's own file and folder, OpenCode's config with comments and no AGENTS.md, and Cursor's folder. OpenCode's
 * folder is under XDG_CONFIG_HOME, which test mode sets (TESTING.md §3).
 */
export function plantInstructionFiles(root: TestRoot): void {
  const home = root.home;
  write(path.join(home, '.claude', 'CLAUDE.md'), userInstructions('Claude Code'));
  write(path.join(home, '.claude', 'rules', 'my-rules.md'), userInstructions('Claude rules'));
  write(path.join(home, '.codex', 'AGENTS.md'), userInstructions('Codex'));
  write(path.join(home, '.gemini', 'GEMINI.md'), userInstructions('Gemini'));
  write(path.join(home, '.copilot', 'copilot-instructions.md'), userInstructions('Copilot'));
  mkdirSync(path.join(home, '.copilot', 'instructions'), { recursive: true });
  write(path.join(opencodeFolder(root), 'opencode.json'), OPENCODE_CONFIG);
  write(path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md'), userInstructions('Windsurf'));
  mkdirSync(path.join(home, '.cursor'), { recursive: true });
}

/** OpenCode's folder in a test root: $XDG_CONFIG_HOME/opencode. */
export function opencodeFolder(root: TestRoot): string {
  return root.at('xdg', 'config', 'opencode');
}
