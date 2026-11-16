import { Link } from '@tanstack/react-router';
import { FolderPlus, Library, LogIn, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '../../ui/button.tsx';

export function EmptyState({ testLibraries }: { testLibraries: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 pt-24 text-center">
      <Library aria-hidden="true" className="size-10 text-muted-foreground" />
      <h1 className="text-2xl font-semibold">{t('empty.title')}</h1>
      <p className="text-muted-foreground">{t('empty.body')}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Link to="/connect" search={{ intent: 'join' }} className={buttonVariants()}>
          <LogIn aria-hidden="true" />
          {t('empty.join')}
        </Link>
        <Link to="/connect" search={{ intent: 'create' }} className={buttonVariants({ variant: 'secondary' })}>
          <FolderPlus aria-hidden="true" />
          {t('empty.create')}
        </Link>
      </div>
      {testLibraries && (
        <>
          <p className="text-sm text-muted-foreground">{t('empty.testHint')}</p>
          <Link to="/add-test-library" className={buttonVariants({ variant: 'outline' })}>
            <Plus aria-hidden="true" />
            {t('shell.addTestLibrary')}
          </Link>
        </>
      )}
    </div>
  );
}
