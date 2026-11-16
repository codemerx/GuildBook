// The skill-link reconciler (IMPLEMENTATION.md §2.5, PLAN.md §3.5, §3.8): its I/O parts. `observe` inspects exactly the
// paths the wanted links and the registry name, and nothing else in the tool folders: lstat, readlink, and for a real
// folder at one of those paths its fingerprint (PLAN.md §3.7 rule 2). `apply` runs one step through the guarded file
// system and checks the path first, so a step repeated after a crash does no harm. A path that changed since the plan
// stops the apply (`plan.changed`); the next check plans again.
// Copy mode (Step 16): a folder at a path is opened only to read the app's marker file, and fingerprinted only when
// the marker names this instance and the path's skill. A copy is written from the library's folder, with the marker
// added and the files the library's ignore rules match left out.
import { brand } from '@app/brand';
import {
  CopyMarkerSchema,
  editSkillMd,
  LINK_FOLDER_KIND,
  type LinkFolderRow,
  SKILL_LINK_KIND,
  type SkillLinkRow,
  SkillLinkRowSchema,
  type TrashReason,
} from '@app/schemas';
import type { InstanceTrash } from '../../activity/index.ts';
import type { PlanBody, Reconciler } from '../../engine/index.ts';
import { fingerprintFolder, workingTreeSource } from '../../library/index.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Links } from '../../ports/links.ts';
import type { Logger } from '../../ports/logger.ts';
import type { RegistryRecord } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import { mapLimit } from '../../shared/map-limit.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import {
  desiredSkillLinks,
  itemOf,
  type PathState,
  planSkillLinks,
  rowAfter,
  type SkillLinkAction,
  type SkillLinkDesired,
  type SkillLinkInputs,
  type SkillLinkObserved,
  type SkillLinkScope,
  targetOf,
} from '../domain/skill-links.ts';
import { mirrorFolder } from './copy-folder.ts';
import type { LinkStrategy } from './link-strategy.ts';
import { skillCopies } from './skill-copy.ts';

/** Copy mode's marker file, at the top of each copy (PLAN.md §3.4). */
export const COPY_MARKER = brand.copyModeMarkerFile;

export interface SkillLinkReconcilerDeps {
  readonly fs: FileSystem;
  /** The guarded Links port, for links inside the library (a copy brought in keeps its links). */
  readonly links: Links;
  readonly strategy: LinkStrategy;
  readonly trash: InstanceTrash;
  readonly paths: PathFlavour;
  readonly logger: Logger;
  readonly libraryRoot: () => string;
  /** The company versions of a library item: its fingerprint now, and in git's history (S4 DETACHED, STALE). */
  readonly versions: (item: string) => Promise<{ current: string | null; older: readonly string[] }>;
  /**
   * Whether a code repo commits the path (S2, Step 6): asked of git for that one path (PLAN.md §3.7 rule 4). Global
   * paths are never committed.
   */
  readonly committed?: (checkout: string, dest: string) => Promise<boolean>;
  /**
   * Where a registered link points, for a row no plan wants any more: a link named after the local prefix points at its
   * projected copy (PLAN.md §3.3, Step 8). Undefined: the library.
   */
  readonly rowTarget?: (row: SkillLinkRow, dest: string) => string;
  /** Copy mode (Step 16): the instance's id, which its copies' markers name. */
  readonly instanceId?: string;
  /** Copy mode: which of these library paths (`skills/<folder>/…`) the library's ignore rules match. */
  readonly ignored?: (paths: readonly string[]) => Promise<ReadonlySet<string>>;
}

/** The states in which the path held our link, or still should: only there is a real folder fingerprinted. */
/** How many link paths are read at once in a check (Step 17): enough to keep the disk busy, few enough for git. */
const INSPECT_AT_ONCE = 16;

const OUR_STATES: readonly SkillLinkRow['status'][] = [
  'linked',
  'missing',
  'deleted',
  'diverged',
  'taken-over',
  'copy-changed',
];

export function readRow(record: RegistryRecord | undefined): SkillLinkRow | null {
  if (!record) return null;
  const parsed = SkillLinkRowSchema.safeParse(record.data);
  return parsed.success ? parsed.data : null;
}

/**
 * A reconciler for one scope: every path, or `only` some (a decision's plan, which shows and does nothing else), and
 * with `forgetChoices` when the instance is removed. A new one per call, so concurrent previews never share a scope.
 */
