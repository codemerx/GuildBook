// Link strategies (IMPLEMENTATION.md §2.14): how a skill reaches a tool folder. Step 5 has the one every tool uses by
// default: an OS link to the library folder, a symlink on macOS and Linux and a junction on Windows (PLAN.md §3.4,
// ADR 0017). Projected copies (Step 8) and copy mode (Step 16) are further strategies.
import type { Links } from '../../ports/links.ts';
import type { AbsPath } from '../../shared/brand.ts';

export interface LinkStrategy {
  readonly method: 'link';
  create(target: AbsPath, link: AbsPath): Promise<void>;
  /** The link's target as stored, or undefined when the path isn't a link. */
  readTarget(link: AbsPath): Promise<AbsPath | undefined>;
  /**
   * Points the link at a new target in place (PLAN.md §3.9 step 5): an atomic rename on macOS and Linux, a junction
   * swap on Windows. Nothing inside either target is touched.
   */
  retarget(link: AbsPath, newTarget: AbsPath): Promise<void>;
  /** Removes the link entry only: never what it points to (PLAN.md §3.8 "Never delete through a link"). */
  remove(link: AbsPath): Promise<void>;
}

export function osLinkStrategy(links: Links): LinkStrategy {
  return {
    method: 'link',
    create: (target, link) => links.create(target, link),
    readTarget: (link) => links.readTarget(link),
    retarget: (link, newTarget) => links.retarget(link, newTarget),
    remove: (link) => links.remove(link),
  };
}
