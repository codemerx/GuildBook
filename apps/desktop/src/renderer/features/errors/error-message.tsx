// A typed error as the user reads it: its translated message (IMPLEMENTATION.md §2.12).
import type { ErrorView } from '@app/schemas';
import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function ErrorMessage({ error }: { error: ErrorView }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm">
      <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
      <span>{t(`errors.${error.code}`, { ...error.params })}</span>
    </div>
  );
}
