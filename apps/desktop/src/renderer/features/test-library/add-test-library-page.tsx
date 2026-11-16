// "Add test library" (Step 1's thin slice, test and development builds only): a name and a local folder. The form
// checks the same rules as main, from @app/schemas (IMPLEMENTATION.md §2.2).
import { zodResolver } from '@hookform/resolvers/zod';
import { type TestLibraryInput, TestLibraryInputSchema } from '@app/schemas';
import { useNavigate } from '@tanstack/react-router';
import { FolderOpen } from 'lucide-react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { RpcError } from '@app/ipc';
import { useDeviceCommand, useDeviceQuery } from '../../rpc/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader } from '../../ui/card.tsx';
import { FieldError, Input, Label } from '../../ui/input.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';

export function AddTestLibraryForm({
  onChooseFolder,
  onSubmit,
  onCancel,
  submitError,
  home,
}: {
  home: string | undefined;
  onChooseFolder: () => Promise<string | null>;
  onSubmit: (input: TestLibraryInput) => void;
  onCancel: () => void;
  submitError: RpcError | null;
}) {
  const { t } = useTranslation();
  const form = useForm<TestLibraryInput>({
    resolver: zodResolver(TestLibraryInputSchema),
    defaultValues: { name: '', path: '' },
  });
  const path = useWatch({ control: form.control, name: 'path' });
  const { errors } = form.formState;
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <h1 className="text-xl font-semibold leading-tight">{t('addTestLibrary.title')}</h1>
        <CardDescription>{t('addTestLibrary.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-5" noValidate onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="library-name">{t('addTestLibrary.name')}</Label>
            <Input
              id="library-name"
              placeholder={t('addTestLibrary.namePlaceholder')}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? 'library-name-error' : undefined}
              {...form.register('name')}
            />
            <FieldError id="library-name-error" message={errors.name?.message && t(errors.name.message)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span id="library-folder-label" className="text-sm font-medium">
              {t('addTestLibrary.folder')}
            </span>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                aria-describedby="library-folder-label library-folder-value"
                onClick={() =>
                  void onChooseFolder().then((chosen) => {
                    if (chosen) form.setValue('path', chosen, { shouldValidate: true });
                  })
                }
              >
                <FolderOpen aria-hidden="true" />
                {t('addTestLibrary.chooseFolder')}
              </Button>
              <span id="library-folder-value" className="min-w-0 truncate text-muted-foreground">
                {path ? (
                  <PathText path={path} home={home} />
                ) : (
                  <span className="text-xs">{t('addTestLibrary.noFolder')}</span>
                )}
              </span>
            </div>
            <FieldError id="library-folder-error" message={errors.path?.message && t(errors.path.message)} />
          </div>
          {submitError && <ErrorMessage error={{ code: submitError.code, params: submitError.params }} />}
          <div className="flex gap-3">
            <Button type="submit">{t('addTestLibrary.add')}</Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('addTestLibrary.cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function AddTestLibraryPage() {
  const navigate = useNavigate();
  const chooseFolder = useDeviceCommand('chooseFolder');
  const add = useDeviceCommand('addTestLibrary');
  const appInfo = useDeviceQuery('appInfo');
  return (
    <AddTestLibraryForm
      home={appInfo.data?.homePath}
      onChooseFolder={async () => {
        // A failure shows below the form, like a failed add.
        const chosen = await chooseFolder.mutateAsync({ purpose: 'test-library' }).catch(() => null);
        return chosen?.path ?? null;
      }}
      onSubmit={(input) =>
        add.mutate(input, {
          onSuccess: ({ id }) => void navigate({ to: '/library/$instanceId', params: { instanceId: id } }),
        })
      }
      onCancel={() => void navigate({ to: '/' })}
      submitError={
        [add.error, chooseFolder.error].find((error): error is RpcError => error instanceof RpcError) ?? null
      }
    />
  );
}
