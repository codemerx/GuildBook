// The local prefix's field (PLAN.md §3.3): the setup wizard's local-prefix page and the library's change dialog both
// use it. The rules of §3.2 are checked as the user types; whether the prefix is free on this device, and which skills
// would go over 64 characters, comes from the worker's check of the same text.
import type { LocalPrefixCheckView } from '@app/ipc';
import { PrefixSchema } from '@app/schemas';
import type { TFunction } from 'i18next';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { FieldError, Input, Label } from '../../ui/input.tsx';

/** What's wrong with the prefix typed, as a message; undefined while it may be used. */
export function localPrefixMessage(
  t: TFunction,
  value: string,
  check: LocalPrefixCheckView | null,
): string | undefined {
  const parsed = PrefixSchema.safeParse(value);
  if (value !== '' && !parsed.success) return t(parsed.error.issues[0]?.message ?? 'issues.prefix.tooShort');
  const problem = check?.prefix === value ? check.problem : null;
  if (!problem) return undefined;
  if (problem.code === 'rules') return t(`issues.${problem.problem}`);
  if (problem.code === 'instance') return t('setup.localPrefix.problem.instance', { name: problem.name });
  return t(`setup.localPrefix.problem.${problem.code}`, { prefix: value });
}

export function LocalPrefixField({
  id,
  value,
  check,
  busy,
  onChange,
}: {
  id: string;
  value: string;
  /** The worker's check; it may be for an older value while the next one runs. */
  check: LocalPrefixCheckView | null;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const message = localPrefixMessage(t, value, check);
  const current = check?.prefix === value ? check : null;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t('setup.localPrefix.label')}</Label>
      <Input
        id={id}
        value={value}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={message ? true : undefined}
        aria-describedby={`${id}-help ${id}-problem`}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-56 font-mono"
      />
      <FieldError id={`${id}-problem`} message={message} />
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        {t('setup.localPrefix.example', { example: `${value === '' ? '…' : value}-…` })}
      </p>
      {current && current.tooLong.length > 0 && (
        <div
          role="alert"
          className="mt-2 flex flex-col gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"
        >
          <p className="flex items-start gap-2">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>{t('setup.localPrefix.tooLong', { count: current.tooLong.length })}</span>
          </p>
          <ul className="ml-6 list-disc font-mono text-xs">
            {current.tooLong.map((skill) => (
              <li key={skill}>{skill}</li>
            ))}
          </ul>
          {current.shorter && (
            <div className="flex flex-wrap items-center gap-2">
              <span>{t('setup.localPrefix.shorter', { prefix: current.shorter })}</span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => current.shorter && onChange(current.shorter)}
              >
                {t('setup.localPrefix.useShorter', { prefix: current.shorter })}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
