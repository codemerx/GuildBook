// The Archive port over the zip format (PLAN.md §3.18 C): `.zip` and `.skill` files. A small reader of the central
// directory and of stored or deflated entries, on node:zlib, so no zip package runs on files the user picked. It only
// reads: core checks every entry (imports/domain/archive.ts) before anything is written. ZIP64 archives (over 4 GB, or
// over 65,535 entries) are refused, far above what an import allows anyway.
import { type Archive, type ArchiveEntry, AppError } from '@app/core';
import { crc32, inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const COMMENT_MAX = 0xffff;
const UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

interface Parsed {
  readonly entries: ArchiveEntry[];
  /** Per entry: where its local header is, its packed size, its method and its CRC. */
  readonly raw: ReadonlyArray<{ offset: number; packed: number; method: number; crc: number }>;
}

const unreadable = (reason: string) => new AppError('archive.unreadable', { reason });

const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

/** Zip names are UTF-8 when flagged, else CP437; tools that don't flag UTF-8 mostly write it anyway. */
function decodeName(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

function parse(bytes: Uint8Array): Parsed {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  if (bytes.length < EOCD_SIZE) throw unreadable('tooShort');
  let eocd = -1;
  for (let at = bytes.length - EOCD_SIZE; at >= Math.max(0, bytes.length - EOCD_SIZE - COMMENT_MAX); at--) {
    if (u32(at) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw unreadable('noDirectory');
  const count = u16(eocd + 10);
  const size = u32(eocd + 12);
  const start = u32(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw unreadable('zip64');
  if (start + size > eocd) throw unreadable('directoryOutOfRange');
  const entries: ArchiveEntry[] = [];
  const raw: Parsed['raw'][number][] = [];
  let at = start;
  for (let index = 0; index < count; index++) {
    if (at + 46 > eocd || u32(at) !== CENTRAL) throw unreadable('badDirectory');
    const madeBy = u16(at + 4) >> 8;
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const packed = u32(at + 20);
    const unpacked = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const external = u32(at + 38);
    const offset = u32(at + 42);
    if (packed === 0xffffffff || unpacked === 0xffffffff || offset === 0xffffffff) throw unreadable('zip64');
    const nameEnd = at + 46 + nameLength;
    if (nameEnd > eocd) throw unreadable('badDirectory');
    const path = decodeName(bytes.subarray(at + 46, nameEnd));
    const mode = madeBy === UNIX ? (external >>> 16) & S_IFMT : 0;
    const kind: ArchiveEntry['kind'] =
      mode === S_IFLNK ? 'link' : path.endsWith('/') || mode === S_IFDIR || (external & 0x10) !== 0 ? 'dir' : 'file';
    entries.push({
      index,
      path,
      kind,
      size: kind === 'dir' ? 0 : unpacked,
      encrypted: (flags & 1) !== 0,
      supported: method === 0 || method === 8,
    });
    raw.push({ offset, packed, method, crc });
    at = nameEnd + extraLength + commentLength;
  }
  return { entries, raw };
}

export class ZipArchive implements Archive {
  readonly #parsed = new WeakMap<Uint8Array, Parsed>();

  #of(bytes: Uint8Array): Parsed {
    let parsed = this.#parsed.get(bytes);
    if (!parsed) {
      parsed = parse(bytes);
      this.#parsed.set(bytes, parsed);
    }
    return parsed;
  }

  async entries(archive: Uint8Array): Promise<ArchiveEntry[]> {
    return [...this.#of(archive).entries];
  }

  async read(archive: Uint8Array, entry: ArchiveEntry): Promise<Uint8Array> {
    const parsed = this.#of(archive);
    const raw = parsed.raw[entry.index];
    const listed = parsed.entries[entry.index];
    if (!raw || !listed || listed.kind !== 'file' || listed.encrypted || !listed.supported) {
      throw unreadable('notReadable');
    }
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    if (raw.offset + 30 > archive.length || view.getUint32(raw.offset, true) !== LOCAL) throw unreadable('badEntry');
    const dataStart = raw.offset + 30 + view.getUint16(raw.offset + 26, true) + view.getUint16(raw.offset + 28, true);
    const dataEnd = dataStart + raw.packed;
    if (dataEnd > archive.length) throw unreadable('badEntry');
    const packed = archive.subarray(dataStart, dataEnd);
    let bytes: Uint8Array;
    if (raw.method === 0) bytes = packed;
    else {
      try {
        // Never more than declared, plus one byte to notice an entry that lies about its size (a zip bomb).
        bytes = inflateRawSync(packed, { maxOutputLength: listed.size + 1 });
      } catch (error) {
        if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new AppError('archive.sizeMismatch', { path: listed.path });
        }
        throw unreadable('badData');
      }
    }
    if (bytes.length !== listed.size) throw new AppError('archive.sizeMismatch', { path: listed.path });
    if (crc32(bytes) !== raw.crc) throw unreadable('badChecksum');
    return new Uint8Array(bytes);
  }
}
