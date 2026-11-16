// A line diff for the both-changed dialog (PLAN.md §3.3 "shows the difference"): the lines only one side has, and the
// lines both keep, from the longest common subsequence. Texts here are skill files, small enough for the table.
export type DiffLine =
  | { readonly kind: 'same'; readonly text: string }
  | { readonly kind: 'library'; readonly text: string }
  | { readonly kind: 'copy'; readonly text: string };

/** Above this many cells the table isn't built: each side is shown whole instead. */
const MAX_CELLS = 4_000_000;

function lines(text: string): string[] {
  const out = text.split(/\r?\n/);
  if (out.length > 1 && out.at(-1) === '') out.pop();
  return out;
}

/** The library's text against the copy's, line by line; null when they're too long to compare. */
export function lineDiff(library: string, copy: string): DiffLine[] | null {
  const a = lines(library);
  const b = lines(copy);
  if (a.length * b.length > MAX_CELLS) return null;
  // common[i][j]: the longest common subsequence of a[i..] and b[j..].
  const common: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = common[i] as number[];
    const next = common[i + 1] as number[];
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] as string });
      i++;
      j++;
    } else if ((common[i + 1]?.[j] ?? 0) >= (common[i]?.[j + 1] ?? 0)) {
      out.push({ kind: 'library', text: a[i] as string });
      i++;
    } else {
      out.push({ kind: 'copy', text: b[j] as string });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ kind: 'library', text: a[i] as string });
  for (; j < b.length; j++) out.push({ kind: 'copy', text: b[j] as string });
  return out;
}
