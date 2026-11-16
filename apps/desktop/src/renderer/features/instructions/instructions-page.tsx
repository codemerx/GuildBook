// The Instructions page (PLAN.md §3.12 "Linking and unlinking instructions"): every company on this computer, whether
// its instructions are linked, and how they reach each tool. [Link] while another company's are linked shows the
// warning first. Changes made outside the app inside a block or a copy wait here for "bring this change in" or
// "discard it". Cursor keeps its rules in its settings, so the page shows the text to paste there.
import type { InstanceView, InstructionPreviewView, InstructionsView, InstructionToolView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useQueries } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, Info, Link2, Link2Off, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice, callInstance, keys, queryInstance, useDeviceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { cn } from '../../ui/cn.ts';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { displayPath, PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';

export type LinkingAction = 'link' | 'link-anyway' | 'switch' | 'unlink';
export type InstructionDecision = 'bring-in' | 'discard';

export interface InstructionsActions {
  setLinked(instanceId: string, action: LinkingAction): Promise<void>;
  preview(instanceId: string, key: string, decision: InstructionDecision): Promise<InstructionPreviewView>;
  resolve(instanceId: string, key: string, decision: InstructionDecision, planHash: string): Promise<void>;
  check(instanceId: string): Promise<void>;
  copy(text: string): Promise<void>;
}

export interface InstructionsEntry {
  readonly instance: InstanceView;
  readonly view: InstructionsView | undefined;
}

/** The tools that get (or would get) the instructions from the app: not the ones without a way, not Cursor. */
function reachedTools(view: InstructionsView | undefined): InstructionToolView[] {
  return view?.tools.filter((tool) => tool.method !== 'none' && tool.method !== 'manual') ?? [];
}

/** How the instructions reach the tool, as the artifacts on disk show it: OpenCode's config entry, Gemini's import. */
function howOf(tool: InstructionToolView): string {
  if (tool.artifacts.some((artifact) => artifact.artifact === 'config-entry')) return 'config-entry';
  if (tool.method === 'owned-file' && tool.artifacts.some((a) => a.artifact === 'block' && a.role === 'import'))
    return 'owned-file-import';
  return tool.method;
}

function StateText({ tool }: { tool: InstructionToolView }) {
  const { t } = useTranslation();
  const warn = tool.status === 'edited' || tool.status === 'damaged';
  const Icon = warn ? AlertTriangle : tool.status === 'linked' ? CheckCircle2 : Info;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        warn ? 'text-danger' : tool.status === 'linked' ? 'text-success' : 'text-muted-foreground',
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {t(`instructions.state.${tool.status}`)}
    </span>
  );
}

function RoomText({ tool }: { tool: InstructionToolView }) {
  const { t } = useTranslation();
  const room = tool.room;
  if (!room) return <span className="text-xs text-muted-foreground">—</span>;
  const unit = t(`instructions.units.${room.unit}`);
  const text =
    room.left >= 0
      ? t('instructions.room', { left: room.left.toLocaleString('en'), limit: room.limit.toLocaleString('en'), unit })
      : t('instructions.roomOver', {
          over: (-room.left).toLocaleString('en'),
          limit: room.limit.toLocaleString('en'),
          unit,
        });
  return (
    <span className="flex flex-col gap-0.5">
      <span className={cn('inline-flex items-center gap-1 text-xs', room.state !== 'ok' && 'font-medium text-warning')}>
        {room.state !== 'ok' && <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />}
        {text}
      </span>
      {room.repoFilesCount && <span className="text-xs text-muted-foreground">{t('instructions.roomRepo')}</span>}
    </span>
  );
}

