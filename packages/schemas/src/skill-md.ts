// SKILL.md: the YAML header between `---` lines, then the Markdown body (PLAN.md §1.1). The app edits these header
// fields itself: `name:` (renames, the local prefix), `metadata.tags` (the editor's tag chips), `metadata.source`
// (imports), and the editor's header form: `description` and the advanced fields `license`, `compatibility` and
// `allowed-tools` (PLAN.md §3.14, A10.2). Those edits are format-preserving (IMPLEMENTATION.md Step 2, A2.4): the yaml Document API finds the
// field's exact place in the text, and only that text is replaced. Everything else, the body included, keeps its bytes:
// comments, quoting, indentation, line endings and a byte order mark.
import { isMap, isScalar, type Pair, parseDocument, Scalar, type YAMLMap } from 'yaml';
import { joinTags, splitTags } from './names.ts';

const BOM = '﻿';

/** Where a SKILL.md's header is, as offsets into the text (after a byte order mark, if any). */
export interface SkillMdParts {
  readonly bom: boolean;
  /** The line ending the header uses: new lines the app adds follow it. */
  readonly eol: '\n' | '\r\n';
  /** No header: the file doesn't start with `---`. Unclosed: it does, but no closing `---` follows. */
  readonly header: 'present' | 'none' | 'unclosed';
  /** The YAML text between the marker lines, with its last line ending. */
  readonly yaml: string;
  /** Offsets of `yaml` in the text without its byte order mark. */
  readonly yamlStart: number;
  readonly yamlEnd: number;
  /** Everything after the closing marker line, exactly as it is. */
  readonly body: string;
}

const OPEN = /^---[ \t]*(\r?\n)/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function splitSkillMd(text: string): SkillMdParts {
  const bom = text.startsWith(BOM);
  const rest = bom ? text.slice(1) : text;
  const open = OPEN.exec(rest);
  if (!open) {
    return {
      bom,
      eol: rest.includes('\r\n') ? '\r\n' : '\n',
      header: 'none',
      yaml: '',
      yamlStart: 0,
      yamlEnd: 0,
      body: rest,
    };
  }
  const eol = open[1] === '\r\n' ? '\r\n' : '\n';
  const yamlStart = open[0].length;
  let lineStart = yamlStart;
  while (lineStart <= rest.length) {
    const close = CLOSE.exec(rest.slice(lineStart));
    if (close) {
      return {
        bom,
        eol,
        header: 'present',
        yaml: rest.slice(yamlStart, lineStart),
        yamlStart,
        yamlEnd: lineStart,
        body: rest.slice(lineStart + close[0].length),
      };
    }
    const next = rest.indexOf('\n', lineStart);
    if (next < 0) break;
    lineStart = next + 1;
  }
  return { bom, eol, header: 'unclosed', yaml: '', yamlStart: 0, yamlEnd: 0, body: rest };
}

export type HeaderStatus = 'ok' | 'none' | 'unclosed' | 'invalid' | 'notMap';

/** A SKILL.md's header fields as plain data, for validation. */
export interface SkillHeaderRead {
  readonly status: HeaderStatus;
  /** The fields, when the status is ok. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** YAML's own messages when the status is invalid. */
  readonly errors: readonly string[];
}

