// A skill's files (PLAN.md §3.14, A10.7): drop files into assets/ and references/ (or pick them, by keyboard too). A
// file over 10 MB asks first ("Large files slow down every pull"), one over 50 MB is refused (PLAN.md §3.19). Text
// files open in source mode; images are previewed through the asset protocol (IMPLEMENTATION.md §2.8); images and
// binary files can be replaced or deleted.
import type { SkillFileEntryView } from '@app/ipc';
import { FILE_SIZE_MAX, FILE_SIZE_WARN, type ErrorView } from '@app/schemas';
import { File as FileIcon, FileText, Folder, ImageIcon, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card.tsx';
import { DialogShell } from '../../ui/dialog.tsx';
import { cn } from '../../ui/cn.ts';
import { ErrorMessage } from '../errors/error-message.tsx';
import { formatSize } from './checks-panel.tsx';

export type DropTarget = 'assets' | 'references';
const TARGETS: readonly DropTarget[] = ['assets', 'references'];

/** A file to add: dropped (with its bytes) or picked in the OS dialog by main. */
export interface IncomingFile {
  readonly name: string;
  readonly size: number;
  readonly bytes: () => Promise<Uint8Array | null>;
}

export interface FilesActions {
  readonly add: (folder: DropTarget | null, name: string, bytes: Uint8Array, replace: boolean) => Promise<void>;
  /** The OS file dialog through main; null when cancelled. */
  readonly pick: () => Promise<IncomingFile | null>;
  readonly remove: (path: string) => Promise<void>;
}

/** The asset protocol's URL of a library file (IMPLEMENTATION.md §2.8). */
export function assetUrl(instanceId: string, path: string): string {
  return `asset://${instanceId}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const TEXT = /\.(md|markdown|txt|ya?ml|json|py|js|mjs|cjs|ts|tsx|jsx|sh|toml|csv|html?|css|xml)$/i;

export function fileLook(path: string): 'text' | 'image' | 'binary' {
  if (IMAGE.test(path)) return 'image';
  return TEXT.test(path) ? 'text' : 'binary';
}

function iconOf(entry: SkillFileEntryView): typeof FileIcon {
  if (entry.kind === 'dir') return Folder;
  const look = fileLook(entry.path);
  return look === 'image' ? ImageIcon : look === 'text' ? FileText : FileIcon;
}

type Pending =
  | {
      readonly kind: 'large';
      readonly file: IncomingFile;
      readonly folder: DropTarget | null;
      readonly replace: boolean;
    }
  | { readonly kind: 'tooLarge'; readonly file: IncomingFile };

export function FilesPanel({
  instanceId,
  skill,
  files,
  selected,
  onSelect,
  actions,
}: {
  instanceId: string;
  skill: string;
  files: readonly SkillFileEntryView[] | undefined;
  selected: string | null;
  onSelect: (path: string) => void;
  actions: FilesActions;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<ErrorView | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const send = async (file: IncomingFile, folder: DropTarget | null, replace: boolean) => {
    setError(null);
    const bytes = await file.bytes();
    if (bytes === null) return setPending({ kind: 'tooLarge', file });
    await actions.add(folder, file.name, bytes, replace);
    setAdded(folder === null ? file.name : `${folder}/${file.name}`);
  };
  /** The size rules first: over 50 MB refused, over 10 MB asked (A10.7). */
  const offer = (file: IncomingFile, folder: DropTarget | null, replace = false) => {
    if (file.size > FILE_SIZE_MAX) return setPending({ kind: 'tooLarge', file });
    if (file.size > FILE_SIZE_WARN) return setPending({ kind: 'large', file, folder, replace });
    send(file, folder, replace).catch((e: unknown) => setError(e as ErrorView));
  };
  const pickInto = (folder: DropTarget | null, replace = false, name?: string) => {
    actions
      .pick()
      .then((file) => {
        if (file) offer(name ? { ...file, name } : file, folder, replace);
      })
      .catch((e: unknown) => setError(e as ErrorView));
  };

  const entries = files ?? [];
  const selectedEntry = entries.find((entry) => entry.path === selected) ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('editor.files.title')}</CardTitle>
        <CardDescription>{t('editor.files.body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <ErrorMessage error={error} />}
        {added && (
          <p role="status" className="text-sm">
            {t('editor.files.added', { path: added })}
          </p>
        )}
        <ul aria-label={t('editor.files.list', { skill })} className="flex flex-col gap-0.5">
          {entries.map((entry) => {
            const Icon = iconOf(entry);
            const depth = entry.path.split('/').length - 1;
            return (
              <li key={entry.path} style={{ paddingLeft: `${depth * 1}rem` }}>
                {entry.kind === 'file' ? (
                  <button
                    type="button"
                    aria-pressed={selected === entry.path}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent aria-pressed:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => onSelect(entry.path)}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="truncate font-mono text-xs">{entry.path.split('/').at(-1)}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{formatSize(entry.size)}</span>
                  </button>
                ) : (
                  <span className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="font-mono text-xs">{entry.path.split('/').at(-1)}/</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        <div className="grid grid-cols-2 gap-3">
          {TARGETS.map((folder) => (
            <div
              key={folder}
              role="group"
              aria-label={t('editor.files.dropInto', { folder })}
              data-drop={folder}
              className={cn(
                'flex flex-col items-center gap-2 rounded-md border-2 border-dashed border-input p-4 text-center text-sm',
                over === folder && 'border-ring bg-accent',
              )}
              onDragOver={(event) => {
                event.preventDefault();
                setOver(folder);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                for (const file of Array.from(event.dataTransfer.files)) {
                  offer(
                    {
                      name: file.name,
                      size: file.size,
                      bytes: async () => new Uint8Array(await file.arrayBuffer()),
                    },
                    folder,
                  );
                }
              }}
            >
              <Upload aria-hidden="true" className="size-5 text-muted-foreground" />
              <span>{t('editor.files.drop', { folder })}</span>
              <Button type="button" variant="secondary" size="sm" onClick={() => pickInto(folder)}>
                {t('editor.files.pick', { folder })}
              </Button>
            </div>
          ))}
        </div>

        {selectedEntry && fileLook(selectedEntry.path) !== 'text' && (
          <section
            aria-label={t('editor.files.preview')}
            className="flex flex-col gap-3 rounded-md border border-border p-3"
          >
            <h3 className="font-mono text-sm">{selectedEntry.path}</h3>
            {fileLook(selectedEntry.path) === 'image' ? (
              <img
                src={assetUrl(instanceId, `skills/${skill}/${selectedEntry.path}`)}
                alt={t('editor.files.imageAlt', { name: selectedEntry.path })}
                className="max-h-72 max-w-full self-start rounded border border-border object-contain"
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('editor.files.binary', { size: formatSize(selectedEntry.size) })}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  const parts = selectedEntry.path.split('/');
                  const name = parts.pop() as string;
                  const folder = (parts.join('/') || null) as DropTarget | null;
                  pickInto(folder, true, name);
                }}
              >
                <Upload aria-hidden="true" />
                {t('editor.files.replace')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  actions
                    .remove(`skills/${skill}/${selectedEntry.path}`)
                    .catch((e: unknown) => setError(e as ErrorView));
                }}
              >
                <Trash2 aria-hidden="true" />
                {t('editor.files.delete')}
              </Button>
            </div>
          </section>
        )}

        <DialogShell
          open={pending?.kind === 'large'}
          onOpenChange={(open) => !open && setPending(null)}
          title={t('editor.files.largeTitle', { name: pending?.file.name ?? '' })}
          description={t('editor.files.largeBody', { size: formatSize(pending?.file.size ?? 0) })}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setPending(null)}>
                {t('editor.cancel')}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (pending?.kind !== 'large') return;
                  setPending(null);
                  send(pending.file, pending.folder, pending.replace).catch((e: unknown) => setError(e as ErrorView));
                }}
              >
                {t('editor.files.addAnyway')}
              </Button>
            </>
          }
        />
        <DialogShell
          open={pending?.kind === 'tooLarge'}
          onOpenChange={(open) => !open && setPending(null)}
          title={t('editor.files.tooLargeTitle', { name: pending?.file.name ?? '' })}
          description={t('editor.files.tooLargeBody', { size: formatSize(pending?.file.size ?? 0) })}
          footer={
            <Button type="button" onClick={() => setPending(null)}>
              {t('editor.ok')}
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