function CompanyCard({
  entry,
  home,
  busy,
  onLink,
  onUnlink,
  onReview,
  onCheck,
  onCopy,
}: {
  entry: InstructionsEntry;
  home: string | undefined;
  busy: boolean;
  onLink: () => void;
  onUnlink: () => void;
  onReview: (key: string) => void;
  onCheck: () => void;
  onCopy: (text: string) => void;
}) {
  const { t } = useTranslation();
  const { instance, view } = entry;
  const linked = instance.instructionsLinked;
  const tools = reachedTools(view);
  const cursor = view?.tools.find((tool) => tool.method === 'manual');
  const [copied, setCopied] = useState(false);
  return (
    <section aria-label={instance.name}>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              {instance.name}
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                  linked ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
                )}
              >
                {linked ? (
                  <Link2 aria-hidden="true" className="size-3.5" />
                ) : (
                  <Link2Off aria-hidden="true" className="size-3.5" />
                )}
                {linked ? t('instructions.linked') : t('instructions.notLinked')}
              </span>
            </CardTitle>
            <CardDescription>
              {view && !view.library
                ? t('instructions.noInstructions')
                : tools.length > 0
                  ? t('instructions.toolsFor', { tools: tools.map((tool) => tool.name).join(', ') })
                  : t('instructions.noTools')}
            </CardDescription>
          </div>
          {linked ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              aria-label={t('instructions.unlinkLabel', { name: instance.name })}
              onClick={onUnlink}
            >
              <Link2Off aria-hidden="true" />
              {t('instructions.unlink')}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={busy}
              aria-label={t('instructions.linkLabel', { name: instance.name })}
              onClick={onLink}
            >
              <Link2 aria-hidden="true" />
              {t('instructions.link')}
            </Button>
          )}
        </CardHeader>
        {view && (
          <CardContent className="flex flex-col gap-4">
            {view.state === 'paused' && <p className="text-sm text-muted-foreground">{t('instructions.paused')}</p>}
            {view.state === 'frozen' && <p className="text-sm text-muted-foreground">{t('instructions.frozen')}</p>}
            {view.waiting.length > 0 && (
              <section
                aria-label={t('instructions.waitingTitle')}
                className="flex flex-col gap-2 rounded-md border border-danger/40 bg-danger/5 p-3"
              >
                <h3 className="text-sm font-semibold">{t('instructions.waitingTitle')}</h3>
                {view.waiting.map((item) => (
                  <div key={item.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="flex items-start gap-2">
                      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
                      {t(item.status === 'damaged' ? 'instructions.waitingDamaged' : 'instructions.waitingEdited', {
                        file: displayPath(item.key, home),
                      })}
                    </span>
                    {item.status === 'edited' ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        aria-label={t('instructions.reviewLabel', { file: displayPath(item.key, home) })}
                        onClick={() => onReview(item.key)}
                      >
                        {t('instructions.review')}
                      </Button>
                    ) : (
                      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCheck}>
                        <RefreshCw aria-hidden="true" />
                        {t('instructions.checkAgain')}
                      </Button>
                    )}
                  </div>
                ))}
              </section>
            )}
            {view.tools.length > 0 && (
              <table
                aria-label={t('instructions.detailsLabel', { name: instance.name })}
                className="w-full text-left text-sm"
              >
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      {t('instructions.columns.tool')}
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      {t('instructions.columns.how')}
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      {t('instructions.columns.state')}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t('instructions.columns.room')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {view.tools.map((tool) => (
                    <tr key={tool.id}>
                      <th scope="row" className="py-2 pr-3 align-top font-medium">
                        {tool.name}
                      </th>
                      <td className="py-2 pr-3 align-top">
                        <span className="flex flex-col gap-1">
                          <span className="text-xs">{t(`instructions.how.${howOf(tool)}`)}</span>
                          {tool.artifacts.map((artifact) => (
                            <PathText key={artifact.key} path={artifact.key} home={home} />
                          ))}
                        </span>
                      </td>
                      <td className="py-2 pr-3 align-top">
                        <StateText tool={tool} />
                      </td>
                      <td className="py-2 align-top">
                        <RoomText tool={tool} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {cursor && (
              <section
                aria-label={t('instructions.cursorTitle')}
                className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3 text-sm"
              >
                <h3 className="font-semibold">{t('instructions.cursorTitle')}</h3>
                {linked && view.manualText !== null ? (
                  <>
                    <p>{t('instructions.cursorLinked')}</p>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-2 font-mono text-xs">
                      {view.manualText}
                    </pre>
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          onCopy(view.manualText ?? '');
                          setCopied(true);
                        }}
                      >
                        <Copy aria-hidden="true" />
                        {copied ? t('instructions.copied') : t('instructions.copy')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <p>{t('instructions.cursorUnlinked', { name: instance.name })}</p>
                )}
              </section>
            )}
          </CardContent>
        )}
      </Card>
    </section>
  );
}

/** The bring-in dialog (PLAN.md §3.12): the changed text and the library's, and the two answers. */
function ChangeDialog({
  file,
  home,
  previews,
  busy,
  onClose,
  onDecide,
}: {
  file: string;
  home: string | undefined;
  previews: { bringIn: InstructionPreviewView | null; discard: InstructionPreviewView };
  busy: boolean;
  onClose: () => void;
  onDecide: (decision: InstructionDecision, hash: string) => void;
}) {
  const { t } = useTranslation();
  const { bringIn, discard } = previews;
  return (
    <DialogShell
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('instructions.change.title', { file: displayPath(file, home) })}
      description={t('instructions.change.body')}
      footer={
        <>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {t('links.cancel')}
            </Button>
          </DialogClose>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => onDecide('discard', discard.hash)}>
            {t('instructions.change.discard')}
          </Button>
          {bringIn && (
            <Button type="button" disabled={busy} onClick={() => onDecide('bring-in', bringIn.hash)}>
              {t('instructions.change.bringIn')}
            </Button>
          )}
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 text-sm">
        <figure className="flex min-w-0 flex-col gap-1">
          <figcaption className="text-xs font-medium text-muted-foreground">
            {t('instructions.change.edited')}
          </figcaption>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted p-2 font-mono text-xs">
            {discard.edited}
          </pre>
        </figure>
        <figure className="flex min-w-0 flex-col gap-1">
          <figcaption className="text-xs font-medium text-muted-foreground">
            {t('instructions.change.library')}
          </figcaption>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted p-2 font-mono text-xs">
            {discard.library}
          </pre>
        </figure>
      </div>
      <p className="text-xs text-muted-foreground">
        {bringIn ? t('instructions.change.bringInNote') : t('instructions.change.importOnly')}
      </p>
    </DialogShell>
  );
}

