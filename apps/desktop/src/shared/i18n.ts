// The translation resources (IMPLEMENTATION.md §2.11): English only in v1, every user-visible text in one file. The
// renderer reads them through i18next; main uses this small lookup for the tray and dialogs. Texts never contain the
// product name: they insert it as {{appName}} from brand (A1.16).
import { brand } from '@app/brand';
import en from './locales/en.json' with { type: 'json' };

export const resources = { en: { translation: en } } as const;
export const defaultVariables = { appName: brand.displayName };

type Tree = { readonly [key: string]: string | Tree };

function lookup(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split('.')) {
    if (typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Main's lookup: the key's English text with {{variables}} filled in, or the key itself when it's missing. */
export function translate(key: string, variables: Readonly<Record<string, string | number>> = {}): string {
  // i18next's plural keys: `key_one` and `key_other`, chosen by `count`.
  const plural = typeof variables.count === 'number' ? `${key}_${variables.count === 1 ? 'one' : 'other'}` : undefined;
  const text = (plural === undefined ? undefined : lookup(en, plural)) ?? lookup(en, key);
  if (text === undefined) return key;
  const all: Record<string, string | number> = { ...defaultVariables, ...variables };
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (name in all ? String(all[name]) : match));
}

/** Every key in the file, e.g. for checks that each error code has a message. */
export function translationKeys(tree: Tree = en, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : translationKeys(value, `${prefix}${key}.`),
  );
}
