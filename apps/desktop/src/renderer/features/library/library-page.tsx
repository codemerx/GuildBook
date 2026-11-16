// A library's page. In Step 1 it shows the instance's status, its folders and its worker; later steps add the
// overview, changes and the editor.
import type {
  AccessView,
  InstanceStatusView,
  InstanceView,
  LocalPrefixView,
  PrefixStateView,
  SkillLinksView,
} from '@app/ipc';
import { Link, useParams } from '@tanstack/react-router';
import { Info } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, queryInstance, useDeviceQuery, useInstanceQuery } from '../../rpc/queries.ts';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { StatusBadge } from '../../ui/status-badge.tsx';
import { buttonVariants } from '../../ui/button.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { AccessLostPanel } from './access-panel.tsx';
import { GitPageLink } from './library-git-page.tsx';
import { InspectorLink } from './library-inspector-page.tsx';
import { LibraryNav } from '../links/library-nav.tsx';
import { SkillsCard } from '../links/skills-card.tsx';
import { LocalPrefixCard, type LocalPrefixActions, localPrefixActions } from '../projection/local-prefix-card.tsx';
import { PrefixCard, type PrefixActions, prefixActions as prefixChangeActions } from '../prefix/prefix-card.tsx';
import { LocationCard } from '../relocation/location-card.tsx';
import { ReplaceOffers } from '../imports/replace-offers.tsx';
import type { RelocationActions } from '../relocation/relocation-dialog.tsx';
import { clearPrefixOffer, prefixOfferFor } from './remove-dialog.tsx';

/** Turns a link the user turned off back on: the plan for `reenable`, applied with its hash (PLAN.md §3.8). */
async function turnBackOn(instanceId: string, dest: string): Promise<void> {
  const decision = { kind: 'reenable' as const };
  const plan = await queryInstance(instanceId, 'previewDecision', { dest, decision });
  await callInstance(instanceId, 'resolveLink', { dest, decision, planHash: plan.hash });
}

