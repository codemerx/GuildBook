// Data from a newer app version is never touched: the app says so and asks to be updated (A1.17).
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function NeedsUpdate() {
  const { t } = useTranslation();
  return (
    <main id="main" className="mx-auto flex max-w-lg flex-col items-start gap-3 p-8 pt-24">
      <AlertTriangle aria-hidden="true" className="size-8 text-warning" />
      <h1 className="text-2xl font-semibold">{t('needsUpdate.title')}</h1>
      <p className="text-muted-foreground">{t('needsUpdate.body')}</p>
    </main>
  );
}
