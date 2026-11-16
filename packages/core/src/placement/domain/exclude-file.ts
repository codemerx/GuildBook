// A code repo's `.git/info/exclude` (PLAN.md §3.6): a local ignore list, never committed, shared by every worktree.
// The app adds one line per link it makes in the repo, and removes only its own lines. Everything else in the file
// stays as it was, line endings included.

/** The file's lines, without their line endings. A final line ending makes no extra empty line. */
function lines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split(/\r?\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function eol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function hasLine(text: string, line: string): boolean {
  return lines(text).includes(line);
}

/** The text with the line added at the end, unless it's there already. */
export function addLine(text: string, line: string): string {
  if (hasLine(text, line)) return text;
  const end = eol(text);
  const base = text === '' || text.endsWith('\n') ? text : `${text}${end}`;
  return `${base}${line}${end}`;
}

/** The text without the line (every copy of it); every other byte stays. */
export function removeLine(text: string, line: string): string {
  if (!hasLine(text, line)) return text;
  const pattern = /([^\r\n]*)(\r?\n|$)/g;
  let out = '';
  for (const match of text.matchAll(pattern)) {
    const [whole, content] = match;
    if (whole === '') break;
    if (content === line) continue;
    out += whole;
  }
  return out;
}

/** The exclude line for a link: its path inside the checkout, with forward slashes, e.g. `.claude/skills/acme-x`. */
export function excludeLine(relativePath: string): string {
  return relativePath.split('\\').join('/');
}
