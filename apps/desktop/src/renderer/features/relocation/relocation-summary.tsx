// The summary of a move (PLAN.md §3.9 "What the user sees"): "Library moved to ~/Work/acme", its counts, and what came
// over from the old folder.
import type { RelocationSummaryView } from '@app/ipc';
import { CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PathText } from '../../ui/path-text.tsx';
import { summaryCounts } from './relocation-text.ts';

/** The summary: "Library moved to ~/Work/acme." and its counts, and what came over from the old folder. */
export function RelocationSummary({ summary, home }: { summary: RelocationSummaryView; home: string | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 text-sm" role="status">
      <p className="flex flex-wrap items-baseline gap-1 font-medium">
        <CheckCircle2 aria-hidden="true" className="size-4 self-center text-success" />
        {t(summary.method === 'locate' ? 'relocation.summary.found' : 'relocation.summary.moved')}
        <PathText path={summary.to} home={home} />
      </p>
      <p>{summaryCounts(t, summary)}</p>
      {summary.carried.length > 0 && <p>{t('relocation.summary.carried', { count: summary.carried.length })}</p>}
      {summary.keptBoth.length > 0 && (
        <p>
          {t('relocation.summary.keptBoth', { count: summary.keptBoth.length, files: summary.keptBoth.join(', ') })}
        </p>
      )}
      {summary.skipped.length > 0 && (
        <ul className="ml-5 list-disc">
          {summary.skipped.map((path) => (
            <li key={path}>
              <PathText path={path} home={home} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
