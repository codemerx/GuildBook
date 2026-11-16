// The company's instructions outside the library (PLAN.md §3.12): the registry's rows for the files, blocks and the
// config entry the app makes, and the edits of OpenCode's config file that keep the user's comments and formatting.
import {
  applyEdits,
  findNodeAtLocation,
  type FormattingOptions,
  getNodeValue,
  modify,
  parse,
  type ParseError,
  parseTree,
  stripComments,
} from 'jsonc-parser';
import { z } from 'zod';

export const INSTRUCTION_KIND = 'instruction';

/**
 * What one artifact is:
 * - `owned-file`: a file of the app's own, e.g. `~/.copilot/instructions/<prefix>.instructions.md`
 * - `block`: the app's marked block in a file the user shares with it, e.g. `~/.codex/AGENTS.md`
 * - `config-entry`: the one entry in OpenCode's `instructions` list
 */
export const InstructionArtifactSchema = z.enum(['owned-file', 'block', 'config-entry']);
export type InstructionArtifact = z.infer<typeof InstructionArtifactSchema>;

/** `copy`: it holds the text; `import`: it only points at a file that does (Claude's import, Gemini's block). */
export const InstructionRoleSchema = z.enum(['copy', 'import']);
export type InstructionRole = z.infer<typeof InstructionRoleSchema>;

/**
 * An artifact's state:
 * - `linked`: what the app wrote is there
 * - `edited`: someone changed the text inside the block or the owned file; the user decides (PLAN.md §3.12)
 * - `damaged`: a block's begin or end marker is gone, so the app can't tell its text from the user's
 */
export const InstructionStatusSchema = z.enum(['linked', 'edited', 'damaged']);
export type InstructionStatus = z.infer<typeof InstructionStatusSchema>;

export const InstructionRowSchema = z.object({
  artifact: InstructionArtifactSchema,
  role: InstructionRoleSchema,
  /** The tools it serves, by id. */
  tools: z.array(z.string()),
  /** The file the app last wrote: the path itself, or the file a link there points to (PLAN.md §3.12). */
  written: z.string(),
  /** The fingerprint of what the app wrote: the text inside the markers, the file, or the entry. */
  fingerprint: z.string(),
  /** The fingerprint of the library's text it was made from (copies only). */
  source: z.string().nullable(),
  /** A block: the line break the app put before it, removed again with it. */
  lead: z.string().max(2),
  /** The app created the file (or OpenCode's `instructions` list), so it goes again when nothing else is in it. */
  createdFile: z.boolean(),
  createdKey: z.boolean(),
  /** A config entry's value: the path of the app's owned copy. */
  entry: z.string().nullable(),
  status: InstructionStatusSchema,
  since: z.number().int(),
});
export type InstructionRow = z.infer<typeof InstructionRowSchema>;

// ---- OpenCode's config file ----------------------------------------------------------------------------------

/** What the app sees of OpenCode's config: only whether the entry is there, and whether the text can be edited. */
export interface ConfigEntryState {
  readonly readable: boolean;
  readonly present: boolean;
  /** How many entries the `instructions` list holds, the app's own included; null without a list. */
  readonly entries: number | null;
}

function parseConfig(text: string): { value: unknown; ok: boolean } {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  return { value, ok: errors.length === 0 && typeof value === 'object' && value !== null && !Array.isArray(value) };
}

function instructionsOf(value: unknown): unknown[] | null | 'invalid' {
  const list = (value as Record<string, unknown>).instructions;
  if (list === undefined) return null;
  return Array.isArray(list) ? list : 'invalid';
}

export function configEntryState(text: string, entry: string): ConfigEntryState {
  if (text.trim() === '') return { readable: true, present: false, entries: null };
  const parsed = parseConfig(text);
  if (!parsed.ok) return { readable: false, present: false, entries: null };
  const list = instructionsOf(parsed.value);
  if (list === 'invalid') return { readable: false, present: false, entries: null };
  return { readable: true, present: list?.includes(entry) ?? false, entries: list?.length ?? null };
}

/** The file's own indentation, so an edit looks like the rest of it. */
function formatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? '  ';
  return indent.startsWith('\t')
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: indent.length, eol };
}

/** A new config file that holds only the entry. */
export function newConfigWithEntry(entry: string): string {
  return `{\n  "instructions": [${JSON.stringify(entry)}]\n}\n`;
}

/** The `instructions` list's node, its elements' offsets, and the offset of its closing bracket. */
function listNode(
  text: string,
): { elements: Array<{ offset: number; end: number; value: unknown }>; close: number } | null {
  const tree = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  const node = tree ? findNodeAtLocation(tree, ['instructions']) : undefined;
  if (node?.type !== 'array') return null;
  return {
    elements: (node.children ?? []).map((child) => ({
      offset: child.offset,
      end: child.offset + child.length,
      value: getNodeValue(child) as unknown,
    })),
    close: node.offset + node.length - 1,
  };
}

