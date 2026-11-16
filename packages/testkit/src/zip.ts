// A zip writer for tests (TESTING.md §4 `import-sources`): good archives, and the malicious ones the app must refuse
// (PLAN.md §3.18 C): `..` and absolute names, symbolic links, a file that lies about its size, too much content.
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipItem {
  readonly name: string;
  /** A file's content; a folder when `dir` is set, a symbolic link when `link` is. */
  readonly data?: string | Uint8Array;
  readonly dir?: boolean;
  /** A symbolic link's target (a Unix entry with the link's mode). */
  readonly link?: string;
  readonly method?: 'store' | 'deflate';
  /** The unpacked size the archive claims, when it lies. */
  readonly declaredSize?: number;
  readonly encrypted?: boolean;
  /** Unix permission bits, e.g. 0o755 for a script. */
  readonly mode?: number;
}

const encoder = new TextEncoder();

export function zipBytes(items: readonly ZipItem[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(encoder.encode(item.name));
    const content =
      item.link !== undefined
        ? Buffer.from(item.link)
        : item.dir
          ? Buffer.alloc(0)
          : Buffer.from(typeof item.data === 'string' ? encoder.encode(item.data) : (item.data ?? new Uint8Array()));
    const deflate = item.method === 'deflate' || (item.method === undefined && content.length > 64);
    const packed = deflate ? deflateRawSync(content) : content;
    const size = item.declaredSize ?? content.length;
    const crc = crc32(content);
    const type = item.link !== undefined ? 0o120000 : item.dir ? 0o040000 : 0o100000;
    const mode = type | (item.mode ?? (item.dir ? 0o755 : item.link !== undefined ? 0o777 : 0o644));
    const flags = 0x0800 | (item.encrypted ? 1 : 0);
    const method = deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