/** Errors that mean a path can't be written, whatever is there: the path is reported and the other steps go on. */
const BLOCKED_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT']);

export function skillLinkReconciler(
  deps: SkillLinkReconcilerDeps,
  scope: SkillLinkScope = {},
): Reconciler<SkillLinkInputs, SkillLinkDesired, SkillLinkObserved, SkillLinkAction> {
  const { fs, strategy, trash, paths } = deps;
  // The inputs of the plan being made: its strays and decisions are part of what the plan compares (S11).
  let current: SkillLinkInputs | undefined;
  // The folders a step made in a code repo, by the step's path, until its record: the link folder, and the ones above
  // it that weren't there either (PLAN.md §3.6 "Worktrees"). They go again once no link of the app is in them.
  const made = new Map<string, string[]>();
  // Copy mode: what each applied step left in its copy, until its record.
  const written = new Map<string, string>();
  const copies = skillCopies({
    fs,
    links: deps.links,
    paths,
    ignored: deps.ignored ?? (async () => new Set<string>()),
  });
  const isMarker = (relative: string) => relative === COPY_MARKER;
  // The app always names its instance; a reconciler made without one (a test) still writes a marker it can read.
  const instanceId = deps.instanceId ?? 'instance';
  const libraryFolder = (item: string) => targetOf(deps.libraryRoot(), item, paths) as AbsPath;
  const skillOf = (item: string) => item.slice(item.indexOf('/') + 1);

  /**
   * Both sides of a copy: the folder at `dest` and the library's folder of `item`, read under the git name. The
   * copy's SKILL.md has the link's name, which differs from the git name under a local prefix (PLAN.md §3.3).
   */
  const copySides = async (dest: string, item: string) => {
    const skill = skillOf(item);
    const copy = await copies.read(dest as AbsPath, isMarker);
    const library = await copies.read(libraryFolder(item));
    const ignored = await copies.ignoredOf(skill, copy, library);
    const present = (await fs.lstat(libraryFolder(item)))?.kind === 'dir';
    return {
      copy: copies.fingerprint(copy, ignored, paths.basename(dest) === skill ? null : skill),
      library: present ? copies.fingerprint(library, ignored, null) : null,
      ignored,
    };
  };

  /** The marker of a folder, or undefined when it has none the app can read. */
  const readMarker = async (dest: string) => {
    const at = paths.join(dest, COPY_MARKER) as AbsPath;
    if ((await fs.lstat(at))?.kind !== 'file') return undefined;
    try {
      const parsed = CopyMarkerSchema.safeParse(JSON.parse(await fs.readText(at)));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };

  /** Makes `dest` a copy of the library's folder under the link's name, with the marker: what the copy holds now. */
  const writeCopy = async (action: { dest: string; folder: string; item: string; skill: string }) => {
    const dest = action.dest as AbsPath;
    if (!(await fs.lstat(action.folder as AbsPath))) await fs.mkdirp(action.folder as AbsPath);
    const before = await copySides(action.dest, action.item);
    const name = paths.basename(action.dest);
    await copies.mirror(
      libraryFolder(action.item),
      dest,
      name === action.skill ? null : name,
      before.ignored,
      isMarker,
    );
    const after = await copySides(action.dest, action.item);
    await writeMarker(dest, action.item, after.copy);
    written.set(action.dest, after.copy);
  };

  const writeMarker = async (dest: AbsPath, item: string, contentFingerprint: string) => {
    const marker = { instance: instanceId, item, contentFingerprint };
    await fs.writeTextAtomic(paths.join(dest, COPY_MARKER) as AbsPath, `${JSON.stringify(marker, null, 2)}\n`);
  };

  /**
   * A folder at a link path to the trash. A copy on another disk than the trash (WSL, a mounted folder) can't be
   * renamed into it: an unchanged copy, which the library can make again, is removed file by file there; an edited
   * one is copied into the trash first.
   */
  const discard = async (dest: AbsPath, reason: TrashReason, skill: string) => {
    try {
      await trash.put(dest, reason, skill);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
      if (code !== 'EXDEV' || (await fs.lstat(dest))?.kind !== 'dir') throw error;
      const removeOriginal = async (at: AbsPath) => {
        await copies.clear(at);
        await fs.removeEmptyFolder(at);
      };
      if (reason === 'copy') await removeOriginal(dest);
      else {
        await trash.putCopy(dest, reason, skill, {
          copy: (from, to) => mirrorFolder({ fs, links: deps.links, paths }, from, to),
          removeOriginal,
        });
      }
    }
  };

  /** The folders from the checkout down to `folder` that aren't there, the top one first. */
  const missingFolders = async (folder: string, checkout: string): Promise<string[]> => {
    const missing: string[] = [];
    for (let at = folder; paths.isInside(checkout, at) && !paths.same(at, checkout); at = paths.dirname(at)) {
      if (await fs.lstat(at as AbsPath)) break;
      missing.unshift(at);
    }
    return missing;
  };

  /**
   * What one path holds. A real folder is fingerprinted only where our link was (S4): a folder at a path the app
   * never linked is the user's own (S2), and nothing in it is opened (PLAN.md §3.7 rules 2 and 3). A copy's marker is
   * looked for only where our link or copy was, or in a copy-mode folder, which the user gave the app for its copies.
   */
  const inspect = async (
    dest: string,
    item: string | null,
    expected: string | null,
    ours: boolean,
    checkout: string | null,
    copyFolder: boolean,
  ): Promise<PathState> => {
    const at = dest as AbsPath;
    const entry = await fs.lstat(at);
    if (!entry) return { kind: 'missing' };
    // In a code repo, a folder or file the repo commits is the repo's own (S2): it's never opened or replaced.
    if (checkout !== null && entry.kind !== 'link' && deps.committed && (await deps.committed(checkout, dest))) {
      return entry.kind === 'dir' ? { kind: 'dir', match: 'none', committed: true } : { kind: 'file', committed: true };
    }
    if (entry.kind === 'link') {
      const target = (await strategy.readTarget(at)) ?? '';
      const ours = expected !== null && target !== '' && paths.same(paths.normalize(target), expected);
      const resolves =
        ours && expected !== null && (await fs.lstat(paths.join(expected, 'SKILL.md') as AbsPath))?.kind === 'file';
      return { kind: 'link', target, ours, resolves };
    }
    if (entry.kind === 'dir') {
      // A copy-mode copy is known by its marker; only the app's own copy is opened further (Step 16).
      const marker = item === null || !(ours || copyFolder) ? undefined : await readMarker(dest);
      if (marker && item !== null) {
        const mine = marker.instance === instanceId && marker.item === item;
        if (!mine) return { kind: 'copy', ours: false, copy: '', library: null, marker: marker.contentFingerprint };
        const sides = await copySides(dest, item);
        return {
          kind: 'copy',
          ours: true,
          copy: sides.copy,
          library: sides.library,
          marker: marker.contentFingerprint,
        };
      }
      if (item === null || !ours) return { kind: 'dir', match: 'none' };
      const source = workingTreeSource(fs, paths, paths.dirname(dest) as AbsPath);
      const fingerprint = await fingerprintFolder(source, paths.basename(dest));
      const { current, older } = await deps.versions(item);
      const match = fingerprint === current ? 'current' : older.includes(fingerprint) ? 'older' : 'none';
      return { kind: 'dir', match };
    }
    return { kind: 'file' };
  };

  /** Makes the link, unless ours is there already. Anything else at the path means the plan is out of date. */
  const link = async (action: { dest: string; folder: string; target: string; checkout?: string | null }) => {
    const dest = action.dest as AbsPath;
    const there = await fs.lstat(dest);
    if (there) {
      const target = there.kind === 'link' ? await strategy.readTarget(dest) : undefined;
      if (target !== undefined && paths.same(paths.normalize(target), action.target)) return;
      throw new AppError('plan.changed', { path: action.dest });
    }
    if (!(await fs.lstat(action.folder as AbsPath))) {
      const checkout = action.checkout ?? null;
      if (checkout !== null) made.set(action.dest, await missingFolders(action.folder, checkout));
      await fs.mkdirp(action.folder as AbsPath);
    }
    await strategy.create(action.target as AbsPath, dest);
  };

  return {
    kind: SKILL_LINK_KIND,

    desired(inputs) {
      current = inputs;
      return desiredSkillLinks(inputs, scope, paths);
    },

    async observe(desired, registry) {
      const rows = new Map(registry.map((record) => [record.key, readRow(record)]));
      const library = (item: string) => targetOf(deps.libraryRoot(), item, paths);
      const items = new Map<string, { item: string; target: string; checkout: string | null; copy?: boolean }>(
        desired.map((d) => [
          d.dest,
          { item: d.item, target: d.target, checkout: d.checkout ?? null, copy: d.method === 'copy' },
        ]),
      );
      for (const stray of current?.strays ?? []) {
        if (items.has(stray.dest)) continue;
        const item = itemOf(stray.skill);
        items.set(stray.dest, { item, target: library(item), checkout: stray.checkout });
      }
      for (const [dest, row] of rows) {
        if (!row || items.has(dest)) continue;
        const target = deps.rowTarget?.(row, dest) ?? library(row.item);
        items.set(dest, { item: row.item, target: paths.normalize(target), checkout: null });
      }
      const only = scope.only;
      const dests = [...items.keys()].sort().filter((dest) => !only || only.includes(dest));
      // A few paths at a time: each is read on its own, and one at a time the check mostly waits for the disk.
      const observed = await mapLimit(dests, INSPECT_AT_ONCE, async (dest): Promise<SkillLinkObserved> => {
        const row = rows.get(dest) ?? null;
        const where = items.get(dest);
        // Our link was there: a folder now is S4. A taken name or the user's choice is the user's own (S2, S3, S4).
        const wasOurs = row !== null && OUR_STATES.includes(row.status);
        const checkout = where?.checkout ?? row?.checkout ?? null;
        return {
          dest,
          state: await inspect(
            dest,
            where?.item ?? null,
            where?.target ?? null,
            wasOurs,
            checkout,
            where?.copy === true || row?.method === 'copy',
          ),
          row,
        };
      });
      return observed;
    },

    plan(desired, observed): PlanBody<SkillLinkAction> {
      return planSkillLinks(
        {
          ...scope,
          strays: current?.strays ?? [],
          decisions: current?.decisions ?? {},
          ...(scope.only && current ? { allDesired: desiredSkillLinks(current, {}, paths) } : {}),
        },
        desired,
        observed,
        paths,
      );
    },

    async apply(action) {
      const dest = action.dest as AbsPath;
      switch (action.op) {
        case 'mark':
        case 'forget':
          return;
        case 'adopt':
          // A copy whose marker is behind (the library caught up with an edit) gets the content it holds now.
          if (action.method === 'copy' && action.contentFingerprint !== undefined) {
            if ((await readMarker(action.dest))?.contentFingerprint !== action.contentFingerprint) {
              await writeMarker(dest, action.item, action.contentFingerprint);
            }
          }
          return;
        case 'create':
          if (action.method === 'copy') {
            if (await fs.lstat(dest)) throw new AppError('plan.changed', { path: action.dest });
            return writeCopy(action);
          }
          return link(action);
        case 'refresh': {
          // Only the library moved: the copy must still hold what the plan saw, or it was edited meanwhile.
          const now = await copySides(action.dest, action.item);
          if (now.copy !== action.expect.copy) throw new AppError('plan.changed', { path: action.dest });
          return writeCopy(action);
        }
        case 'remove': {
          const there = await fs.lstat(dest);
          if (!there) return;
          if (action.copy) {
            const now = there.kind === 'dir' ? await copySides(action.dest, `skills/${action.skill}`) : null;
            if (now?.copy !== action.copy.expect) throw new AppError('plan.changed', { path: action.dest });
            await discard(dest, action.copy.changed ? 'diverged-copy' : 'copy', action.skill);
            return;
          }
          const target = there.kind === 'link' ? await strategy.readTarget(dest) : undefined;
          if (target === undefined || !paths.same(paths.normalize(target), paths.normalize(action.target))) {
            throw new AppError('plan.changed', { path: action.dest });
          }
          await strategy.remove(dest);
          return;
        }
        case 'drop': {
          // S11: the link the app didn't make goes to the trash, so the user can bring it back.
          const there = await fs.lstat(dest);
          if (!there) return;
          const target = there.kind === 'link' ? await strategy.readTarget(dest) : undefined;
          if (target === undefined || !paths.same(paths.normalize(target), paths.normalize(action.target))) {
            throw new AppError('plan.changed', { path: action.dest });
          }
          await trash.put(dest, 'other-link', action.skill);
          return;
        }
        case 'replace': {
          const there = await fs.lstat(dest);
          const ours =
            there?.kind === 'link' &&
            paths.same(paths.normalize((await strategy.readTarget(dest)) ?? ''), action.target);
          if (action.method === 'copy') {
            // Our link makes way for the copy; anything else goes to the trash first.
            if (ours) await strategy.remove(dest);
            else if (there) await discard(dest, action.trash, action.skill);
            return writeCopy(action);
          }
          if (there && !ours) await discard(dest, action.trash, action.skill);
          return link(action);
        }
        case 'move-aside': {
          const to = action.to as AbsPath;
          if (await fs.lstat(dest)) {
            if (await fs.lstat(to)) throw new AppError('links.pathTaken', { path: action.to });
            await fs.rename(dest, to);
          }
          if (action.rewriteName !== null) {
            const skillMd = paths.join(to, 'SKILL.md') as AbsPath;
            if ((await fs.lstat(skillMd))?.kind === 'file') {
              const edited = editSkillMd(await fs.readText(skillMd), { name: action.rewriteName });
              if (edited.ok) await fs.writeTextAtomic(skillMd, edited.text);
              else deps.logger.warn('the moved folder keeps its name line', { problem: edited.problem });
            }
          }
          return link(action);
        }
        case 'bring-in': {
          if (action.expect) {
            // A copy's change (Step 16): into the library under the git name, if neither side moved since the plan.
            const now = await copySides(action.dest, action.item);
            if (now.copy !== action.expect.copy || now.library !== action.expect.library) {
              throw new AppError('plan.changed', { path: action.dest });
            }
            await copies.mirror(dest, libraryFolder(action.item), action.skill, now.ignored, isMarker);
            if (action.method === 'copy') {
              const after = await copySides(action.dest, action.item);
              await writeMarker(dest, action.item, after.copy);
              written.set(action.dest, after.copy);
              return;
            }
            await discard(dest, 'diverged-copy', action.skill);
            return link(action);
          }
          if ((await fs.lstat(dest))?.kind === 'dir') {
            await mirrorFolder({ fs, links: deps.links, paths }, dest, action.target as AbsPath, { leave: isMarker });
            await discard(dest, 'diverged-copy', action.skill);
          }
          if (action.method === 'copy') return writeCopy(action);
          return link(action);
        }
      }
    },

    /**
     * A path the app may not write to (no permission, read-only, full): the path is reported as `no-access` and the other
     * steps go on. The next check plans the link again, so it comes by itself once the folder can be written.
     */
    failed(action, error) {
      if (!BLOCKED_CODES.has((error as { code?: unknown } | null)?.code as string)) return null;
      if (action.op === 'remove') {
        // The link stays and is planned for removal again at the next check; meanwhile the path is reported.
        return {
          op: 'mark',
          dest: action.dest,
          item: `skills/${action.skill}`,
          skill: action.skill,
          folder: action.folder ?? '',
          repo: action.repo ?? null,
          checkout: action.checkout ?? null,
          status: 'skipped',
          reason: 'no-access',
          takenBy: null,
        };
      }
      if (action.op !== 'create' && action.op !== 'replace' && action.op !== 'move-aside' && action.op !== 'refresh') {
        return null;
      }
      written.delete(action.dest);
      return {
        op: 'mark',
        dest: action.dest,
        item: action.item,
        skill: action.skill,
        folder: action.folder,
        repo: action.repo ?? null,
        checkout: action.checkout ?? null,
        ...(action.nameSource ? { nameSource: action.nameSource } : {}),
        ...(action.method ? { method: action.method } : {}),
        status: 'skipped',
        reason: 'no-access',
        takenBy: null,
      };
    },

    record(action, registry, now) {
      const before = readRow(registry.get(SKILL_LINK_KIND, action.dest));
      const after = rowAfter(action, before, now, written.get(action.dest) ?? null);
      written.delete(action.dest);
      if (after) registry.put(SKILL_LINK_KIND, action.dest, after, now);
      else registry.delete(SKILL_LINK_KIND, action.dest);
      // The folders this step made in a code repo are the app's: the made-folder reconciler removes them again.
      const folders = made.get(action.dest) ?? [];
      made.delete(action.dest);
      if (folders.length === 0 || !('checkout' in action) || !action.checkout || !action.repo) return;
      for (const folder of folders) {
        const row: LinkFolderRow = { folder, repo: action.repo, checkout: action.checkout, createdAt: now };
        registry.put(LINK_FOLDER_KIND, folder, row, now);
      }
    },
  };
}
