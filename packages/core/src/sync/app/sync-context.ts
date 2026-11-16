// What the git screens' use cases share (IMPLEMENTATION.md Step 11, PLAN.md §3.10): the library's repo, its files, the
// author of the app's commits, the link engine's dry run, the activity log, and the sync state's change events.
import type { GitIdentityValue } from '@app/schemas';
import type { ActivityLog } from '../../activity/index.ts';
import type { InstanceEngine } from '../../engine/index.ts';
import type { LibrarySnapshot, LibrarySource } from '../../library/index.ts';
import type { Clock } from '../../ports/clock.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { GitIdentity, GitRepo, Oid, PushRejection } from '../../ports/git.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Store } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import type { DomainEvent } from '../../shared/events.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import type { AppliedStateBaseline } from './applied-state.ts';

/**
 * The library as a pull would leave it (IMPLEMENTATION.md §2.5 "Dry runs can read a git tree"): its snapshot, read
 * from the tree git's merge produces with the uncommitted changes laid over it, that tree, and the skills git sees
 * renamed on the way (their choices move with them, S6).
 */
export interface PreviewLibrary {
  readonly snapshot: LibrarySnapshot;
  readonly tree: string;
  readonly renames: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /**
   * The local prefix the device would have after the pull (Step 14): the pull preview's answer when the new prefix
   * clashes here. Undefined: the one it has now.
   */
  readonly localPrefix?: string | null;
}

/** Where placement puts each skill of a preview library, and the ticked tags it no longer has. */
export interface PreviewPlaces {
  readonly placements: ReadonlyArray<{
    readonly skill: string;
    readonly kind: string;
    readonly global: boolean;
    /** Repo ids. */
    readonly repos: readonly string[];
  }>;
  /** Ticked tags no skill of the preview library carries, with the repos (ids) whose rule uses each (§3.6 Day 12). */
  readonly tagsGone: ReadonlyArray<{ readonly tag: string; readonly repos: readonly string[] }>;
}

/** Where a skill is linked: globally, in these repos (by name), or nowhere. */
export interface SyncPlacedWhere {
  readonly global: boolean;
  readonly repos: readonly string[];
}

/** The link plan a preview shows, as the link engine's plan view has it. */
export interface SyncPlanView {
  readonly hash: string;
  readonly changes: ReadonlyArray<{ readonly op: string; readonly skill: string; readonly dest: string }>;
}

/** A pull's link changes, before it runs (the link engine's `LinkPreview`). */
export interface SyncLinkPreview {
  readonly view: SyncPlanView;
  readonly hash: string;
  readonly links: ReadonlyArray<{ readonly dest: string; readonly target: string; readonly skill: string }>;
  readonly before: ReadonlyMap<string, SyncPlacedWhere>;
  readonly places: PreviewPlaces;
}

/** The link engine as the git screens see it: the pull preview's dry run, and the check after a change. */
export interface SyncLinks {
  /** The links a library would get (IMPLEMENTATION.md §2.5): the pull preview's dry run. */
  previewLibrary(library: PreviewLibrary, change: unknown): Promise<SyncLinkPreview>;
  /** The health check now, inside the command that changed the library: the links follow at once. */
  checkNow(emit: (event: DomainEvent) => void): Promise<unknown>;
  /** The pull preview's placement answers, written with the pull (PLAN.md §3.6 Day 8 and Day 12). */
  persistPlacement(change: unknown): void;
  /** Throws for placement answers that can't apply, before the preview shows them. */
  checkPlacement(change: unknown): void;
  repoName(id: string): string | null;
  /**
   * The renames that the editor made and git does not have yet (old folder → new name). A commit that holds both sides
   * is a rename, not a deletion to confirm.
   */
  renames?(): ReadonlyMap<string, string>;
}

/** What the sync module tells the user outside the app (PLAN.md §3.19 "Notifications"). */
export type SyncNotice =
  | {
      readonly type: 'incoming';
      readonly count: number;
      readonly authors: readonly string[];
      readonly skills: readonly string[];
    }
  | {
      /** The library changed with another git tool (a pull in a terminal), and the links followed. */
      readonly type: 'external';
      readonly count: number;
      readonly authors: readonly string[];
      readonly added: readonly string[];
      readonly removed: readonly string[];
      readonly renamed: ReadonlyArray<{ readonly from: string; readonly to: string }>;
    };

/**
 * What roles and signing add to the git screens (Step 12, PLAN.md §3.11): the review module provides
 * it; without it every push is tried and nothing is signed by the app.
 */
