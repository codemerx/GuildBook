// The confirmation of removing repos: one repo ([Remove repo], also S10's), or the repos a parent folder found (PLAN.md
// §3.6 "Adding repos"). A skill the removal leaves in no repo becomes available everywhere, as the rules say ("How
// placement is calculated"), so the dialog asks about each one, as a cell does when a skill leaves its last repo:
// "Available everywhere" is selected first, and "Turn it off" adds an Off edit for the skill. The plan shown, with
// those edits, is the plan applied.
import type { PlacementEditView, PlacementPlanView } from '@app/ipc';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { type PlacementActions, PlacementConfirm } from './placement-confirm.tsx';

/** The skills a plan makes available everywhere that weren't: in repos only before, or linked nowhere. */
export function lastRepoSkills(plan: PlacementPlanView): string[] {
  return plan.moves.filter((move) => !move.from.global && move.to.global).map((move) => move.skill);
}

/** The removal's edits, and an Off edit for each skill asked about that the user turns off. */
export function removalEdits(
  edits: readonly PlacementEditView[],
  asked: readonly string[],
  off: ReadonlySet<string>,
): PlacementEditView[] {
  return [
    ...edits,
    ...asked.filter((skill) => off.has(skill)).map((skill): PlacementEditView => ({ op: 'mode', skill, mode: 'off' })),
  ];
}

export function RemovalConfirm({
  actions,
  onOpenChange,
  title,
  description,
  label,
  edits,
  children,
}: {
  actions: PlacementActions;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  /** The answer's button, e.g. "Remove repo". */
  label: string;
  /** The removal alone. */
  edits: readonly PlacementEditView[];
  /** More of the removal's own choices, above the question, e.g. the repos to keep. */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  // The removal alone says which skills to ask about: the confirmation's own query while nothing is turned off.
  const removal = useQuery({
    queryKey: ['placement-preview', edits],
    queryFn: () => actions.preview(edits),
    gcTime: 0,
  });
  const asked = removal.data ? lastRepoSkills(removal.data) : [];
  const choose = (skill: string, turnOff: boolean) => {
    const next = new Set(off);
    if (turnOff) next.add(skill);
    else next.delete(skill);
    setOff(next);
  };
  return (
    <PlacementConfirm
      actions={actions}
      open
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      choices={[{ label, edits: removalEdits(edits, asked, off) }]}
      ready={removal.data !== undefined}
    >
      {children}
      {asked.length > 0 && (
        <section aria-label={t('placement.removal.title')} className="flex flex-col gap-2 text-sm">
          <h3 className="font-medium">{t('placement.removal.title')}</h3>
          <p className="text-muted-foreground">{t('placement.removal.body')}</p>
          {asked.map((skill) => (
            <fieldset key={skill} className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <legend className="float-left mr-2 font-mono text-xs leading-5">{skill}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`removal-${skill}`}
                  checked={!off.has(skill)}
                  onChange={() => choose(skill, false)}
                />
                {t('placement.removal.everywhere')}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`removal-${skill}`}
                  checked={off.has(skill)}
                  onChange={() => choose(skill, true)}
                />
                {t('placement.removal.turnOff')}
              </label>
            </fieldset>
          ))}
        </section>
      )}
    </PlacementConfirm>
  );
}
