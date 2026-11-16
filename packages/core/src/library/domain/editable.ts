// What the editor may open and change in the library (PLAN.md §3.14): the files of a skill and the company's
// instructions. Paths are relative to the library, with forward slashes, and never leave the skill they name.
import { FILE_SIZE_MAX, FILE_SIZE_WARN } from '@app/schemas';
import { INSTRUCTIONS_FILE, SKILLS_DIR } from './snapshot.ts';

/** The instructions file in the library. */
export const INSTRUCTIONS_PATH = INSTRUCTIONS_FILE;

/** The folders a dropped file can go into (PLAN.md §3.14 "drag-and-drop into assets/ and references/"). */
export const DROP_FOLDERS = ['assets', 'references', 'scripts'] as const;
export type DropFolder = (typeof DROP_FOLDERS)[number];

export type EditablePath =
  { readonly kind: 'skill'; readonly skill: string; readonly file: string } | { readonly kind: 'instructions' };

const segmentOk = (segment: string) =>
  segment !== '' && segment !== '.' && segment !== '..' && !/[\\:\0]/.test(segment) && segment.trim() === segment;

/** A library path the editor may work on, or null. `skills/<skill>/<file…>` or the instructions file. */
export function editablePath(path: string): EditablePath | null {
  if (path === INSTRUCTIONS_PATH) return { kind: 'instructions' };
  const segments = path.split('/');
  if (segments.length < 3 || segments[0] !== SKILLS_DIR || !segments.every(segmentOk)) return null;
  // Git's own folder is never a skill file.
  if (segments.slice(2).some((s) => s.toLowerCase() === '.git')) return null;
  return { kind: 'skill', skill: segments[1]!, file: segments.slice(2).join('/') };
}

/** A file name a user may give a dropped file: one plain name. */
export function fileNameOk(name: string): boolean {
  return segmentOk(name) && !name.includes('/') && name.toLowerCase() !== '.git' && name.length <= 255;
}

export type FileKind = 'markdown' | 'text' | 'image' | 'binary';

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const MARKDOWN = /\.(md|markdown)$/i;

/** How the editor shows a file: Markdown in the editor, other text in source mode, images and binaries as previews. */
export function fileKind(name: string, bytes: Uint8Array): FileKind {
  if (IMAGE.test(name)) return 'image';
  if (!isText(bytes)) return 'binary';
  return MARKDOWN.test(name) ? 'markdown' : 'text';
}

/** Text: valid UTF-8 without NUL bytes in its first 8 KiB, as git decides. */
export function isText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.length < bytes.length ? trimPartial(head) : head);
    return true;
  } catch {
    return false;
  }
}

/** A cut at 8 KiB may split a character: leave its first bytes out. */
function trimPartial(bytes: Uint8Array): Uint8Array {
  const end = bytes.length;
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const byte = bytes[end - back]!;
    if ((byte & 0xc0) === 0xc0) return bytes.subarray(0, end - back);
    if ((byte & 0x80) === 0) break;
  }
  return bytes.subarray(0, end);
}

/** Adding a file this size: over 10 MB a warning, over 50 MB refused (PLAN.md §3.19, A10.7). */
export function fileSizeRule(size: number): 'ok' | 'large' | 'tooLarge' {
  if (size > FILE_SIZE_MAX) return 'tooLarge';
  return size > FILE_SIZE_WARN ? 'large' : 'ok';
}
