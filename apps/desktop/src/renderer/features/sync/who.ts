// Whose side a part of a conflict is, in words (PLAN.md §3.10: the buttons name it, because "current" and "incoming"
// swap places during a rebase). The conflicts page and the skill editor both use it.
import type { ConflictSideView } from '@app/ipc';
import { useTranslation } from 'react-i18next';
import { useInstanceQuery } from '../../rpc/queries.ts';

export function useWho(): (side: ConflictSideView) => string {
  const { t } = useTranslation();
  return (side) => {
    switch (side.kind) {
      case 'you':
        return t('sync.who.you');
      case 'person':
        return t('sync.who.person', { name: side.name });
      case 'stash':
        return t('sync.who.stash');
      case 'revert':
        return t('sync.who.revert');
    }
  };
}

/** The sides of the library's conflicts now, in words; generic words while none is under way. */
export function useConflictSides(instanceId: string | undefined): { current: string; incoming: string } {
  const who = useWho();
  const conflicts = useInstanceQuery(instanceId, 'conflicts');
  const data = conflicts.data;
  return {
    current: who(data?.current ?? { kind: 'you' }),
    incoming: data && data.incoming.kind !== 'you' ? who(data.incoming) : who({ kind: 'stash' }),
  };
}
