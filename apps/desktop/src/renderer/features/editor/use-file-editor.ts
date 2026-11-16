// One library file in the editor (A10.4): loaded from the worker, saved by autosave, reloaded when it changes on disk
// (the query follows the worker's gitChanged event), and the question when both sides changed. A skill being reviewed
// for an import (Step 13) is edited the same way, in its staged copy.
import type { LibraryFileView } from '@app/ipc';
import type { ErrorView } from '@app/schemas';
import { useEffect, useRef, useState } from 'react';
import { callInstance, useInstanceQueryWith } from '../../rpc/queries.ts';
import { Autosave, type AutosaveState, type DiskVersion } from './autosave.ts';

export interface FileEditor {
  readonly file: LibraryFileView | undefined;
  /** Loading failed for another reason than a missing file. */
  readonly error: ErrorView | null;
  /** The editor's text; null until the file is loaded. */
  readonly text: string | null;
  /** Changes when another text is loaded into the editor. */
  readonly version: number;
  readonly state: AutosaveState;
  readonly edit: (text: string) => void;
  /** Loads another text into the editor as an edit (e.g. [Load from file…]); autosave saves it. */
  readonly replace: (text: string) => void;
  /** Saves what's unsaved now (e.g. before a rename). */
  readonly flush: () => Promise<void>;
  readonly keepMine: () => Promise<void>;
  readonly useDisk: () => void;
}

const idle: AutosaveState = { status: 'saved', disk: null, error: null };

function diskOf(file: LibraryFileView | undefined, missing: boolean): DiskVersion | null {
  if (file) return { hash: file.hash, text: file.text ?? '' };
  // A file that isn't there yet (e.g. the library has no instructions): the first save creates it.
  return missing ? { hash: null, text: '' } : null;
}

/** Where the file is: the library (the default), or the staged copy of a skill being reviewed for an import. */
export type FileSource = { readonly kind: 'library' } | { readonly kind: 'import'; readonly id: string };

const LIBRARY: FileSource = { kind: 'library' };

export function useFileEditor(
  instanceId: string | undefined,
  path: string | null,
  enabled = true,
  source: FileSource = LIBRARY,
): FileEditor {
  const imported = source.kind === 'import' ? source.id : null;
  const libraryQuery = useInstanceQueryWith(
    instanceId,
    'libraryFile',
    { path: path ?? '' },
    enabled && path !== null && imported === null,
  );
  const importQuery = useInstanceQueryWith(
    instanceId,
    'importFile',
    { id: imported ?? '', path: path ?? '' },
    enabled && path !== null && imported !== null,
  );
  const query = imported === null ? libraryQuery : importQuery;
  const error = (query.error ?? null) as ErrorView | null;
  const missing = error?.code === 'editor.notFound';
  const disk = diskOf(query.data, missing);
  const [text, setText] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<AutosaveState>(idle);
  // The path whose text `text` is: until a new path is loaded, the editor shows nothing.
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const autosave = useRef<{ path: string; controller: Autosave } | null>(null);

  // A new path: a new controller, from the first version on disk.
  useEffect(() => {
    if (!instanceId || path === null || !disk) return;
    if (autosave.current?.path === path) {
      autosave.current.controller.disk(disk);
      return;
    }
    autosave.current?.controller.dispose();
    const controller = new Autosave(
      {
        save: (value, base) =>
          imported === null
            ? callInstance(instanceId, 'saveFile', { path, text: value, base })
            : callInstance(instanceId, 'saveImportFile', { id: imported, path, text: value, base }),
        reload: (value) => {
          setText(value);
          setVersion((v) => v + 1);
        },
        onState: setState,
      },
      disk,
    );
    autosave.current = { path, controller };
    setLoadedPath(path);
    setText(disk.text);
    setVersion((v) => v + 1);
    setState(idle);
  }, [instanceId, path, imported, disk?.hash, disk?.text]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the file saves what's unsaved.
  useEffect(
    () => () => {
      const current = autosave.current;
      autosave.current = null;
      if (current) void current.controller.flush().finally(() => current.controller.dispose());
    },
    [path],
  );

  return {
    file: query.data,
    error: missing ? null : error,
    text: loadedPath === path ? text : null,
    version,
    state,
    edit: (value) => {
      setText(value);
      autosave.current?.controller.edit(value);
    },
    replace: (value) => {
      setText(value);
      setVersion((v) => v + 1);
      autosave.current?.controller.edit(value);
    },
    flush: async () => {
      await autosave.current?.controller.flush();
    },
    keepMine: async () => {
      await autosave.current?.controller.keepMine();
    },
    useDisk: () => autosave.current?.controller.useDisk(),
  };
}