export function readSkillHeader(text: string): SkillHeaderRead {
  const parts = splitSkillMd(text);
  if (parts.header !== 'present') return { status: parts.header, fields: {}, errors: [] };
  const doc = parseDocument(parts.yaml, { prettyErrors: false });
  if (doc.errors.length > 0) return { status: 'invalid', fields: {}, errors: doc.errors.map((e) => e.message) };
  if (doc.contents === null) return { status: 'ok', fields: {}, errors: [] };
  if (!isMap(doc.contents)) return { status: 'notMap', fields: {}, errors: [] };
  try {
    // Aliases are refused (maxAliasCount 0): a header has no use for them, and they could expand without limit.
    const fields = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
    return { status: 'ok', fields, errors: [] };
  } catch (error) {
    return { status: 'invalid', fields: {}, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

/** The tags in a header's `metadata.tags`: a space-separated string, or (tolerated) a list. */
export function tagsOf(fields: Readonly<Record<string, unknown>>): string[] {
  const metadata = fields.metadata;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return [];
  const tags = (metadata as Record<string, unknown>).tags;
  if (typeof tags === 'string') return splitTags(tags);
  if (Array.isArray(tags)) return tags.flatMap((tag) => (typeof tag === 'string' ? splitTags(tag) : []));
  return [];
}

/** The advanced fields of the header form (PLAN.md §3.14 "advanced fields collapsed"), by their YAML keys. */
export const ADVANCED_FIELDS = ['license', 'compatibility', 'allowed-tools'] as const;
export type AdvancedField = (typeof ADVANCED_FIELDS)[number];

export interface HeaderEdit {
  readonly name?: string;
  readonly description?: string;
  /** null removes the field. */
  readonly advanced?: Partial<Readonly<Record<AdvancedField, string | null>>>;
  /** An empty list removes `metadata.tags`. */
  readonly tags?: readonly string[];
  /** null removes `metadata.source`. */
  readonly source?: string | null;
}

export type EditProblem = 'noHeader' | 'invalidHeader' | 'notMap' | 'metadataNotMap' | 'unsafe';

export type EditResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: EditProblem };

interface Splice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

type Style = 'PLAIN' | 'QUOTE_SINGLE' | 'QUOTE_DOUBLE';

/**
 * Changes only the given fields of a SKILL.md's header, byte for byte. Refuses when the header is missing or isn't valid
 * YAML, and when the result, read back, would differ anywhere but in those fields (a safety net that never fires for
 * a header the edit understands).
 */
export function editSkillMd(text: string, edit: HeaderEdit): EditResult {
  const parts = splitSkillMd(text);
  if (parts.header !== 'present') return { ok: false, problem: 'noHeader' };
  const doc = parseDocument(parts.yaml, { keepSourceTokens: true, prettyErrors: false });
  if (doc.errors.length > 0) return { ok: false, problem: 'invalidHeader' };
  if (doc.contents !== null && !isMap(doc.contents)) return { ok: false, problem: 'notMap' };

  const editor = new HeaderEditor(parts.yaml, parts.eol, doc.contents);
  try {
    if (edit.name !== undefined) editor.setTop('name', edit.name, 'PLAIN', 'first');
    if (edit.description !== undefined) editor.setTop('description', edit.description, 'PLAIN', 'last');
    for (const key of ADVANCED_FIELDS) {
      const value = edit.advanced?.[key];
      if (value === null) editor.removeTop(key);
      else if (value !== undefined) editor.setTop(key, value, 'PLAIN', 'last');
    }
    if (edit.tags !== undefined) {
      if (edit.tags.length === 0) editor.removeMetadata('tags');
      else editor.setMetadata('tags', joinTags(edit.tags));
    }
    if (edit.source !== undefined) {
      if (edit.source === null) editor.removeMetadata('source');
      else editor.setMetadata('source', edit.source);
    }
  } catch (error) {
    if (error instanceof EditRefused) return { ok: false, problem: error.problem };
    throw error;
  }
  const yaml = editor.result();
  const rest = parts.bom ? text.slice(1) : text;
  const edited = `${parts.bom ? BOM : ''}${rest.slice(0, parts.yamlStart)}${yaml}${rest.slice(parts.yamlEnd)}`;
  return sameApartFrom(text, edited, edit) ? { ok: true, text: edited } : { ok: false, problem: 'unsafe' };
}

class EditRefused extends Error {
  readonly problem: EditProblem;
  constructor(problem: EditProblem) {
    super(problem);
    this.problem = problem;
  }
}

/** Collects text splices on the original header, so every offset refers to the text as it was read. */
class HeaderEditor {
  readonly #src: string;
  readonly #eol: string;
  readonly #root: YAMLMap | null;
  readonly #splices: Splice[] = [];

  constructor(src: string, eol: string, root: unknown) {
    this.#src = src;
    this.#eol = eol;
    this.#root = isMap(root) ? root : null;
  }

  result(): string {
    let out = this.#src;
    for (const splice of [...this.#splices].sort((a, b) => b.start - a.start || b.end - a.end)) {
      out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
    }
    return out;
  }

  setTop(key: string, value: string, newStyle: Style, where: 'first' | 'last'): void {
    const pair = this.#root ? findPair(this.#root, key) : undefined;
    if (pair) {
      this.#replaceValue(pair, value, newStyle, false);
      return;
    }
    const line = `${key}: ${render(value, newStyle, false)}`;
    if (!this.#root || this.#root.items.length === 0) {
      this.#splices.push({ start: 0, end: 0, text: `${line}${this.#eol}` });
    } else if (where === 'first') {
      const start = lineStart(this.#src, rangeOf(this.#root)[0]);
      this.#splices.push({ start, end: start, text: `${line}${this.#eol}` });
    } else {
      this.#appendToBlockMap(this.#root, [line]);
    }
  }

  removeTop(key: string): void {
    const pair = this.#root ? findPair(this.#root, key) : undefined;
    if (!pair || !this.#root) return;
    if (this.#root.flow) throw new EditRefused('unsafe');
    const start = lineStart(this.#src, rangeOf(pair.key)[0]);
    const end = lineEndAfter(this.#src, nodeEnd(pair));
    this.#splices.push({ start, end, text: '' });
  }

  setMetadata(key: string, value: string): void {
    const metadata = this.#root ? findPair(this.#root, 'metadata') : undefined;
    if (!metadata) {
      this.#appendTop(['metadata:', `${this.#indentUnit()}${key}: ${render(value, 'QUOTE_DOUBLE', false)}`]);
      return;
    }
    const map = metadata.value;
    if (isEmptyScalar(map)) {
      // `metadata:` with nothing after it: the entry goes on the next line.
      const colon = this.#colonAfter(metadata);
      this.#splices.push({
        start: colon,
        end: colon + 1,
        text: `:${this.#eol}${this.#indentUnit()}${key}: ${render(value, 'QUOTE_DOUBLE', false)}`,
      });
      return;
    }
    if (!isMap(map)) throw new EditRefused('metadataNotMap');
    const pair = findPair(map, key);
    if (pair) {
      this.#replaceValue(pair, value, 'QUOTE_DOUBLE', map.flow === true);
      return;
    }
    if (map.flow) {
      const [start, end] = rangeOf(map);
      const close = this.#src.lastIndexOf('}', end);
      if (close < start) throw new EditRefused('unsafe');
      const last = map.items.at(-1);
      const entry = `${key}: ${render(value, 'QUOTE_DOUBLE', true)}`;
      if (last) {
        const at = rangeOf(last.value ?? last.key)[1];
        this.#splices.push({ start: at, end: at, text: `, ${entry}` });
      } else this.#splices.push({ start: close, end: close, text: entry });
      return;
    }
    this.#appendToBlockMap(map, [`${key}: ${render(value, 'QUOTE_DOUBLE', false)}`]);
  }

  removeMetadata(key: string): void {
    const metadata = this.#root ? findPair(this.#root, 'metadata') : undefined;
    if (!metadata || isEmptyScalar(metadata.value)) return;
    const map = metadata.value;
    if (!isMap(map)) throw new EditRefused('metadataNotMap');
    const pair = findPair(map, key);
    if (!pair) return;
    if (map.flow) {
      const index = map.items.indexOf(pair);
      const start = rangeOf(pair.key)[0];
      const end = rangeOf(pair.value ?? pair.key)[1];
      const before = this.#src.lastIndexOf(',', start);
      const prev = map.items[index - 1];
      if (index > 0 && prev && before >= rangeOf(prev.value ?? prev.key)[1]) {
        this.#splices.push({ start: before, end, text: '' });
      } else {
        const next = map.items[index + 1];
        const until = next ? rangeOf(next.key)[0] : end;
        this.#splices.push({ start, end: until, text: '' });
      }
      return;
    }
    // A block map: remove the entry's lines. If it was the only entry, remove `metadata:` as well, because an empty
    // `metadata:` would read as null.
    const target = map.items.length === 1 ? metadata : pair;
    const start = lineStart(this.#src, rangeOf(target.key)[0]);
    const end = lineEndAfter(this.#src, nodeEnd(target));
    this.#splices.push({ start, end, text: '' });
  }

  #appendTop(lines: string[]): void {
    if (!this.#root || this.#root.items.length === 0) {
      this.#splices.push({
        start: this.#src.length,
        end: this.#src.length,
        text: lines.map((l) => l + this.#eol).join(''),
      });
      return;
    }
    this.#appendToBlockMap(this.#root, lines);
  }

  /** New lines after a block map's last entry, at the indentation of its keys. */
  #appendToBlockMap(map: YAMLMap, lines: string[]): void {
    const first = map.items[0];
    const last = map.items.at(-1);
    if (!first || !last) throw new EditRefused('unsafe');
    const keyStart = rangeOf(first.key)[0];
    const indent = ' '.repeat(keyStart - lineStart(this.#src, keyStart));
    const at = lineEndAfter(this.#src, nodeEnd(last));
    const block = lines.map((line) => indent + line).join(this.#eol);
    const unterminated = at === this.#src.length && at > 0 && this.#src[at - 1] !== '\n';
    this.#splices.push({ start: at, end: at, text: unterminated ? this.#eol + block : block + this.#eol });
  }

  #replaceValue(pair: Pair, value: string, newStyle: Style, flow: boolean): void {
    const node = pair.value;
    if (isScalar(node) && !isEmptyScalar(node) && isInlineStyle(node.type)) {
      const [start, end] = rangeOf(node);
      this.#splices.push({ start, end, text: render(value, node.type as Style, flow) });
      return;
    }
    // A block scalar, a list, a map or nothing: everything from the colon to the end of the value becomes one line.
    const colon = this.#colonAfter(pair);
    const valueEnd = node && !isEmptyScalar(node) ? rangeOf(node)[1] : colon + 1;
    const removed = this.#src.slice(colon, valueEnd);
    const keepBreak = removed.endsWith('\n') ? (removed.endsWith('\r\n') ? '\r\n' : '\n') : '';
    this.#splices.push({ start: colon, end: valueEnd, text: `: ${render(value, newStyle, flow)}${keepBreak}` });
  }

  #colonAfter(pair: Pair): number {
    const from = rangeOf(pair.key)[1];
    const colon = this.#src.indexOf(':', from);
    if (colon < 0 || this.#src.slice(from, colon).trim() !== '') {
      // Quoted keys end at their closing quote; anything but spaces before the colon is a form we don't edit.
      throw new EditRefused('unsafe');
    }
    return colon;
  }

  /** The indentation unit of nested maps in this header: the first nested key's column, else two spaces. */
  #indentUnit(): string {
    for (const pair of this.#root?.items ?? []) {
      const value = pair.value;
      if (isMap(value) && !value.flow && value.items[0]) {
        const start = rangeOf(value.items[0].key)[0];
        return ' '.repeat(Math.max(1, start - lineStart(this.#src, start)));
      }
    }
    return '  ';
  }
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

function rangeOf(node: unknown): [number, number, number] {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  if (!range) throw new EditRefused('unsafe');
  return range;
}

/** Where an entry ends, trailing comment included. */
function nodeEnd(pair: Pair): number {
  return rangeOf(pair.value ?? pair.key)[2];
}

function isEmptyScalar(node: unknown): boolean {
  return node === null || node === undefined || (isScalar(node) && node.value === null && (node.source ?? '') === '');
}

function isInlineStyle(type: Scalar['type']): boolean {
  return type === Scalar.PLAIN || type === Scalar.QUOTE_SINGLE || type === Scalar.QUOTE_DOUBLE;
}

function lineStart(src: string, offset: number): number {
  return src.lastIndexOf('\n', offset - 1) + 1;
}

/** The offset just after the line ending of the line that holds `offset - 1`, or the text's end. */
function lineEndAfter(src: string, offset: number): number {
  if (offset > 0 && src[offset - 1] === '\n') return offset;
  const next = src.indexOf('\n', offset);
  return next < 0 ? src.length : next + 1;
}

/**
 * A scalar in the wanted style, or double-quoted when that style can't hold the value exactly. Plain scalars are
 * checked by reading them back, so `true`, `123` or `a: b` never come out as something else.
 */
function render(value: string, style: Style, flow: boolean): string {
  if (style === 'PLAIN' && plainReadsBack(value, flow)) return value;
  if (style === 'QUOTE_SINGLE' && !/[\n\r\t]/.test(value)) return `'${value.replace(/'/g, "''")}'`;
  return JSON.stringify(value);
}

function plainReadsBack(value: string, flow: boolean): boolean {
  if (value === '' || value.trim() !== value || /[\n\r\t]/.test(value)) return false;
  const doc = parseDocument(flow ? `{k: ${value}}` : `k: ${value}`);
  if (doc.errors.length > 0) return false;
  try {
    return (doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null)?.k === value;
  } catch {
    // e.g. `*x` reads as an alias
    return false;
  }
}

/** The edited header reads the same as the original, apart from the edited fields, and the body kept its bytes. */
function sameApartFrom(before: string, after: string, edit: HeaderEdit): boolean {
  const a = readSkillHeader(before);
  const b = readSkillHeader(after);
  if (b.status !== 'ok' || splitSkillMd(before).body !== splitSkillMd(after).body) return false;
  const strip = (fields: Readonly<Record<string, unknown>>) => {
    const copy: Record<string, unknown> = { ...fields };
    if (edit.name !== undefined) delete copy.name;
    if (edit.description !== undefined) delete copy.description;
    for (const key of ADVANCED_FIELDS) if (edit.advanced?.[key] !== undefined) delete copy[key];
    const metadata = copy.metadata;
    if ((edit.tags !== undefined || edit.source !== undefined) && typeof metadata === 'object' && metadata !== null) {
      const rest: Record<string, unknown> = { ...(metadata as Record<string, unknown>) };
      if (edit.tags !== undefined) delete rest.tags;
      if (edit.source !== undefined) delete rest.source;
      copy.metadata = Object.keys(rest).length === 0 ? undefined : rest;
    }
    if (copy.metadata === undefined || copy.metadata === null) delete copy.metadata;
    return copy;
  };
  if (JSON.stringify(sortKeys(strip(a.fields))) !== JSON.stringify(sortKeys(strip(b.fields)))) return false;
  const metadata = (b.fields.metadata ?? {}) as Record<string, unknown>;
  if (edit.name !== undefined && b.fields.name !== edit.name) return false;
  if (edit.description !== undefined && b.fields.description !== edit.description) return false;
  for (const key of ADVANCED_FIELDS) {
    const value = edit.advanced?.[key];
    if (value === null ? key in b.fields : value !== undefined && b.fields[key] !== value) return false;
  }
  if (edit.tags !== undefined && (edit.tags.length === 0 ? 'tags' in metadata : metadata.tags !== joinTags(edit.tags)))
    return false;
  if (edit.source !== undefined && (edit.source === null ? 'source' in metadata : metadata.source !== edit.source))
    return false;
  return true;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
