// Marked blocks (PLAN.md §3.12): the app's part of a file the user shares with it. Everything outside the markers is the
// user's own text, and these functions never change a byte of it: a block is added at the end with at most one line
// break before it, which goes again with the block, and a refresh replaces only the text between the markers. The
// marker word is the brand's (`brand.instructionMarker`):
//
//   My own notes for Codex …
//
//   <!-- <marker>:begin instance=lib_7f3a prefix=acme -->
//   …Acme instructions…
//   <!-- <marker>:end instance=lib_7f3a -->
import { brand } from '@app/brand';

const MARKER = brand.instructionMarker;

export function beginMarker(instance: string, prefix: string): string {
  return `<!-- ${MARKER}:begin instance=${instance} prefix=${prefix} -->`;
}

export function endMarker(instance: string): string {
  return `<!-- ${MARKER}:end instance=${instance} -->`;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Any instance's marker line: the app's blocks, whoever wrote them. */
const ANY_BEGIN = new RegExp(
  `^<!-- ${escapeRegex(MARKER)}:begin instance=([A-Za-z0-9_-]+)[^\\n]*-->[ \\t]*\\r?$`,
  'gm',
);

/** Where one instance's block is in a text. */
export type BlockSpan =
  | { readonly kind: 'none' }
  /** One marker without the other, or markers out of order: the app can't tell its text from the user's. */
  | { readonly kind: 'damaged' }
  | {
      readonly kind: 'found';
      /** Offset of the begin marker's line. */
      readonly start: number;
      /** Offset right after the end marker's line, its line break included. */
      readonly end: number;
      /** The text between the markers' lines, exactly as it is. */
      readonly inside: string;
      /** Offset where the inside starts and ends. */
      readonly insideStart: number;
      readonly insideEnd: number;
      /** The prefix its begin marker names: the effective prefix when it was written (Step 8). */
      readonly prefix: string | null;
    };

interface MarkerLine {
  readonly start: number;
  /** After the line's break, when it has one. */
  readonly next: number;
}

function markerLines(text: string, pattern: RegExp): MarkerLine[] {
  const out: MarkerLine[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const lineEnd = start + match[0].length;
    const next = text.startsWith('\r\n', lineEnd) ? lineEnd + 2 : text[lineEnd] === '\n' ? lineEnd + 1 : lineEnd;
    out.push({ start, next: Math.max(next, lineEnd) });
  }
  return out;
}

export function findBlock(text: string, instance: string): BlockSpan {
  const id = escapeRegex(instance);
  const begins = markerLines(
    text,
    new RegExp(`^<!-- ${escapeRegex(MARKER)}:begin instance=${id}( [^\\n]*)? -->[ \\t]*\\r?$`, 'gm'),
  );
  const ends = markerLines(text, new RegExp(`^<!-- ${escapeRegex(MARKER)}:end instance=${id} -->[ \\t]*\\r?$`, 'gm'));
  if (begins.length === 0 && ends.length === 0) return { kind: 'none' };
  const [begin] = begins;
  const [end] = ends;
  if (begins.length !== 1 || ends.length !== 1 || !begin || !end || end.start < begin.next) return { kind: 'damaged' };
  // The end marker's line break belongs to the block; a block at the very end may have none.
  const afterEnd = (() => {
    const lineEnd = text.indexOf('\n', end.start);
    return lineEnd === -1 ? text.length : lineEnd + 1;
  })();
  const prefix = /prefix=([^\s>]+)/.exec(text.slice(begin.start, begin.next))?.[1] ?? null;
  return {
    kind: 'found',
    start: begin.start,
    end: afterEnd,
    inside: text.slice(begin.next, end.start),
    insideStart: begin.next,
    insideEnd: end.start,
    prefix,
  };
}

/** The line break the file uses: CRLF when it already has one, else LF. */
export function lineBreakOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** The text between the markers for a content: the content, ending with a line break. */
export function blockInside(content: string, eol = '\n'): string {
  const body = eol === '\r\n' ? content.replace(/\r?\n/g, '\r\n') : content;
  return body === '' || body.endsWith('\n') ? body : `${body}${eol}`;
}

/**
 * Adds the instance's block at the end of the text. `lead` is the line break put before it when the text doesn't end
 * with one: the app removes exactly that again with the block.
 */
export function appendBlock(
  text: string,
  instance: string,
  prefix: string,
  content: string,
): { text: string; lead: string } {
  const eol = lineBreakOf(text);
  const lead = text === '' || text.endsWith('\n') ? '' : eol;
  const block = `${beginMarker(instance, prefix)}${eol}${blockInside(content, eol)}${endMarker(instance)}${eol}`;
  return { text: `${text}${lead}${block}`, lead };
}

/** Replaces the text between the markers; the markers and everything outside them stay. */
/**
 * Replaces the text between the markers. With `marker`, the begin marker names that prefix: enabling, changing or
 * dropping a local prefix updates the blocks (PLAN.md §3.3).
 */
export function replaceInside(
  text: string,
  span: Extract<BlockSpan, { kind: 'found' }>,
  content: string,
  marker?: { readonly instance: string; readonly prefix: string },
): string {
  const eol = lineBreakOf(text);
  const head =
    marker && span.prefix !== marker.prefix
      ? `${text.slice(0, span.start)}${beginMarker(marker.instance, marker.prefix)}${eol}`
      : text.slice(0, span.insideStart);
  return `${head}${blockInside(content, eol)}${text.slice(span.insideEnd)}`;
}

/** Removes the block and the line break the app put before it. */
export function removeBlock(text: string, span: Extract<BlockSpan, { kind: 'found' }>, lead: string): string {
  const before = text.slice(0, span.start);
  const after = text.slice(span.end);
  // A block that ended the file had its own line break; without the block, the text before ends as it did.
  const trimmed = lead !== '' && after === '' && before.endsWith(lead) ? before.slice(0, -lead.length) : before;
  return `${trimmed}${after}`;
}

/** The text with every instance's blocks taken out: the user's own text (PLAN.md §3.12, Codex's override file). */
export function ownText(text: string): string {
  let out = '';
  let at = 0;
  for (const begin of markerLines(text, ANY_BEGIN)) {
    if (begin.start < at) continue;
    const id = /instance=([A-Za-z0-9_-]+)/.exec(text.slice(begin.start, begin.next))?.[1] ?? '';
    const span = findBlock(text.slice(begin.start), id);
    if (span.kind !== 'found') continue;
    out += text.slice(at, begin.start);
    at = begin.start + span.end;
  }
  return out + text.slice(at);
}

/** Whether a file has text of its own besides the app's blocks: blank lines don't count. */
export function hasOwnText(text: string): boolean {
  return ownText(text).trim() !== '';
}
