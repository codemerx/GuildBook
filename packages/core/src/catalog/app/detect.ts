// Detection (PLAN.md §3.4): a catalog tool is "found on this device" when one of its known folders exists. Only that
// yes or no is asked of each path (PLAN.md §3.7 rule 3); nothing inside the folder is read.
import type { FileSystem } from '../../ports/fs.ts';
import type { AbsPath } from '../../shared/brand.ts';
import type { ResolvedTool } from '../domain/tools.ts';

export async function detectTools(fs: Pick<FileSystem, 'lstat'>, tools: readonly ResolvedTool[]): Promise<string[]> {
  const found: string[] = [];
  for (const tool of tools) {
    if (tool.custom) continue;
    for (const path of tool.detect) {
      const entry = await fs.lstat(path as AbsPath).catch(() => undefined);
      if (entry?.kind === 'dir' || entry?.kind === 'link') {
        found.push(tool.id);
        break;
      }
    }
  }
  return found;
}
