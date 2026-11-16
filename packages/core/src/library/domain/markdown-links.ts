// Relative links in a skill's Markdown files (PLAN.md §3.14 "broken relative links"): inline links and images,
// reference definitions, and `href`/`src` in inline HTML. Code blocks and code spans are skipped. External links
// (with a scheme, or `//host`) and in-page anchors are left out; the rest are paths the skill should contain.

export interface MarkdownLink {
  /** The target as written, without angle brackets. */
  readonly target: string;
  /** 1-based. */
  readonly line: number;
}

const INLINE =
  /!?\[(?:[^[\]\\]|\\.|\[[^[\]]*\])*\]\(\s*(<[^>\n]*>|(?!<)(?:[^\s()\\]|\\.|\([^\s()]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(<[^>\n]*>|\S+)/;
const HTML = /<(?:a|img|source)\b[^>]*?\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function markdownLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  let fence: string | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const opening = FENCE.exec(raw);
    if (fence !== null) {
      // A closing fence: the same character, at least as long, and nothing after it.
      const closes = opening && opening[1]?.[0] === fence[0] && (opening[1]?.length ?? 0) >= fence.length;
      if (closes && raw.slice(opening[0].length).trim() === '') fence = null;
      return;
    }
    if (opening) {
      fence = opening[1] ?? '```';
      return;
    }
    // Code spans hide their content; equal-length runs of backticks open and close them.
    const line = raw.replace(/(`+)[\s\S]*?\1/g, (span) => ' '.repeat(span.length));
    const add = (target: string | undefined) => {
      if (target === undefined) return;
      const unwrapped = target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
      if (unwrapped.trim() !== '') links.push({ target: unwrapped, line: index + 1 });
    };
    const definition = DEFINITION.exec(line);
    if (definition) add(definition[1]);
    for (const match of line.matchAll(INLINE)) add(match[1]);
    for (const match of line.matchAll(HTML)) add(match[1] ?? match[2]);
  });
  return links;
}

/**
 * The path a link points to inside its skill, or why it doesn't: `external` for links with a scheme, `//host` and
 * anchors; `outside` for absolute paths and paths that climb out of the skill folder. `from` is the Markdown file's
 * path inside the skill, with forward slashes.
 */
export function resolveLink(
  from: string,
  target: string,
): { kind: 'inside'; path: string } | { kind: 'external' | 'outside' } {
  // A Windows drive (`C:\…`) before URL schemes, which it would otherwise look like.
  if (/^[A-Za-z]:[\\/]/.test(target)) return { kind: 'outside' };
  if (target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
    return { kind: 'external' };
  }
  // Markdown's backslash escapes apply to punctuation only; other backslashes are Windows separators.
  let path = target.replace(/[?#].*$/s, '').replace(/\\([!-/:-@[-`{-~])/g, '$1');
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not valid percent-encoding: the text is the path.
  }
  if (path === '') return { kind: 'external' };
  if (path.startsWith('/')) return { kind: 'outside' };
  const parts = from.split('/').slice(0, -1);
  for (const segment of path.split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return { kind: 'outside' };
      parts.pop();
    } else parts.push(segment);
  }
  return { kind: 'inside', path: parts.join('/') };
}
