// The device registry: the only writer of device.json (IMPLEMENTATION.md §2.1, §2.7). Writes are atomic and one at a
// time. An older file is migrated after a backup; a file from a newer app version, or one it can't read, is left
// untouched and nothing is written (A1.3, A1.17).
import { type DeviceFile, DeviceFileSchema } from '@app/schemas';
import type { Clock } from '../../ports/clock.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Random } from '../../ports/random.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import { newDeviceId } from '../../shared/ids.ts';
import { newDeviceFile, readDeviceFile } from '../domain/device-file.ts';

export type DeviceRegistryState = 'created' | 'current' | 'migrated' | 'newer' | 'unreadable';

export class DeviceRegistry {
  readonly #fs: FileSystem;
  readonly #file: AbsPath;
  readonly #clock: Clock;
  readonly #random: Random;
  readonly #logger: Logger;
  readonly #deviceName: string;
  #state: DeviceRegistryState | undefined;
  #current: DeviceFile | undefined;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(deps: {
    fs: FileSystem;
    file: AbsPath;
    clock: Clock;
    random: Random;
    logger: Logger;
    deviceName: string;
  }) {
    this.#fs = deps.fs;
    this.#file = deps.file;
    this.#clock = deps.clock;
    this.#random = deps.random;
    this.#logger = deps.logger;
    this.#deviceName = deps.deviceName;
  }

  async load(): Promise<DeviceRegistryState> {
    const now = new Date(this.#clock.now()).toISOString();
    if (!(await this.#fs.lstat(this.#file))) {
      this.#current = newDeviceFile(newDeviceId(this.#random), this.#deviceName);
      await this.#write(this.#current);
      return (this.#state = 'created');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await this.#fs.readText(this.#file));
    } catch (error) {
      this.#logger.error('device.json is not valid JSON; leaving it untouched', { error: String(error) });
      return (this.#state = 'unreadable');
    }
    const read = readDeviceFile(raw, now);
    switch (read.kind) {
      case 'current':
        this.#current = read.file;
        return (this.#state = 'current');
      case 'migrated':
        // Keep the old file, so going back to an earlier release still finds its data.
        await this.#fs.copyFile(this.#file, `${this.#file}.v${read.from}.bak` as AbsPath);
        await this.#write(read.file);
        this.#current = read.file;
        this.#logger.info('device.json migrated', { from: read.from });
        return (this.#state = 'migrated');
      case 'newer':
        this.#logger.warn('device.json is from a newer app version; leaving it untouched', { version: read.version });
        return (this.#state = 'newer');
      case 'invalid':
        this.#logger.error('device.json is not readable by this version; leaving it untouched', {
          reason: read.reason,
        });
        return (this.#state = 'unreadable');
    }
  }

  get state(): DeviceRegistryState | undefined {
    return this.#state;
  }

  /** Whether the file can be read and written: false for newer or unreadable data. */
  get usable(): boolean {
    return this.#current !== undefined;
  }

  get file(): DeviceFile {
    if (!this.#current) throw this.#unusable();
    return this.#current;
  }

  /** Changes the file: `change` edits a copy, which is checked and written atomically. Updates run one at a time. */
  update<T>(change: (draft: DeviceFile) => T): Promise<T> {
    const run = async (): Promise<T> => {
      if (!this.#current) throw this.#unusable();
      const draft = structuredClone(this.#current);
      const result = change(draft);
      const checked = DeviceFileSchema.parse(draft);
      await this.#write(checked);
      this.#current = checked;
      return result;
    };
    const next = this.#writes.then(run, run);
    this.#writes = next.catch(() => undefined);
    return next;
  }

  #unusable(): AppError {
    return new AppError(this.#state === 'newer' ? 'device.newerData' : 'device.unreadable');
  }

  async #write(file: DeviceFile): Promise<void> {
    await this.#fs.writeTextAtomic(this.#file, `${JSON.stringify(file, null, 2)}\n`);
  }
}