export function LibraryPageView({
  instance,
  status,
  access,
  home,
  developerPages = false,
  accessPanel,
  links,
  localPrefix,
  prefixActions,
  offerDrop = false,
  relocation,
  prefix,
  prefixChange,
}: {
  instance: InstanceView;
  status: InstanceStatusView | undefined;
  /** The sign-in and role (Step 4); undefined for a test library or while loading. */
  access?: AccessView | undefined;
  home: string | undefined;
  /** Development and test builds link to the library inspector. */
  developerPages?: boolean;
  /** The access-lost state's panel, when access is lost. */
  accessPanel?: React.ReactNode;
  /** Each skill with its links (Step 5); undefined until the instance is ready. */
  links?: SkillLinksView | undefined;
  /** The local prefix on this device (Step 8), while the library has one. */
  localPrefix?: LocalPrefixView | undefined;
  prefixActions?: LocalPrefixActions | undefined;
  /** The page opens with the offer to drop the local prefix (S12). */
  offerDrop?: boolean;
  /** The location card's actions; stories and tests pass stand-ins. */
  relocation?: RelocationActions;
  /** The library's prefix and its lock (Step 14). */
  prefix?: PrefixStateView | undefined;
  prefixChange?: PrefixActions | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{instance.name}</h1>
        <StatusBadge status={instance.status} accessLost={instance.accessLost === true} className="text-sm" />
        {instance.status === 'ready' && <LibraryNav instanceId={instance.id} attention={instance.attention} />}
      </header>
      {instance.status === 'restarting' && (
        <p className="text-sm text-muted-foreground">{t('library.restartingHint')}</p>
      )}
      {instance.error && <ErrorMessage error={instance.error} />}
      {instance.status === 'setting-up' && instance.gitUrl !== null && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted p-3 text-sm">
          <Info aria-hidden="true" className="size-4" />
          <span>{t('library.setupUnfinished')}</span>
          <Link
            to="/library/$instanceId/setup"
            params={{ instanceId: instance.id }}
            className={buttonVariants({ size: 'sm' })}
          >
            {t('library.continueSetup')}
          </Link>
        </div>
      )}
      {access?.state === 'lost' && accessPanel}
      {instance.status === 'ready' && localPrefix && prefixActions && (
        <LocalPrefixCard
          key={instance.id}
          view={localPrefix}
          actions={prefixActions}
          offerDrop={offerDrop}
          onOfferDone={clearPrefixOffer}
        />
      )}
      {instance.status === 'ready' && prefix && prefixChange && (
        <PrefixCard state={prefix} actions={prefixChange} library={instance.name} />
      )}
      {instance.status === 'ready' && <ReplaceOffers instanceId={instance.id} home={home} />}
      {instance.status === 'ready' && (
        <LocationCard instance={instance} home={home} {...(relocation ? { actions: relocation } : {})} />
      )}
      {instance.status === 'ready' && (
        <SkillsCard instanceId={instance.id} links={links} onTurnBackOn={(dest) => turnBackOn(instance.id, dest)} />
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('library.status')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            {/* The library folder shows once, in its own card with its actions (Step 9); here only while setting up. */}
            {instance.status !== 'ready' && (
              <>
                <dt className="text-muted-foreground">{t('library.folder')}</dt>
                <dd>
                  <PathText path={instance.libraryPath} home={home} />
                </dd>
              </>
            )}
            {status && (
              <>
                <dt className="text-muted-foreground">{t('library.dataFolder')}</dt>
                <dd>
                  <PathText path={status.dataFolder} home={home} />
                </dd>
                <dt className="text-muted-foreground">{t('library.schema')}</dt>
                <dd>{status.schemaVersion}</dd>
                <dt className="text-muted-foreground">{t('library.status')}</dt>
                <dd>{status.busy ? t('library.busy', { command: status.busy.command }) : t('library.idle')}</dd>
              </>
            )}
            {access?.host && (
              <>
                <dt className="text-muted-foreground">{t('library.host')}</dt>
                <dd>{t(`hosts.${access.host}`)}</dd>
                <dt className="text-muted-foreground">{t('library.account')}</dt>
                <dd>{access.login ? t('library.signedInAs', { login: access.login }) : t('library.accountKey')}</dd>
                <dt className="text-muted-foreground">{t('library.role')}</dt>
                <dd>{t(`roles.${access.role ?? 'unknown'}`)}</dd>
              </>
            )}
          </dl>
          {instance.restarts > 0 && (
            <p className="mt-4 text-sm text-muted-foreground">{t('library.restarts', { count: instance.restarts })}</p>
          )}
        </CardContent>
      </Card>
      {developerPages && status && (
        <p className="flex flex-col gap-1">
          <InspectorLink instanceId={instance.id} />
          <GitPageLink instanceId={instance.id} />
        </p>
      )}
    </div>
  );
}

export function LibraryPage() {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/library/$instanceId' });
  const instances = useDeviceQuery('instances');
  const appInfo = useDeviceQuery('appInfo');
  const instance = instances.data?.find((i) => i.id === instanceId);
  const running = instance?.status === 'ready' || instance?.status === 'setting-up';
  const status = useInstanceQuery(running ? instanceId : undefined, 'status');
  const access = useInstanceQuery(running && instance?.gitUrl ? instanceId : undefined, 'access');
  const links = useInstanceQuery(instance?.status === 'ready' ? instanceId : undefined, 'skillLinks');
  const local = instance?.status === 'ready' && (instance.localPrefix ?? null) !== null;
  const localPrefix = useInstanceQuery(local ? instanceId : undefined, 'localPrefix');
  const prefixActions = useMemo(() => localPrefixActions(instanceId), [instanceId]);
  const prefix = useInstanceQuery(instance?.status === 'ready' ? instanceId : undefined, 'prefix');
  const changeActions = useMemo(() => prefixChangeActions(instanceId), [instanceId]);
  // The remove dialog sends the user here with the offer (S12).
  const offerDrop = prefixOfferFor(instanceId);
  if (!instance) return instances.isLoading ? null : <p>{t('library.notFound')}</p>;
  return (
    <LibraryPageView
      instance={instance}
      status={running ? status.data : undefined}
      access={access.data}
      home={appInfo.data?.homePath}
      developerPages={appInfo.data?.features.developerPages ?? false}
      links={links.data}
      localPrefix={local ? localPrefix.data : undefined}
      prefixActions={prefixActions}
      offerDrop={offerDrop}
      prefix={prefix.data}
      prefixChange={changeActions}
      accessPanel={
        access.data && <AccessLostPanel instance={instance} access={access.data} home={appInfo.data?.homePath} />
      }
    />
  );
}
