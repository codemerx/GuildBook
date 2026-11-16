// Secrets stay in main (IMPLEMENTATION.md §2.13 rule 9): one file in the data folder, each value encrypted with
// Electron's safeStorage (Keychain, DPAPI, libsecret). On Linux without a keyring, safeStorage can only use a weaker,
// built-in key: the app warns before it keeps a secret that way (PLAN.md §2 "Secrets", A4.13). In test mode the codec
// is plain and the file lives in the test root, so tests never touch the real keychain (TESTING.md §3); a test can
// make it act as a Linux computer without a keyring.
import { type AbsPath, AppError, type FileSystem } from '@app/core';
import { z } from 'zod';

/** os: the OS's secure storage; weak: Linux without a keyring; none: nothing can encrypt (yet). */
export type SecretProtection = 'os' | 'weak' | 'none';

export interface SecretCodec {
  /** 'os' encrypts with the OS's secure storage; 'plain' is for test mode only. */
  readonly kind: 'os' | 'plain';
  protection(): SecretProtection;
  /** Linux: from now on, encrypt with the weaker built-in key. Called only after the user saw the warning. */
  allowWeak(): void;
  encrypt(text: string): Uint8Array;
  decrypt(bytes: Uint8Array): string;
}

/** Test mode's codec: plain text, and a switch to act as a computer without a keyring (A4.13). */
export class PlainCodec implements SecretCodec {
  readonly kind = 'plain' as const;
  #keyring = true;
  #weakAllowed = false;

  simulateKeyring(available: boolean): void {
    this.#keyring = available;
    this.#weakAllowed = false;
  }

  protection(): SecretProtection {
    return this.#keyring ? 'os' : 'weak';
  }

  allowWeak(): void {
    this.#weakAllowed = true;
  }

  get weakAllowed(): boolean {
    return this.#weakAllowed;
  }

  encrypt(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }

  decrypt(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
  }
}

export const plainCodec: SecretCodec = new PlainCodec();

const SecretsFileSchema = z.object({
  schemaVersion: z.literal(1),
  codec: z.enum(['os', 'plain']),
  entries: z.record(z.string(), z.base64()),
});

type SecretsFile = z.infer<typeof SecretsFileSchema>;

export class SecretsService {
  readonly #fs: FileSystem;
  readonly #file: AbsPath;
  readonly #codec: SecretCodec;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: { fs: FileSystem; file: AbsPath; codec: SecretCodec }) {
    this.#fs = deps.fs;
    this.#file = deps.file;
    this.#codec = deps.codec;
  }

  /** What the workers are told (DeviceFacts.secretStorage): weak storage needs the user's go first. */
  get storage(): 'os' | 'weak' {
    return this.#codec.protection() === 'os' ? 'os' : 'weak';
  }

  async get(key: string): Promise<string | null> {
    const file = await this.#read();
    const value = file.entries[key];
    return value === undefined ? null : this.#codec.decrypt(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
  }

  set(key: string, value: string): Promise<void> {
    return this.#change((file) => {
      const protection = this.#codec.protection();
      if (protection === 'weak') this.#codec.allowWeak();
      else if (protection === 'none') throw new AppError('secrets.unavailable');
      const bytes = this.#codec.encrypt(value);
      file.entries[key] = btoa(String.fromCharCode(...bytes));
    });
  }

  delete(key: string): Promise<void> {
    return this.#change((file) => {
      delete file.entries[key];
    });
  }

  /** Every key under one prefix, e.g. an instance's `lib_…/`. */
  async keys(prefix: string): Promise<string[]> {
    return Object.keys((await this.#read()).entries).filter((key) => key.startsWith(prefix));
  }

  /** Moves every key under one prefix to another, in one write: a setup's secrets become its instance's. */
  movePrefix(from: string, to: string): Promise<void> {
    return this.#change((file) => {
      for (const key of Object.keys(file.entries).filter((k) => k.startsWith(from))) {
        const value = file.entries[key];
        if (value !== undefined) file.entries[`${to}${key.slice(from.length)}`] = value;
        delete file.entries[key];
      }
    });
  }

  /** Deletes every key under one prefix: a removed instance's or a cancelled setup's. */
  deletePrefix(prefix: string): Promise<void> {
    return this.#change((file) => {
      for (const key of Object.keys(file.entries).filter((k) => k.startsWith(prefix))) delete file.entries[key];
    });
  }

  #change(edit: (file: SecretsFile) => void): Promise<void> {
    const run = async () => {
      const file = await this.#read();
      edit(file);
      await this.#fs.writeTextAtomic(this.#file, `${JSON.stringify(file)}\n`);
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #read(): Promise<SecretsFile> {
    if (!(await this.#fs.lstat(this.#file))) return { schemaVersion: 1, codec: this.#codec.kind, entries: {} };
    const parsed = SecretsFileSchema.parse(JSON.parse(await this.#fs.readText(this.#file)));
    if (parsed.codec !== this.#codec.kind) throw new AppError('secrets.unavailable', { stored: parsed.codec });
    return parsed;
  }
}