/** Whether a stretch of text has a comma outside comments: a trailing comma after the last element. */
function hasComma(stretch: string): boolean {
  return stripComments(stretch).includes(',');
}

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;

/**
 * Adds the entry at the end of the `instructions` list, creating the list when there is none. Everything else in the
 * file stays as it is: comments, order, formatting. The entry goes on a line of its own before the closing bracket
 * (or after the last element on a one-line list), so a comment after the user's last entry stays with it. Refused
 * (null) when the file isn't a JSON object the app can edit.
 */
export function addConfigEntry(text: string, entry: string): { text: string; createdKey: boolean } | null {
  if (text.trim() === '') return { text: newConfigWithEntry(entry), createdKey: true };
  const parsed = parseConfig(text);
  if (!parsed.ok) return null;
  const list = instructionsOf(parsed.value);
  if (list === 'invalid') return null;
  if (list?.includes(entry)) return { text, createdKey: false };
  if (list === null) {
    const edits = modify(text, ['instructions'], [entry], { formattingOptions: formatting(text) });
    return { text: applyEdits(text, edits), createdKey: true };
  }
  const node = listNode(text);
  if (!node) return null;
  const value = JSON.stringify(entry);
  const last = node.elements.at(-1);
  if (!last) return { text: `${text.slice(0, node.close)}${value}${text.slice(node.close)}`, createdKey: false };
  const trailing = hasComma(text.slice(last.end, node.close));
  const closeLine = lineStart(text, node.close);
  const multiLine = text.slice(last.end, node.close).includes('\n') && text.slice(closeLine, node.close).trim() === '';
  if (!multiLine) return { text: `${text.slice(0, last.end)}, ${value}${text.slice(last.end)}`, createdKey: false };
  const itemLine = lineStart(text, last.offset);
  const indent = /^[ \t]*/.exec(text.slice(itemLine))?.[0] ?? '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const line = `${indent}${value}${trailing ? ',' : ''}${eol}`;
  const withComma = trailing ? text : `${text.slice(0, last.end)},${text.slice(last.end)}`;
  const at = closeLine + (trailing ? 0 : 1);
  return { text: `${withComma.slice(0, at)}${line}${withComma.slice(at)}`, createdKey: false };
}

/**
 * Removes the entry: its line when it has one of its own, else the entry and its separator. A comma the app added
 * after the user's last entry goes with it. With `createdKey`, the list goes too when it's empty now. Refused (null)
 * when the file isn't a JSON object the app can edit.
 */
export function removeConfigEntry(text: string, entry: string, createdKey: boolean): string | null {
  const parsed = parseConfig(text);
  if (!parsed.ok) return null;
  const list = instructionsOf(parsed.value);
  if (list === 'invalid') return null;
  if (list === null) return text;
  let out = text;
  for (;;) {
    const node = listNode(out);
    const index = node?.elements.findIndex((element) => element.value === entry) ?? -1;
    if (!node || index === -1) break;
    const element = node.elements[index] as { offset: number; end: number };
    const previous = node.elements[index - 1];
    const next = node.elements[index + 1];
    const start = lineStart(out, element.offset);
    const lineEnd = out.indexOf('\n', element.end);
    const after = out.slice(element.end, lineEnd === -1 ? out.length : lineEnd);
    const ownLine = out.slice(start, element.offset).trim() === '' && /^\s*,?\s*$/.test(after) && lineEnd !== -1;
    if (ownLine) {
      const hadComma = after.includes(',');
      out = `${out.slice(0, start)}${out.slice(lineEnd + 1)}`;
      // The last entry had no comma: the app gave the user's entry before it one, which goes again.
      if (!hadComma && !next && previous && out[previous.end] === ',') {
        out = `${out.slice(0, previous.end)}${out.slice(previous.end + 1)}`;
      }
    } else if (previous) {
      out = `${out.slice(0, previous.end)}${out.slice(element.end)}`;
    } else {
      const rest = /^\s*,\s*/.exec(out.slice(element.end))?.[0] ?? '';
      out = `${out.slice(0, element.offset)}${out.slice(element.end + rest.length)}`;
    }
  }
  const after = instructionsOf(parseConfig(out).value);
  if (createdKey && Array.isArray(after) && after.length === 0) {
    out = applyEdits(out, modify(out, ['instructions'], undefined, { formattingOptions: formatting(out) }));
  }
  return out;
}

/** Whether a config file holds nothing but an empty object: one the app created and then emptied. */
export function isEmptyConfig(text: string): boolean {
  const parsed = parseConfig(text);
  return parsed.ok && Object.keys(parsed.value as object).length === 0;
}
