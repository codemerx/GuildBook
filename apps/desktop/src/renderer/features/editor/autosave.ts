// Autosave (PLAN.md §3.14, A10.4): the text is saved about a second after typing stops; the worker writes it atomically.
// Each save names the version it was based on. A file changed on disk (a pull, a branch switch, an agent) reloads in
// the editor; when the editor has unsaved edits too, it asks which to keep.
import type { ErrorView } from '@app/schemas';

/** About a second after typing stops (PLAN.md §3.14). */
export const AUTOSAVE_DELAY_MS = 1000;

export type AutosaveStatus = 'saved' | 'editing' | 'saving' | 'conflict' | 'error';

export interface DiskVersion {
  readonly hash: string | null;
  readonly text: string;
}

export interface AutosaveState {
  readonly status: AutosaveStatus;
  /** The version on disk in the conflict, while it's asked which to keep. */
  readonly disk: DiskVersion | null;
  readonly error: ErrorView | null;
}

export interface AutosaveDeps {
  save(text: string, base: string | null): Promise<{ readonly hash: string }>;
  /** The file on disk replaces the editor's text. */
  reload(text: string): void;
  onState(state: AutosaveState): void;
  readonly delayMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

const isChangedOnDisk = (error: unknown) => (error as ErrorView | null)?.code === 'editor.changedOnDisk';

export class Autosave {
  readonly #deps: AutosaveDeps;
  /** The version on disk the editor's text is based on. */
  #base: string | null;
  /** The text on disk at `#base`. */
  #saved: string;
  /** The editor's text now. */
  #text: string;
  #timer: unknown = null;
  #saving: Promise<void> | null = null;
  /** The newest version seen on disk, kept while a save runs. */
  #seen: DiskVersion | null = null;
  #state: AutosaveState = { status: 'saved', disk: null, error: null };

  constructor(deps: AutosaveDeps, loaded: DiskVersion) {
    this.#deps = deps;
    this.#base = loaded.hash;
    this.#saved = loaded.text;
    this.#text = loaded.text;
  }

  get state(): AutosaveState {
    return this.#state;
  }

  /** Unsaved edits: the editor's text differs from the version it's based on. */
  get dirty(): boolean {
    return this.#text !== this.#saved;
  }

  /** The user changed the text. */
  edit(text: string): void {
    this.#text = text;
    if (this.#state.status === 'conflict') return;
    this.#set({ status: this.dirty ? 'editing' : 'saved', disk: null, error: null });
    this.#schedule();
  }

  /** Saves now, e.g. when the editor closes. */
  async flush(): Promise<void> {
    this.#cancelTimer();
    if (this.#saving) await this.#saving;
    if (!this.dirty || this.#state.status === 'conflict') return;
    const text = this.#text;
    this.#set({ status: 'saving', disk: null, error: null });
    this.#saving = (async () => {
      try {
        const { hash } = await this.#deps.save(text, this.#base);
        this.#base = hash;
        this.#saved = text;
        this.#set({ status: this.dirty ? 'editing' : 'saved', disk: null, error: null });
      } catch (error) {
        if (isChangedOnDisk(error)) this.#set({ status: 'conflict', disk: this.#seen, error: null });
        else this.#set({ status: 'error', disk: null, error: error as ErrorView });
      } finally {
        this.#saving = null;
      }
    })();
    await this.#saving;
    // The save changed the state meanwhile: read it again.
    const status = this.state.status;
    if (this.#seen && status !== 'conflict') this.disk(this.#seen);
    else if (this.dirty && status === 'editing') this.#schedule();
  }

  /** The file as it is on disk now: reloads it, or asks when the editor has unsaved edits. */
  disk(version: DiskVersion): void {
    this.#seen = version;
    if (this.#saving) return;
    if (version.hash === this.#base) {
      this.#seen = null;
      return;
    }
    if (version.text === this.#text) {
      // The same text, e.g. written by this editor's last save: nothing to ask.
      this.#base = version.hash;
      this.#saved = version.text;
      this.#seen = null;
      this.#set({ status: 'saved', disk: null, error: null });
      return;
    }
    if (this.dirty) {
      this.#cancelTimer();
      this.#set({ status: 'conflict', disk: version, error: null });
      return;
    }
    this.#useDisk(version);
  }

  /** The conflict's answer: keep the editor's text, saved over the version on disk. */
  async keepMine(): Promise<void> {
    const disk = this.#state.disk ?? this.#seen;
    if (disk) this.#base = disk.hash;
    this.#seen = null;
    this.#set({ status: 'editing', disk: null, error: null });
    await this.flush();
  }

  /** The conflict's answer: the version on disk replaces the editor's text. */
  useDisk(): void {
    const disk = this.#state.disk ?? this.#seen;
    if (disk) this.#useDisk(disk);
  }

  dispose(): void {
    this.#cancelTimer();
  }

  #useDisk(version: DiskVersion): void {
    this.#cancelTimer();
    this.#base = version.hash;
    this.#saved = version.text;
    this.#text = version.text;
    this.#seen = null;
    this.#set({ status: 'saved', disk: null, error: null });
    this.#deps.reload(version.text);
  }

  #schedule(): void {
    this.#cancelTimer();
    if (!this.dirty) return;
    const setTimer = this.#deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#timer = setTimer(() => {
      this.#timer = null;
      void this.flush();
    }, this.#deps.delayMs ?? AUTOSAVE_DELAY_MS);
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    const clearTimer = this.#deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clearTimer(this.#timer);
    this.#timer = null;
  }

  #set(state: AutosaveState): void {
    this.#state = state;
    this.#deps.onState(state);
  }
}
