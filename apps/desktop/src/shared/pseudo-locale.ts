// The pseudo-locale (TESTING.md §7.2, IMPLEMENTATION.md Step 17): every text of the translation file, made about 40 %
// longer with accented letters, and ended with ⟧. A text cut off loses its end mark. The English words stay as they
// are and come first, so the tour's steps still find buttons and headings by their names.

/** The language code i18next uses for it: en-XA is the usual code of an English pseudo-locale. */
export const PSEUDO_LANGUAGE = 'en-XA';

/** The end mark of every pseudo text: a text that shows without it was cut off. */
export const PSEUDO_CLOSE = '⟧';

/** Letters with marks above and below, so a line that is too low for them shows it. */
const FILLER = 'ÅçÉŷÎǫÜñ';

type Tree = { readonly [key: string]: string | Tree };

/** One text: the English, a space, the filler (40 % of its length, at least 2 letters) and the end mark. */
export function pseudoText(text: string): string {
  // An empty text stays empty: it marks a place that shows nothing on purpose.
  if (text === '') return '';
  const visible = text.replace(/\{\{\w+\}\}/g, '').length;
  const length = Math.max(2, Math.ceil(visible * 0.4));
  const filler = FILLER.repeat(Math.ceil(length / FILLER.length)).slice(0, length);
  return `${text} ${filler}${PSEUDO_CLOSE}`;
}

/** Every text of a translation tree, made pseudo. */
export function pseudoTree(tree: Tree): Tree {
  return Object.fromEntries(
    Object.entries(tree).map(([key, value]) => [
      key,
      typeof value === 'string' ? pseudoText(value) : pseudoTree(value),
    ]),
  );
}
