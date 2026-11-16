// After the download (PLAN.md §3.17 step 4): library.yaml says whether the repo is a library this app can join. Its id
// is compared with this device's instances, which catches the same library under another URL (§3.1). A library that
// is too new for this app stops the join after the download; the download is kept for after the update (§3.2).
import { LibraryIdSchema } from '@app/schemas';
import { type Compatibility, readLibraryConfig } from '../../library/index.ts';

export type DownloadedLibrary =
  | { readonly kind: 'ok'; readonly id: string; readonly prefix: string }
  /** The same library is connected under another URL: Change URL is offered instead (A4.4). */
  | { readonly kind: 'sameLibrary'; readonly id: string; readonly instanceId: string; readonly name: string }
  /** The library's `format` or `minAppVersion` is newer than this app (A4.5). `id` is null when it can't be kept. */
  | {
      readonly kind: 'needsUpdate';
      readonly reason: Exclude<Compatibility, 'ok' | 'unknown'>;
      readonly id: string | null;
      readonly prefix: string | null;
    }
  /** No valid prefix: "This library isn't set up yet" (PLAN.md §3.2). */
  | { readonly kind: 'notSetUp' }
  /** A prefix, but no valid id: the library can't become an instance. */
  | { readonly kind: 'idInvalid' };

export function checkDownloadedLibrary(
  text: string | null,
  appVersion: string,
  connected: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): DownloadedLibrary {
  const config = readLibraryConfig(text, appVersion);
  const id = LibraryIdSchema.safeParse(config.value.id).success ? (config.value.id ?? null) : null;
  const same = id === null ? undefined : connected.find((instance) => instance.id === id);
  if (id !== null && same) return { kind: 'sameLibrary', id, instanceId: same.id, name: same.name };
  if (config.compatibility === 'formatTooNew' || config.compatibility === 'appTooOld') {
    return { kind: 'needsUpdate', reason: config.compatibility, id, prefix: config.prefix };
  }
  if (config.prefix === null) return { kind: 'notSetUp' };
  if (id === null) return { kind: 'idInvalid' };
  return { kind: 'ok', id, prefix: config.prefix };
}
