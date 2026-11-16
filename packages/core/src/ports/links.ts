// OS links: symlinks on macOS and Linux, junctions on Windows (PLAN.md §3.4, ADR 0017). Step 5 builds the link
// strategies and the registry on these operations.
import type { AbsPath } from '../shared/brand.ts';

export interface Links {
  create(target: AbsPath, link: AbsPath): Promise<void>;
  /** The link's target, or undefined when the path isn't a link. */
  readTarget(link: AbsPath): Promise<AbsPath | undefined>;
  /** Points an existing link at a new target in place, without touching either target's contents. */
  retarget(link: AbsPath, newTarget: AbsPath): Promise<void>;
  /** Removes only the link. */
  remove(link: AbsPath): Promise<void>;
}
