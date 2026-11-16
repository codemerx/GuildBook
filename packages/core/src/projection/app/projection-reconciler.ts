// The projected-copy reconciler's I/O parts (PLAN.md §3.3, IMPLEMENTATION.md §2.5). `observe` reads each copy and its
// library folder through the guarded file system and fingerprints both, the copy with its git name restored, and the
// files the library's ignore rules match left out. `apply` checks the side it overwrites first: a side that changed
// since the plan stops the apply (`plan.changed`), and the next check plans again. A link inside a skill stays a link
// in its copy and the other way round (PLAN.md §3.15).
import { PROJECTED_COPY_KIND, type ProjectedCopyRow, ProjectedCopyRowSchema } from '@app/schemas';
import type { InstanceTrash } from '../../activity/index.ts';
import type { PlanBody, Reconciler } from '../../engine/index.ts';
import { skillCopies } from '../../links/index.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Links } from '../../ports/links.ts';
import type { Logger } from '../../ports/logger.ts';
import type { RegistryRecord } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import {
  planProjection,
  type ProjectionAction,
  type ProjectionDesired,
  type ProjectionObserved,
  projectionRowAfter,
  type ProjectionScope,
} from '../domain/projection.ts';

export interface ProjectionInputs {
  readonly copies: readonly ProjectionDesired[];
}

export interface ProjectionReconcilerDeps {
  readonly fs: FileSystem;
  /** The guarded Links port: links inside a skill are made again as links. */
  readonly links: Links;
  readonly trash: InstanceTrash;
  readonly paths: PathFlavour;
  readonly logger: Logger;
  readonly clock: { now(): number };
  readonly libraryRoot: () => string;
  /** Which of these library paths (`skills/<folder>/…`, forward slashes) the library's ignore rules match. */
  readonly ignored: (paths: readonly string[]) => Promise<ReadonlySet<string>>;
  /** An edit made through a link reached the library. */
  readonly onWriteBack?: (skill: string) => void;
}

export { renamedSkillMd } from '../../links/index.ts';

export function readCopyRow(record: RegistryRecord | undefined): ProjectedCopyRow | null {
  if (!record) return null;
  const parsed = ProjectedCopyRowSchema.safeParse(record.data);
  return parsed.success ? parsed.data : null;
}

export function projectionReconciler(
  deps: ProjectionReconcilerDeps,
  scope: ProjectionScope,
): Reconciler<ProjectionInputs, ProjectionDesired, ProjectionObserved, ProjectionAction> {
  const { fs, paths } = deps;
  /** The fingerprint each applied step left, until its record. */
  const results = new Map<string, string>();
  const libraryFolder = (skill: string) => paths.join(deps.libraryRoot(), 'skills', skill) as AbsPath;
  const copies = skillCopies({ fs, links: deps.links, paths, ignored: deps.ignored });
  const { read, ignoredOf, fingerprint } = copies;

  /**
   * Both sides of one copy, read now. `before` is the git name the copy was last synced under, when the skill has
   * another one now (a rename, or a prefix change, Step 14): the copy is compared with its row under that name too.
   */
  const sides = async (skill: string, key: string, before?: string) => {
    const library = await read(libraryFolder(skill));
    const copy = await read(key as AbsPath);
    const ignored = await ignoredOf(skill, library, copy);
    return {
      library: fingerprint(library, ignored, null),
      copy: fingerprint(copy, ignored, skill),
      libraryBefore: before === undefined ? null : fingerprint(library, ignored, before),
      copyBefore: before === undefined ? null : fingerprint(copy, ignored, before),
      copyExists: (await fs.lstat(key as AbsPath))?.kind === 'dir',
      ignored,
    };
  };

  /** Makes `to` equal `from`, ignored files left alone, with SKILL.md under `name`. */
  const mirror = (from: AbsPath, to: AbsPath, _skill: string, name: string, ignored: ReadonlySet<string>) =>
    copies.mirror(from, to, name, ignored);

  return {
    kind: PROJECTED_COPY_KIND,

    desired(inputs) {
      return [...inputs.copies].sort((a, b) => (a.key < b.key ? -1 : 1));
    },

    async observe(desired, registry) {
      const rows = new Map(registry.map((record) => [record.key, readCopyRow(record)]));
      const skills = new Map<string, string>(desired.map((d) => [d.key, d.skill]));
      for (const [key, row] of rows) if (row && !skills.has(key)) skills.set(key, row.skill);
      const observed: ProjectionObserved[] = [];
      for (const [key, skill] of [...skills].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (scope.only && !scope.only.includes(key)) continue;
        const row = rows.get(key) ?? null;
        const seen = await sides(skill, key, row && row.skill !== skill ? row.skill : undefined);
        observed.push({
          key,
          row,
          library: seen.library,
          copy: seen.copy,
          ...(seen.libraryBefore === null || seen.copyBefore === null
            ? {}
            : { before: { library: seen.libraryBefore, copy: seen.copyBefore } }),
          copyExists: seen.copyExists,
        });
      }
      return observed;
    },

    plan(desired, observed): PlanBody<ProjectionAction> {
      return planProjection(scope, desired, observed, deps.clock.now());
    },

    async apply(action) {
      const key = action.key as AbsPath;
      switch (action.op) {
        case 'adopt':
        case 'mark':
        case 'forget':
          return;
        case 'create':
        case 'refresh':
        case 'write-back': {
          const now = await sides(action.skill, action.key);
          if (action.op === 'refresh' && now.copy !== action.expect.copy) throw changed(action.key);
          if (action.op === 'write-back' && now.library !== action.expect.library) throw changed(action.key);
          if (action.op === 'write-back') {
            // Back into the library, under the git name (PLAN.md §3.3 "The round trip is always exact").
            await mirror(key, libraryFolder(action.skill), action.skill, action.skill, now.ignored);
          } else {
            await mirror(libraryFolder(action.skill), key, action.skill, action.name, now.ignored);
          }
          const after = await sides(action.skill, action.key);
          results.set(action.key, action.op === 'write-back' ? after.library : after.copy);
          if (action.op === 'write-back') deps.onWriteBack?.(action.skill);
          return;
        }
        case 'remove': {
          if (!(await fs.lstat(key))) return;
          // A copy with changes that never reached the library goes to the trash; the rest is the app's own data.
          if (action.trash) await deps.trash.put(key, 'projected-copy', action.skill);
          else await fs.removeTree(key);
          return;
        }
      }
    },

    record(action, registry, now) {
      const before = readCopyRow(registry.get(PROJECTED_COPY_KIND, action.key));
      const after = projectionRowAfter(action, before, results.get(action.key) ?? null, now);
      results.delete(action.key);
      if (after) registry.put(PROJECTED_COPY_KIND, action.key, after, now);
      else registry.delete(PROJECTED_COPY_KIND, action.key);
    },
  };
}

function changed(key: string): AppError {
  return new AppError('plan.changed', { kind: PROJECTED_COPY_KIND, path: key });
}
