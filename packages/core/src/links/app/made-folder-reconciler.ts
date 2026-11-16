// The link folders the app made in code repos (PLAN.md §3.6 "Worktrees", A6.16): a reconciler on the same framework
// as the skill links (IMPLEMENTATION.md §2.5), keyed by the folder's path. It runs after the links changed, so it sees
// which folders still hold something of the app's. A folder that holds nothing kept is removed with a plain rmdir,
// which refuses a folder with anything in it: nothing in the folder is read (PLAN.md §3.7 rule 4). Either way its row
// goes.
import { LINK_FOLDER_KIND } from '@app/schemas';
import type { Reconciler } from '../../engine/index.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { Logger } from '../../ports/logger.ts';
import type { AbsPath } from '../../shared/brand.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import {
  holdsKept,
  type MadeFolderAction,
  type MadeFolderInputs,
  type MadeFolderObserved,
  planMadeFolders,
} from '../domain/made-folders.ts';

export function madeFolderReconciler(deps: {
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly logger: Logger;
}): Reconciler<MadeFolderInputs, string, MadeFolderObserved, MadeFolderAction> {
  const { fs, paths } = deps;
  return {
    kind: LINK_FOLDER_KIND,

    desired(inputs) {
      return inputs.kept;
    },

    async observe(kept, registry) {
      const observed: MadeFolderObserved[] = [];
      for (const { key: folder } of registry) {
        // A folder that holds something of the app's isn't looked at.
        if (holdsKept(folder, kept, paths)) {
          observed.push({ folder, state: 'kept' });
          continue;
        }
        const entry = await fs.lstat(folder as AbsPath);
        observed.push({ folder, state: entry === undefined ? 'missing' : entry.kind === 'dir' ? 'dir' : 'other' });
      }
      return observed;
    },

    plan(_kept, observed) {
      return planMadeFolders(observed);
    },

    async apply(action) {
      if (action.op === 'forget') return;
      if (!(await fs.removeEmptyFolder(action.folder as AbsPath))) {
        deps.logger.debug('a link folder the app made stays: something else is in it', { folder: action.folder });
      }
    },

    record(action, registry) {
      registry.delete(LINK_FOLDER_KIND, action.folder);
    },
  };
}
