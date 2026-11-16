// Light and dark themes (IMPLEMENTATION.md §2.11): the setting, or the system's when it's "system".
import type { Theme } from '@app/schemas';
import { useEffect } from 'react';

export function useApplyTheme(theme: Theme | undefined): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || ((theme ?? 'system') === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}
