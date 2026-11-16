// The notice before macOS's folder-access prompt (Step 17, A17.9): a repo inside Desktop, Documents or Downloads is
// read again at every start, and macOS asks the user once whether the app may read that folder. The window explains
// the prompt first, after the folder dialog and before the app reads the folder. Each folder's notice shows once.
import { brand } from '@app/brand';
import type { ProtectedFolder } from '@app/schemas';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { callDevice } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { DialogShell } from '../../ui/dialog.tsx';

interface Pending {
  readonly folder: ProtectedFolder;
  readonly answer: (go: boolean) => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const setPending = (next: Pending | null) => {
  pending = next;
  for (const listener of listeners) listener();
};

/** Waits for the user's answer to the notice: true for [Continue]. */
export function askFolderAccess(folder: ProtectedFolder): Promise<boolean> {
  return new Promise((resolve) => {
    pending?.answer(false);
    setPending({ folder, answer: resolve });
  });
}

/** The folder dialog for a repo (also its new place) or a parent folder: null when cancelled, here or in the notice. */
export async function pickFolder(purpose: 'repo' | 'repo-root'): Promise<string | null> {
  const { path, accessNotice } = await callDevice('chooseFolder', { purpose });
  if (path === null || !accessNotice) return path;
  if (!(await askFolderAccess(accessNotice))) return null;
  await callDevice('noticeFolderAccess', { folder: accessNotice });
  return path;
}

export function FolderAccessNoticeView({
  folder,
  onAnswer,
}: {
  folder: ProtectedFolder;
  onAnswer: (go: boolean) => void;
}) {
  const { t } = useTranslation();
  const name = t(`folderAccess.folder.${folder}`);
  return (
    <DialogShell
      open
      onOpenChange={(open) => !open && onAnswer(false)}
      title={t('folderAccess.title', { folder: name })}
      description={t('folderAccess.body', { folder: name, appName: brand.displayName })}
      footer={
        <>
          <Button variant="outline" onClick={() => onAnswer(false)}>
            {t('folderAccess.cancel')}
          </Button>
          <Button onClick={() => onAnswer(true)}>{t('folderAccess.continue')}</Button>
        </>
      }
    >
      <p className="text-sm">{t('folderAccess.choose', { appName: brand.displayName })}</p>
    </DialogShell>
  );
}

/** Mounted once in the app shell: shows the notice while a folder dialog waits for it. */
export function FolderAccessNotice() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
  );
  if (!current) return null;
  return (
    <FolderAccessNoticeView
      folder={current.folder}
      onAnswer={(go) => {
        setPending(null);
        current.answer(go);
      }}
    />
  );
}