export function InstructionsPageView({
  entries,
  home,
  actions,
}: {
  entries: readonly InstructionsEntry[];
  home: string | undefined;
  actions: InstructionsActions;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<{ instance: InstanceView; linked: string[] } | null>(null);
  const [review, setReview] = useState<{
    instanceId: string;
    key: string;
    previews: { bringIn: InstructionPreviewView | null; discard: InstructionPreviewView };
  } | null>(null);
  const run = (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    task()
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(false));
  };
  const link = (instance: InstanceView) => {
    const others = entries
      .filter((e) => e.instance.id !== instance.id && e.instance.instructionsLinked)
      .map((e) => e.instance.name);
    if (others.length > 0) setWarning({ instance, linked: others });
    else run(() => actions.setLinked(instance.id, 'link'));
  };
  const open = (instanceId: string, key: string, role: 'copy' | 'import') =>
    run(async () => {
      const discard = await actions.preview(instanceId, key, 'discard');
      const bringIn = role === 'copy' ? await actions.preview(instanceId, key, 'bring-in') : null;
      setReview({ instanceId, key, previews: { bringIn, discard } });
    });
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('instructions.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('instructions.intro')}</p>
      </header>
      {error && <ErrorMessage error={error} />}
      {entries.length === 0 && <p className="text-sm text-muted-foreground">{t('instructions.none')}</p>}
      {entries.map((entry) => (
        <CompanyCard
          key={entry.instance.id}
          entry={entry}
          home={home}
          busy={busy}
          onLink={() => link(entry.instance)}
          onUnlink={() => run(() => actions.setLinked(entry.instance.id, 'unlink'))}
          onReview={(key) =>
            open(entry.instance.id, key, entry.view?.waiting.find((w) => w.key === key)?.role ?? 'copy')
          }
          onCheck={() => run(() => actions.check(entry.instance.id))}
          onCopy={(text) => run(() => actions.copy(text))}
        />
      ))}
      {entries.length > 0 && <p className="text-xs text-muted-foreground">{t('instructions.sessions')}</p>}
      {warning && (
        <DialogShell
          open
          onOpenChange={(isOpen) => !isOpen && setWarning(null)}
          title={t('instructions.warning.title', { name: warning.instance.name })}
          description={t('instructions.warning.body', {
            name: warning.instance.name,
            linked: warning.linked.join(', '),
          })}
          footer={
            <>
              <DialogClose asChild>
                <Button type="button" variant="ghost">
                  {t('links.cancel')}
                </Button>
              </DialogClose>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await actions.setLinked(warning.instance.id, 'switch');
                    setWarning(null);
                  })
                }
              >
                {t('instructions.warning.switch', { name: warning.instance.name, linked: warning.linked.join(', ') })}
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await actions.setLinked(warning.instance.id, 'link-anyway');
                    setWarning(null);
                  })
                }
              >
                {t('instructions.warning.anyway')}
              </Button>
            </>
          }
        />
      )}
      {review && (
        <ChangeDialog
          file={review.key}
          home={home}
          previews={review.previews}
          busy={busy}
          onClose={() => setReview(null)}
          onDecide={(decision, hash) =>
            run(async () => {
              await actions.resolve(review.instanceId, review.key, decision, hash);
              setReview(null);
            })
          }
        />
      )}
    </div>
  );
}

export const instructionsActions: InstructionsActions = {
  setLinked: async (instanceId, action) => {
    await callDevice('setInstructionsLinked', { instanceId, action });
  },
  preview: (instanceId, key, decision) => queryInstance(instanceId, 'previewInstruction', { key, decision }),
  resolve: async (instanceId, key, decision, planHash) => {
    await callInstance(instanceId, 'resolveInstruction', { key, decision, planHash });
  },
  check: async (instanceId) => {
    await callInstance(instanceId, 'checkInstructions', {});
  },
  copy: async (text) => {
    await callDevice('copyText', { text });
  },
};

export function InstructionsPage() {
  const instances = useDeviceQuery('instances');
  const appInfo = useDeviceQuery('appInfo');
  const ready = (instances.data ?? []).filter((instance) => instance.status === 'ready');
  const views = useQueries({
    queries: ready.map((instance) => ({
      queryKey: keys.instance(instance.id, 'instructions'),
      queryFn: () => queryInstance(instance.id, 'instructions', {}),
    })),
  });
  if (!instances.data) return null;
  return (
    <InstructionsPageView
      entries={ready.map((instance, index) => ({ instance, view: views[index]?.data }))}
      home={appInfo.data?.homePath}
      actions={instructionsActions}
    />
  );
}
