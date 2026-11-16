// The local-prefix page (PLAN.md §3.3 step 1, Step 8): the library's git prefix is in use on this device already, by
// another library or by the user's own skills. The page says which, suggests a free prefix from the library's URL,
// checks each prefix typed against the device, and lists the skills that would go over 64 characters. When the user's
// own folders are what clashes, each of them can instead be moved or kept (PLAN.md §3.17 step 5, Step 15): the
// choices are only recorded, and [Finish] carries them out.
import type { SetupView } from '@app/ipc';
import { PrefixSchema, type SetupFolderChoice } from '@app/schemas';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { Input, Label } from '../../ui/input.tsx';
import { PathText } from '../../ui/path-text.tsx';
import { ErrorMessage } from '../errors/error-message.tsx';
import { LocalPrefixField, localPrefixMessage } from '../projection/local-prefix-field.tsx';

/** The last part of a path, with either separator. */
const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

function FolderChoices({
  view,
  home,
  busy,
  onChoose,
}: {
  view: SetupView;
  home: string | undefined;
  busy: boolean;
  onChoose: (choices: SetupFolderChoice[]) => void;
}) {
  const { t } = useTranslation();
  const page = view.localPrefix;
  const prefix = page?.gitPrefix ?? '';
  const [choices, setChoices] = useState<Record<string, { move: boolean; name: string }>>(() =>
    Object.fromEntries(
      (page?.folders ?? []).map((folder) => {
        const name = nameOf(folder);
        const base = name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : name;
        return [folder, { move: false, name: `${base || name}-mine` }];
      }),
    ),
  );
  if (!page || page.folders.length === 0) return null;
  const ready = page.folders.every((folder) => !choices[folder]?.move || (choices[folder]?.name.trim() ?? '') !== '');
  return (
    <section aria-labelledby="own-folders" className="flex flex-col gap-3 border-t border-border pt-4">
      <h3 id="own-folders" className="text-sm font-semibold">
        {t('setup.localPrefix.folders', { prefix })}
      </h3>
      <ul className="flex flex-col gap-3">
        {page.folders.map((folder) => {
          const choice = choices[folder] ?? { move: false, name: '' };
          const set = (next: Partial<typeof choice>) => setChoices({ ...choices, [folder]: { ...choice, ...next } });
          const id = `folder-${nameOf(folder)}`;
          return (
            <li key={folder} className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
              <span className="break-all">
                <PathText path={folder} home={home} />
              </span>
              <fieldset className="flex flex-wrap gap-4">
                <legend className="sr-only">{nameOf(folder)}</legend>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name={id} checked={choice.move} onChange={() => set({ move: true })} />
                  {t('setup.localPrefix.move')}
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name={id} checked={!choice.move} onChange={() => set({ move: false })} />
                  {t('setup.localPrefix.keep')}
                </label>
              </fieldset>
              {choice.move && (
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-name`}>{t('setup.localPrefix.newName', { folder: nameOf(folder) })}</Label>
                  <Input
                    id={`${id}-name`}
                    value={choice.name}
                    spellCheck={false}
                    className="w-64"
                    onChange={(e) => set({ name: e.target.value })}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">{t('setup.localPrefix.keepNote')}</p>
      <div>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !ready}
          onClick={() =>
            onChoose(
              page.folders.map((folder) => {
                const choice = choices[folder] ?? { move: false, name: '' };
                return choice.move
                  ? { path: folder, choice: 'move', name: choice.name.trim() }
                  : { path: folder, choice: 'keep', name: null };
              }),
            )
          }
        >
          {t('setup.localPrefix.continue')}
        </Button>
      </div>
    </section>
  );
}

export function LocalPrefixStep({
  view,
  home,
  busy,
  onCheck,
  onChoose,
  onChooseFolders,
}: {
  view: SetupView;
  home?: string | undefined;
  busy: boolean;
  onCheck: (prefix: string) => void;
  onChoose: (prefix: string) => void;
  onChooseFolders?: (choices: SetupFolderChoice[]) => void;
}) {
  const { t } = useTranslation();
  const page = view.localPrefix;
  const [prefix, setPrefix] = useState(page?.suggestion ?? '');
  const check = useRef(onCheck);
  useEffect(() => {
    check.current = onCheck;
  }, [onCheck]);
  // Each valid prefix typed is checked against the device, once the typing pauses.
  const checked = page?.check?.prefix;
  useEffect(() => {
    if (!PrefixSchema.safeParse(prefix).success || checked === prefix) return;
    const timer = setTimeout(() => check.current(prefix), 200);
    return () => clearTimeout(timer);
  }, [prefix, checked]);
  if (!page) return null;
  const problem = localPrefixMessage(t, prefix, page.check);
  const ready = checked === prefix && problem === undefined && PrefixSchema.safeParse(prefix).success;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('setup.localPrefix.title')}</CardTitle>
        <CardDescription>
          {page.clash.kind === 'instance'
            ? t('setup.localPrefix.clashInstance', { prefix: page.gitPrefix, name: page.clash.name })
            : t('setup.localPrefix.clashFolders', { prefix: page.gitPrefix })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) onChoose(prefix);
          }}
        >
          <p className="text-sm">{t('setup.localPrefix.explain', { prefix: page.gitPrefix })}</p>
          <LocalPrefixField id="local-prefix" value={prefix} check={page.check} busy={busy} onChange={setPrefix} />
          {view.error && <ErrorMessage error={view.error} />}
          <div>
            <Button type="submit" disabled={busy || !ready}>
              {t('setup.localPrefix.use')}
            </Button>
          </div>
        </form>
        {onChooseFolders && <FolderChoices view={view} home={home} busy={busy} onChoose={onChooseFolders} />}
      </CardContent>
    </Card>
  );
}