export interface SyncReviewHooks {
  /** Throws `review.notAllowed` when the role may not push this branch (a Viewer; a Member on the company branch). */
  checkPush(branch: string): Promise<void>;
  /** The host refused a push: what it teaches (classic protection, required signing) is remembered. */
  pushRejected(reason: PushRejection, branch: string): Promise<void>;
  /** The host requires signed commits and no key is chosen yet: the commit asks for one first. */
  signingKeyNeeded(): boolean;
}

/**
 * A pull that brings another git prefix (Step 14, PLAN.md §3.2 step 3), as the prefix module checks it on this device:
 * whether the new prefix clashes here, the local prefix kept or typed as the answer, and whether a local prefix can go.
 */
export interface SyncPrefixChange {
  readonly from: string;
  readonly gitPrefix: string;
  readonly clash: { readonly kind: 'instance'; readonly name: string } | { readonly kind: 'folders' } | null;
  readonly localPrefix: string | null;
  readonly suggestion: string | null;
  readonly answer: {
    readonly prefix: string;
    readonly problem: { readonly code: string } | null;
    readonly tooLong: readonly string[];
    readonly shorter: string | null;
  } | null;
  readonly dropOffered: boolean;
}

/** What the prefix change adds to the pull (Step 14); the prefix module provides it. */
export interface SyncPrefixHooks {
  /** The fetched library's prefix against this device's; null when the pull doesn't change it. */
  preview(library: LibrarySnapshot, answer: string | null): Promise<SyncPrefixChange | null>;
  /** The local prefix the pull needs: the answer, checked. Throws `prefix.localPrefixNeeded` before the merge. */
  answer(change: SyncPrefixChange, typed: string | null): string | null;
  /** After the merge: the adjustments, instead of a plain link check. */
  afterPull(change: SyncPrefixChange, answer: string | null, emit: (event: DomainEvent) => void): Promise<void>;
}

export interface SyncDeps {
  readonly engine: InstanceEngine;
  readonly store: Store;
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly activity: ActivityLog;
  readonly repo: GitRepo;
  readonly baseline: AppliedStateBaseline;
  readonly libraryRoot: () => string;
  readonly snapshot: () => LibrarySnapshot | null;
  /** Reads a library source into a snapshot, with the instance's context (the pull preview's library). */
  readonly scan: (source: LibrarySource) => Promise<LibrarySnapshot>;
  readonly links: SyncLinks;
  readonly appVersion: string;
  readonly deviceName: () => string;
  readonly notify: (notice: SyncNotice) => void;
  /** The sync state changed: the renderer asks again, and main gets the counts for the switcher and the tray. */
  readonly onChange: (counts: { incoming: number; toPush: number }) => void;
  /** Step 12's roles, requests and signing; set once the review module is built. */
  review?: SyncReviewHooks;
  /** Step 14's prefix change; set once the prefix module is built. */
  prefix?: SyncPrefixHooks;
}

/** Commit and push need an author; it's asked once when the host didn't give one (PLAN.md §3.10). */
export function identityOf(store: Store): GitIdentity | null {
  const settings = store.read((tx) => tx.settings.get());
  return settings.commitIdentity ?? store.read((tx) => tx.hostAccount.get())?.identity ?? null;
}

export function requireIdentity(store: Store): GitIdentity {
  const identity = identityOf(store);
  if (!identity) throw new AppError('sync.identityNeeded');
  return identity;
}

export function setIdentity(store: Store, identity: GitIdentityValue): void {
  store.write((tx) => tx.settings.set({ ...tx.settings.get(), commitIdentity: identity }));
}

/** A library path on disk. */
export function onDisk(deps: Pick<SyncDeps, 'paths' | 'libraryRoot'>, path: string): AbsPath {
  return deps.paths.join(deps.libraryRoot(), ...path.split('/')) as AbsPath;
}

/** A file's bytes at a commit or tree, or null when it isn't there (or isn't a file). */
export async function blobAt(repo: GitRepo, treeish: Oid, path: string): Promise<Uint8Array | null> {
  const entry = (await repo.listTree(treeish, path)).find((e) => e.path === path);
  if (!entry || (entry.kind !== 'file' && entry.kind !== 'executable')) return null;
  return repo.readBlob(entry.oid);
}

/** Text read for a diff or a conflict, or null for a binary file. */
export function textOf(bytes: Uint8Array | null): string | null {
  if (bytes === null) return null;
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return null;
  return new TextDecoder().decode(bytes);
}
