// Recovering connections (PLAN.md §3.5 "Safeguards if the database is lost"): the pure part. The links found in the tool
// folders, and in the repo folders the user added again, become registry rows; a link counts only when its name is the
// skill's (its git name, or its name under the local prefix) and it points at the skill in the library or at its
// projected copy. Only links and their targets are looked at, never what's inside them. A copy-mode copy (Step 16)
// counts when its marker file names this instance and the skill: the marker is the only file read in it.
import type { SkillLinkRow } from '@app/schemas';
import type { PathFlavour } from '../../shared/paths.ts';

export interface FoundLink {
  readonly dest: string;
  /** The link folder it's in. */
  readonly folder: string;
  readonly target: string;
  /** For a link in a code repo: the repo's id and the checkout it's in. */
  readonly repo: string | null;
  readonly checkout: string | null;
  /** A copy-mode copy with this instance's marker (Step 16): the content the marker recorded, and its item. */
  readonly copy?: { readonly item: string; readonly contentFingerprint: string };
}

export interface RecoveryTool {
  readonly id: string;
  /** Found on this device (PLAN.md §3.4 "Detection"). */
  readonly installed: boolean;
  readonly skillDirs: readonly string[];
  /** Relative to a checkout. */
  readonly repoSkillDirs: readonly string[];
}

export interface RecoveryInputs {
  readonly libraryRoot: string;
  readonly projectionRoot: string;
  /** Each link name that may be the library's: the skill's git name, or its name under the local prefix. */
  readonly names: ReadonlyMap<string, { readonly skill: string; readonly local: boolean }>;
  readonly links: readonly FoundLink[];
  readonly tools: readonly RecoveryTool[];
}

export interface RecoveredLink {
  readonly dest: string;
  readonly row: SkillLinkRow;
}

export interface Recovered {
  readonly links: readonly RecoveredLink[];
  /** The tools whose folders hold the links: they're enabled again. */
  readonly tools: readonly string[];
  /** The skills found linked in a repo: placed there again, as individual additions. */
  readonly inRepos: ReadonlyArray<{ repo: string; skill: string; dest: string; checkout: string }>;
}

/** Pure: the rows, the tools and the repo placements the found links stand for. */
export function recoverConnections(inputs: RecoveryInputs, paths: PathFlavour, now: number): Recovered {
  const links: RecoveredLink[] = [];
  const inRepos: Array<{ repo: string; skill: string; dest: string; checkout: string }> = [];
  const folders = new Set<string>();
  for (const link of inputs.links) {
    const name = paths.basename(link.dest);
    const known = inputs.names.get(name);
    if (!known) continue;
    if (link.copy) {
      if (link.copy.item !== `skills/${known.skill}`) continue;
    } else {
      const target = paths.normalize(link.target);
      const expected = known.local
        ? paths.join(inputs.projectionRoot, name)
        : paths.join(inputs.libraryRoot, 'skills', known.skill);
      if (!paths.same(target, paths.normalize(expected))) continue;
    }
    links.push({
      dest: paths.normalize(link.dest),
      row: {
        item: `skills/${known.skill}`,
        skill: known.skill,
        folder: paths.normalize(link.folder),
        repo: link.repo,
        checkout: link.checkout,
        method: link.copy ? 'copy' : 'link',
        contentFingerprint: link.copy?.contentFingerprint ?? null,
        nameSource: known.local ? 'local-prefix' : 'git-prefix',
        status: 'linked',
        reason: null,
        takenBy: null,
        since: now,
        createdAt: now,
        lastVerifiedAt: now,
      },
    });
    folders.add(
      link.checkout === null ? paths.normalize(link.folder) : `repo:${relativeIn(link.checkout, link.folder, paths)}`,
    );
    if (link.repo !== null && link.checkout !== null) {
      inRepos.push({ repo: link.repo, skill: known.skill, dest: link.dest, checkout: link.checkout });
    }
  }
  const tools = inputs.tools
    .filter((tool) => tool.installed)
    .filter(
      (tool) =>
        tool.skillDirs.some((dir) => folders.has(paths.normalize(dir))) ||
        tool.repoSkillDirs.some((dir) => folders.has(`repo:${paths.normalize(dir)}`)),
    )
    .map((tool) => tool.id)
    .sort();
  links.sort((a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0));
  return { links, tools, inRepos };
}

function relativeIn(checkout: string, folder: string, paths: PathFlavour): string {
  return paths.normalize(paths.relative(checkout, folder) ?? folder);
}
