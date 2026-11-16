// The library page's location card (Step 9): where the library folder is, [Change location…] (PLAN.md §3.9) and
// [Remove … from this computer] (§3.8 S12).
import type { InstanceView } from '@app/ipc';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { RemoveDialog } from '../library/remove-dialog.tsx';
import { RelocationDialog, relocationActions, type RelocationActions } from './relocation-dialog.tsx';

export function LocationCard({
  instance,
  home,
  actions,
}: {
  instance: InstanceView;
  home: string | undefined;
  actions?: RelocationActions;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const live = useMemo(() => actions ?? relocationActions(instance.id), [actions, instance.id]);
  return (
    <Card role="region" aria-label={t('relocation.card')}>
      <CardHeader>
        <CardTitle>{t('relocation.card')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <PathText path={instance.libraryPath} home={home} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
            {t('relocation.change')}
          </Button>
          <RemoveDialog instance={instance} home={home} trigger="library" />
        </div>
      </CardContent>
      {open && <RelocationDialog instance={instance} home={home} actions={live} onOpenChange={setOpen} />}
    </Card>
  );
}
