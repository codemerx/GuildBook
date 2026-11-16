// The onboarding wizard's frame (IMPLEMENTATION.md Step 4, §2.14 "Wizard pages"): the title, the host and repo the
// setup is for, the list of steps with the current one, and the page. Step 8 adds the local-prefix page, and Step 15
// the pages after the download (PLAN.md §3.17), by adding entries to `wizardSteps`.
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { cn } from '../../ui/cn.ts';

export type WizardStep =
  | 'url'
  | 'signIn'
  | 'folder'
  | 'download'
  | 'prefix'
  | 'localPrefix'
  | 'import'
  | 'instructions'
  | 'tags'
  | 'publish'
  | 'tools'
  | 'repos'
  | 'names'
  | 'summary';

/** The pages of each wizard, in order (PLAN.md §3.17). */
export const wizardSteps: Record<'join' | 'create', readonly WizardStep[]> = {
  join: ['url', 'signIn', 'folder', 'download', 'tools', 'repos', 'names', 'summary'],
  create: [
    'url',
    'signIn',
    'folder',
    'download',
    'prefix',
    'import',
    'instructions',
    'tags',
    'publish',
    'tools',
    'repos',
    'names',
    'summary',
  ],
};

export function WizardFrame({
  intent,
  current,
  host,
  repo,
  localPrefix = false,
  name = null,
  onCancel,
  children,
}: {
  intent: 'join' | 'create';
  /** The library's name, once the URL is known: "Join Acme" (PLAN.md §3.17 step 1). */
  name?: string | null;
  current: WizardStep;
  host: string | null;
  repo: string | null;
  /** The library needs a local prefix on this device (Step 8): its page comes after the download. */
  localPrefix?: boolean;
  onCancel?: (() => void) | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const steps = localPrefix
    ? wizardSteps[intent].flatMap((step) => (step === 'download' ? (['download', 'localPrefix'] as const) : [step]))
    : wizardSteps[intent];
  const at = steps.indexOf(current);
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">
          {intent === 'create' ? t('setup.createTitle') : name ? t('setup.joinNamed', { name }) : t('setup.joinTitle')}
        </h1>
        {host && repo && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('setup.hostLabel')}</dt>
            <dd className="font-medium">{host}</dd>
            <dt className="text-muted-foreground">{t('setup.repoLabel')}</dt>
            <dd className="font-medium">{repo}</dd>
          </dl>
        )}
        <ol aria-label={t('setup.steps.label')} className="flex flex-wrap items-center gap-2 text-xs">
          {steps.map((step, index) => {
            const done = index < at;
            const now = index === at;
            return (
              <li
                key={step}
                aria-current={now ? 'step' : undefined}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
                  now ? 'border-primary bg-primary/10 font-semibold text-foreground' : 'border-border',
                  !now && !done && 'text-muted-foreground',
                )}
              >
                {done && <Check aria-hidden="true" className="size-3.5 text-success" />}
                <span>{t(`setup.steps.${step}`)}</span>
                {done && <span className="sr-only">{t('setup.steps.done')}</span>}
              </li>
            );
          })}
        </ol>
      </header>
      {children}
      {onCancel && (
        <div>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('setup.cancelSetup')}
          </Button>
        </div>
      )}
    </div>
  );
}
