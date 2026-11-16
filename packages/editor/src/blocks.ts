// Untouched blocks keep their text (ADR 0029, A10.1). No rich engine writes Markdown back exactly as it read it, so the
// editor never saves the engine's whole document. It splits the loaded text and the engine's text into top-level
// blocks, matches the blocks whose Markdown tree is the same, and keeps the loaded text of every matched block and of
// the blank lines between two matched neighbours. Only new and changed blocks are written as the engine wrote them.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

type Root = ReturnType<typeof fromMarkdown>;
type RootContent = Root['children'][number];

/** One top-level block: its place in the text and a key that is equal for blocks with the same Markdown tree. */
export interface Block {
  readonly start: number;
  readonly end: number;
  readonly type: RootContent['type'];
  readonly key: string;
}

/** Parses with the same Markdown dialect the rich engine reads: CommonMark and GitHub's extensions. */
export function parseMarkdown(text: string): Root {
  return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** The top-level blocks of a Markdown text, in order. */
export function splitBlocks(text: string): Block[] {
  const root = parseMarkdown(text);
  const definitions = definitionsOf(root);
  return root.children.flatMap((node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return [];
    return [{ start, end, type: node.type, key: keyOf(node, definitions) }];
  });
}

type Definitions = ReadonlyMap<string, { readonly url: string; readonly title: string | null }>;

function definitionsOf(root: Root): Definitions {
  const found = new Map<string, { url: string; title: string | null }>();
  for (const node of root.children) {
    if (node.type === 'definition' && !found.has(node.identifier)) {
      found.set(node.identifier, { url: node.url, title: node.title ?? null });
    }
  }
  return found;
}

/**
 * A block's tree without positions and without what only changes the style: bullets, emphasis markers, escapes and
 * table padding leave no trace in the tree. A reference link counts as the inline link it stands for, because the
 * engine writes reference links inline.
 */
function keyOf(node: RootContent, definitions: Definitions): string {
  return JSON.stringify(node, (key, value: unknown) => {
    if (key === 'position') return undefined;
    if (isReference(value)) {
      const target = definitions.get(value.identifier);
      if (target) {
        // The fields in the order mdast-util-from-markdown gives a link or an image.
        return value.type === 'linkReference'
          ? { type: 'link', title: target.title, url: target.url, children: value.children }
          : { type: 'image', title: target.title, url: target.url, alt: value.alt ?? null };
      }
    }
    return value;
  });
}

interface ReferenceNode {
  readonly type: 'linkReference' | 'imageReference';
  readonly identifier: string;
  readonly children?: unknown;
  readonly alt?: string | null;
}

function isReference(value: unknown): value is ReferenceNode {
  const type = (value as { type?: unknown } | null)?.type;
  return typeof value === 'object' && value !== null && (type === 'linkReference' || type === 'imageReference');
}

/** The line ending the text uses most: new text written into it follows that. */
export function lineEnding(text: string): '\n' | '\r\n' {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function withEnding(text: string, eol: '\n' | '\r\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/** Pairs of equal keys in order, as long as possible (the longest common subsequence). */
function matchBlocks(before: readonly Block[], after: readonly Block[]): Map<number, number> {
  const n = before.length;
  const m = after.length;
  // lengths[i][j]: the longest match of before[i..] and after[j..].
  const lengths: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = lengths[i]!;
    const below = lengths[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = before[i]!.key === after[j]!.key ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!);
    }
  }
  const pairs = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i]!.key === after[j]!.key) {
      pairs.set(j, i);
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);

/** One block of the text to save, and the loaded block it stands in for (kept, or changed in place), if any. */
interface Piece {
  readonly text: string;
  readonly loaded: number | null;
}

/**
 * The text to save: `edited` (what the engine wrote) with the loaded text of every block that didn't change. A changed
 * block that takes the place of a loaded one keeps the blank lines around it. Link definitions the engine dropped stay
 * where they were. New text follows the loaded text's line endings.
 */
export function keepBlocks(loaded: string, edited: string): string {
  if (edited === loaded) return loaded;
  const eol = lineEnding(loaded);
  const before = splitBlocks(loaded);
  const after = splitBlocks(edited);
  if (before.length === 0) return withEnding(edited, eol);
  const pairs = matchBlocks(before, after);
  const kept = (k: number) => loaded.slice(before[k]!.start, before[k]!.end);
  const written = (k: number) => withEnding(edited.slice(after[k]!.start, after[k]!.end), eol);

  // The engine writes reference links inline and drops their definitions: those stay, after the block before them.
  const matched = new Set(pairs.values());
  const dropped = (i: number) => before[i]!.type === 'definition' && !matched.has(i);

  const pieces: Piece[] = [];
  // Walk the matched pairs; between two of them, changed blocks take the places of the loaded ones in order.
  const anchors = [...pairs.entries()].sort(([a], [b]) => a - b);
  let i = 0;
  let j = 0;
  for (const [nextJ, nextI] of [...anchors, [after.length, before.length] as const]) {
    const segment: Piece[] = [];
    const places = range(i, nextI).filter((k) => !dropped(k));
    for (const k of range(j, nextJ)) segment.push({ text: written(k), loaded: places.shift() ?? null });
    // A dropped definition goes after the last block of the segment that came before it in the loaded text.
    for (const d of range(i, nextI).filter(dropped)) {
      let at = 0;
      segment.forEach((piece, n) => {
        if (piece.loaded !== null && piece.loaded < d) at = n + 1;
      });
      segment.splice(at, 0, { text: kept(d), loaded: d });
    }
    pieces.push(...segment);
    if (nextI < before.length) pieces.push({ text: kept(nextI), loaded: nextI });
    i = nextI + 1;
    j = nextJ + 1;
  }

  const out: string[] = [loaded.slice(0, before[0]!.start)];
  pieces.forEach((piece, n) => {
    const previous = pieces[n - 1];
    if (previous) {
      const adjacent = previous.loaded !== null && piece.loaded === previous.loaded + 1;
      out.push(
        adjacent && previous.loaded !== null && piece.loaded !== null
          ? loaded.slice(before[previous.loaded]!.end, before[piece.loaded]!.start)
          : eol + eol,
      );
    }
    out.push(piece.text);
  });
  out.push(loaded.slice(before[before.length - 1]!.end));
  return out.join('');
}

export interface MarkdownStyle {
  readonly bullet: '-' | '*' | '+';
  readonly rule: '-' | '*' | '_';
}

/** The bullet and the thematic break the text uses most, so the engine writes new blocks in the file's own style. */
export function markdownStyle(text: string): MarkdownStyle {
  const bullets = { '-': 0, '*': 0, '+': 0 };
  const rules = { '-': 0, '*': 0, _: 0 };
  for (const line of text.split(/\r?\n/)) {
    const rule = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.exec(line);
    if (rule) {
      rules[rule[1] as keyof typeof rules]++;
      continue;
    }
    const bullet = /^[ \t]*([-*+])[ \t]+\S/.exec(line);
    if (bullet) bullets[bullet[1] as keyof typeof bullets]++;
  }
  const most = <K extends string>(counts: Record<K, number>, fallback: K): K =>
    (Object.keys(counts) as K[]).reduce((best, k) => (counts[k] > counts[best] ? k : best), fallback);
  return { bullet: most(bullets, '-'), rule: most(rules, '-') };
}
