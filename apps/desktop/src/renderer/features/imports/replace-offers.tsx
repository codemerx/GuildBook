// Replacing the original of an imported skill (PLAN.md §3.18 B): once the skill is in the company version, the app
// offers to move the user's original to the trash, so the tools don't show both. [Keep both] forgets the offer.
import type { OriginalOfferView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, useInstanceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { displayPath } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';

export function ReplaceOffersView({
  offers,
  home,
  onReplace,
  onKeep,
}: {
  offers: readonly OriginalOfferView[];
  home: string | undefined;
  onReplace: (skill: string) => Promise<void>;
  onKeep: (skill: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  if (offers.length === 0) return null;
  const run = (skill: string, action: (skill: string) => Promise<void>) => {
    setBusy(skill);
    setError(null);
    action(skill)
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(null));
  };
  return (
    <Card aria-label={t('imports.replace.title')}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Copy aria-hidden="true" className="size-4" />
          {t('imports.replace.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <ErrorMessage error={error} />}
        {offers.map((offer) => (
          <div key={offer.skill} className="flex flex-col gap-3 rounded-md border border-border p-3 text-sm">
            <p>
              {t('imports.replace.question', {
                original: displayPath(offer.original, home),
                skill: offer.skill,
              })}
            </p>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy !== null} onClick={() => run(offer.skill, onReplace)}>
                {t('imports.replace.replace')}
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run(offer.skill, onKeep)}>
                {t('imports.replace.keep')}
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function ReplaceOffers({ instanceId, home }: { instanceId: string; home: string | undefined }) {
  const offers = useInstanceQuery(instanceId, 'importOffers');
  return (
    <ReplaceOffersView
      offers={offers.data ?? []}
      home={home}
      onReplace={async (skill) => {
        await callInstance(instanceId, 'replaceOriginal', { skill });
      }}
      onKeep={async (skill) => {
        await callInstance(instanceId, 'keepOriginal', { skill });
      }}
    />
  );
}
