// The confirmation of a placement change (PLAN.md §3.6 "Every change that adds or removes links appears in … a
// confirmation first"): the worker previews the edits as a plan, the dialog says where each skill moves and how many
// links change, and [Apply] sends the plan's hash back (IMPLEMENTATION.md §2.5). A dialog may offer several answers,
// e.g. [Make it available everywhere] or [Turn it off]; each one applies its own plan.
import type { PlacementEditView, PlacementPlanView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { callInstance, queryInstance } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { DialogClose, DialogShell } from '../../ui/dialog.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { moveLine } from './move-text.ts';

export interface PlacementChoice {
  readonly label: string;
  readonly edits: readonly PlacementEditView[];
  readonly variant?: 'default' | 'secondary';
}

export interface PlacementActions {
  preview(edits: readonly PlacementEditView[]): Promise<PlacementPlanView>;
  apply(edits: readonly PlacementEditView[], planHash: string): Promise<void>;
}

export function placementActions(instanceId: string): PlacementActions {
  return {
    preview: (edits) => queryInstance(instanceId, 'previewPlacement', { edits: [...edits] }),
    async apply(edits, planHash) {
      await callInstance(instanceId, 'applyPlacement', { edits: [...edits], planHash });
    },
  };
}

/** The moves and the link changes of a plan, as sentences. */
export function PlanMoves({ plan }: { plan: PlacementPlanView }) {
  const { t } = useTranslation();
  const created = plan.changes.filter((c) => c.op === 'create' || c.op === 'replace').length;
  const removed = plan.changes.filter((c) => c.op === 'remove' || c.op === 'drop').length;
  return (
    <div className="flex flex-col gap-2 text-sm">
      {plan.moves.length === 0 && <p>{t('placement.confirm.noMoves')}</p>}
      {plan.moves.length > 0 && (
        <ul aria-label={t('placement.confirm.movesLabel')} className="flex flex-col gap-1">
          {plan.moves.map((move) => {
            const line = moveLine(move);
            return (
              <li key={move.skill} className="rounded-md border border-border px-3 py-1.5">
                {t(line.key, line.params)}
              </li>
            );
          })}
        </ul>
      )}
      {(created > 0 || removed > 0) && (
        <p className="text-muted-foreground">
          {[
            created > 0 ? t('placement.confirm.created', { count: created }) : null,
            removed > 0 ? t('placement.confirm.removed', { count: removed }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}

export function PlacementConfirm({
  actions,
  open,
  onOpenChange,
  title,
  description,
  choices,
  ready = true,
  children,
}: {
  actions: PlacementActions;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /** The first answer's plan is shown; each answer applies its own. */
  choices: readonly PlacementChoice[];
  /** False while the dialog still works out its choices: no answer can be applied yet. */
  ready?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const first = choices[0];
  const plan = useQuery({
    queryKey: ['placement-preview', first?.edits],
    enabled: open && first !== undefined,
    queryFn: () => actions.preview(first?.edits ?? []),
    gcTime: 0,
  });
  const choose = (choice: PlacementChoice) => {
    setBusy(true);
    setError(null);
    const planned = choice === first && plan.data ? Promise.resolve(plan.data) : actions.preview(choice.edits);
    planned
      .then((p) => actions.apply(choice.edits, p.hash))
      .then(() => onOpenChange(false))
      .catch((e: unknown) => setError(e as ErrorView))
      .finally(() => setBusy(false));
  };
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {t('links.cancel')}
            </Button>
          </DialogClose>
          {choices.map((choice, index) => (
            <Button
              key={choice.label}
              type="button"
              variant={choice.variant ?? (index === 0 ? 'default' : 'secondary')}
              disabled={busy || !ready || (choice === first && !plan.data)}
              onClick={() => choose(choice)}
            >
              {choice.label}
            </Button>
          ))}
        </>
      }
    >
      {children}
      {plan.data && <PlanMoves plan={plan.data} />}
      {plan.error && <ErrorMessage error={plan.error as unknown as ErrorView} />}
      {error && <ErrorMessage error={error} />}
    </DialogShell>
  );
}
