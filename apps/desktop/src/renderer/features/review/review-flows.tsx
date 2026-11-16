// The review flows the git screens start (PLAN.md §3.11, §3.10, ADR 0032): [Push and open change request], which pushes
// the branch and opens the page that makes the request on the host's website; [Move my commits to a new branch and open
// a change request] after a refused push; and [Sign my unpushed commits and push again] after a push refused for
// missing signatures, with the signing key asked first when there's none. Each flow's dialogs and its note render where
// the hook is used.
import type { InstanceView, PushResultView, ReviewStatusView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink, GitPullRequest } from 'lucide-react';
import type React from 'react';
import { createContext, useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, callInstance, queryInstance, useInstanceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { BranchDialog, SigningDialog } from './review-dialogs.tsx';

export interface ReviewFlows {
  /** [Push and open change request] for the current branch. */
  readonly open: () => void;
  /** [Move my commits to a new branch and open a change request]. */
  readonly move: () => void;
  /** [Sign my unpushed commits and push again]; the signing key is asked first when there's none. */
  readonly sign: () => void;
  /** The signing key, asked before a commit that needs it; `then` runs once it's chosen. */
  readonly chooseKey: (then: () => void) => void;
  /** The last flow's push found secrets, and the user sends them anyway: the same flow again. */
  readonly confirmSecrets: () => void;
  readonly dialogs: React.ReactNode;
  /** Where the change request's branch went, and its page (ADR 0032). */
  readonly note: React.ReactNode;
}

/** The flows of the git screen's frame, for the pages inside it (the commit box asks for the signing key with it). */
export const ReviewFlowsContext = createContext<ReviewFlows | null>(null);

export function useFrameFlows(): ReviewFlows | null {
  return useContext(ReviewFlowsContext);
}

/** The host's name for the texts: GitHub, GitLab, or "the git server". */
export function hostName(review: ReviewStatusView | undefined, t: (key: string) => string): string {
  return t(`review.hosts.${review?.host ?? 'plain'}`);
}

/** The branch is on the server: the request's page opened in the browser, or there is none to open. */
export function OpenedNote({
  opened,
  onOpenAgain,
}: {
  opened: { branch: string; base: string; link: string | null };
  onOpenAgain: (link: string) => void;
}) {
  const { t } = useTranslation();
  const { link } = opened;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-muted px-4 py-3 text-sm"
    >
      <GitPullRequest aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{t(link === null ? 'review.opened.noPage' : 'review.opened.page', opened)}</span>
      {link !== null && (
        <Button type="button" size="sm" variant="secondary" onClick={() => onOpenAgain(link)}>
          <ExternalLink aria-hidden="true" />
          {t('review.opened.openAgain')}
        </Button>
      )}
    </div>
  );
}

export function useReviewFlows(
  instance: InstanceView,
  review: ReviewStatusView | undefined,
  handlers: {
    /** A push came back with something to say: secrets found, or a rejection. */
    readonly onPush: (result: PushResultView) => void;
    readonly onError: (error: ErrorView) => void;
  },
): ReviewFlows {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [opened, setOpened] = useState<{ branch: string; base: string; link: string | null } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [signing, setSigning] = useState<(() => void) | null>(null);
  /** The flow whose push found secrets: sent again once the user confirms. */
  const [pending, setPending] = useState<((confirmSecrets: boolean) => void) | null>(null);
  const signingView = useInstanceQuery(signing ? instance.id : undefined, 'signing');
  const fail = (e: unknown) => handlers.onError(e as ErrorView);
  const pushed = (result: PushResultView, again: (confirmSecrets: boolean) => void) => {
    if (result.kind === 'pushed' || result.kind === 'upToDate') return;
    setPending(() => again);
    handlers.onPush(result);
  };
  const openPage = (link: string) => void callDevice('openExternal', { url: link }).catch(fail);

  const open = (confirmSecrets = false) => {
    setOpened(null);
    callInstance(instance.id, 'openRequest', { confirmSecrets })
      .then((result) => {
        if (result.kind === 'push') {
          pushed(result.push, open);
          return;
        }
        setOpened(result);
        if (result.link !== null) openPage(result.link);
      })
      .catch(fail);
  };
  const signAndPush = (confirmSecrets = false) => {
    callInstance(instance.id, 'signAndPush', { confirmSecrets })
      .then((result) => pushed(result, signAndPush))
      .catch(fail);
  };
  const flows: ReviewFlows = {
    open: () => open(),
    move: () => {
      queryInstance(instance.id, 'suggestBranch', { skills: [] })
        .then(({ branch }) => setMoving(branch))
        .catch(fail);
    },
    sign: () => {
      if (review?.signingKeyNeeded) setSigning(() => () => signAndPush());
      else signAndPush();
    },
    chooseKey: (then) => setSigning(() => then),
    confirmSecrets: () => {
      const again = pending;
      setPending(null);
      again?.(true);
    },
    note: opened && <OpenedNote opened={opened} onOpenAgain={openPage} />,
    dialogs: (
      <>
        <BranchDialog
          open={moving !== null}
          title={t('review.moveDialog.title')}
          description={t('review.moveDialog.body', { branch: review?.companyBranch ?? 'main' })}
          suggestion={moving ?? ''}
          confirm={t('review.moveDialog.confirm')}
          onCancel={() => setMoving(null)}
          onConfirm={(branch) => {
            setMoving(null);
            callInstance(instance.id, 'moveCommits', { branch })
              .then(() => {
                void navigate({ to: '/library/$instanceId/changes', params: { instanceId: instance.id } });
                open();
              })
              .catch(fail);
          }}
        />
        <SigningDialog
          open={signing !== null}
          view={signingView.data}
          library={instance.name}
          host={hostName(review, t)}
          actions={{
            choose: async () => {
              const picked = await callDevice('pickSigningKey', {});
              if (picked) await callInstance(instance.id, 'chooseSigningKey', picked);
            },
            create: async () => {
              await callInstance(instance.id, 'createSigningKey', {});
            },
            register: async () => {
              await callInstance(instance.id, 'registerSigningKey', {});
            },
          }}
          onClose={() => setSigning(null)}
          onDone={() => {
            const then = signing;
            setSigning(null);
            then?.();
          }}
        />
      </>
    ),
  };
  return flows;
}
