// i18next from the first screen (IMPLEMENTATION.md §2.11): English only in v1, every text in the translation file,
// the product name inserted from brand. Test runs can switch to the pseudo-locale (Step 17), and test builds record
// every key the file lacks, so the tour can say no raw key showed.
import i18next, { type i18n as I18n } from 'i18next';
import { useEffect } from 'react';
import { initReactI18next } from 'react-i18next';
import { defaultVariables, resources } from '../shared/i18n.ts';
import { PSEUDO_LANGUAGE, pseudoTree } from '../shared/pseudo-locale.ts';

export const i18n: I18n = i18next.createInstance();

/** Test builds: the keys asked for that the translation file doesn't have. */
export const missingKeys = new Set<string>();

void i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  initAsync: false,
  interpolation: { escapeValue: false, defaultVariables },
  returnNull: false,
  ...(__TEST_HOOKS__
    ? {
        saveMissing: true,
        missingKeyHandler: (_languages: readonly string[], _namespace: string, key: string) => missingKeys.add(key),
      }
    : {}),
});

/** Test runs: the pseudo-locale, once main says so (AppInfo.locale). */
export function usePseudoLocale(locale: 'pseudo' | undefined): void {
  useEffect(() => {
    if (!__TEST_HOOKS__ || locale !== 'pseudo' || i18n.language === PSEUDO_LANGUAGE) return;
    i18n.addResourceBundle(PSEUDO_LANGUAGE, 'translation', pseudoTree(resources.en.translation));
    void i18n.changeLanguage(PSEUDO_LANGUAGE);
  }, [locale]);
}
