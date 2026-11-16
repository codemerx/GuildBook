// A library's skills with their links (Step 5): for each skill, each link folder with the tools that read it and the
// link's state. All skills are global in Step 5; placement comes in Step 6.
import type { SkillLinksView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { LinkStatus } from './link-status.tsx';

export function SkillsCard({
  instanceId,
  links,
  onTurnBackOn,
}: {
  instanceId: string;
  links: SkillLinksView | undefined;
  /** A link the user turned off ([Don't install it…], [Leave it]) comes back on (PLAN.md §3.8 S2, S3, S5). */
  onTurnBackOn?: (dest: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('links.skills.title')}</CardTitle>
        <CardDescription>{t('links.skills.body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <ErrorMessage error={error} />}
        {links?.state === 'frozen' && (
          <p className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            {t('links.skills.frozen')}
          </p>
        )}
        {links?.state === 'paused' && <p className="text-sm text-muted-foreground">{t('links.skills.paused')}</p>}
        {links?.state === 'prefix-waiting' && (
          <p className="text-sm text-muted-foreground">{t('links.skills.prefixWaiting')}</p>
        )}
        {(!links || (links.state === 'not-ready' && links.skills.length === 0)) && (
          <p className="text-sm text-muted-foreground">{t('links.skills.loading')}</p>
        )}
        {links && links.state !== 'not-ready' && links.skills.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('links.skills.empty')}</p>
        )}
        {links && links.skills.length > 0 && links.skills.every((skill) => skill.links.length === 0) && (
          <p className="text-sm text-muted-foreground">
            {t('links.skills.noTools')}{' '}
            <Link to="/library/$instanceId/tools" params={{ instanceId }} className="underline">
              {t('links.skills.chooseTools')}
            </Link>
          </p>
        )}
        {links && links.skills.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('links.skills.skill')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('links.skills.links')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {links.skills.map((skill) => (
                <tr key={skill.skill}>
                  <th scope="row" className="py-2 pr-3 align-top font-mono text-xs font-medium">
                    {skill.skill}
                  </th>
                  <td className="py-2">
                    <ul className="flex flex-col gap-1">
                      {skill.links.map((link) => (
                        <li key={link.dest} className="flex flex-wrap items-center gap-2">
                          <span className="text-xs">{link.tools.length > 0 ? link.tools.join(', ') : link.folder}</span>
                          <LinkStatus status={link.status} method={link.method} />
                          {onTurnBackOn && (link.status === 'suppressed' || link.status === 'detached-by-user') && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
                              aria-label={t('links.skills.turnBackOnLabel', {
                                skill: skill.skill,
                                tools: link.tools.length > 0 ? link.tools.join(', ') : link.folder,
                              })}
                              onClick={() => {
                                setBusy(link.dest);
                                setError(null);
                                onTurnBackOn(link.dest)
                                  .catch((e: unknown) => setError(e as ErrorView))
                                  .finally(() => setBusy(null));
                              }}
                            >
                              {t('links.skills.turnBackOn')}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
