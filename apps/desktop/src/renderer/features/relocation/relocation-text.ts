// The words of a relocation (PLAN.md §3.9 "What the user sees"): the summary line, e.g. "214 files · 4 connections
// updated (Claude Code ×3, Codex/Cursor/Copilot/Gemini ×1) · 0 skipped", and relocation's own pre-flight problems.
import type { RelocationSummaryView } from '@app/ipc';
import type { TFunction } from 'i18next';

/** The connections by the tools that read them: "Claude Code ×3, Codex/Cursor ×1". */
export function connectionGroups(t: TFunction, summary: RelocationSummaryView): string {
  return summary.groups
    .map((group) =>
      t('relocation.summary.group', {
        tools: group.tools.length > 0 ? group.tools.join('/') : t('relocation.summary.noTool'),
        count: group.count,
      }),
    )
    .join(', ');
}

export function summaryCounts(t: TFunction, summary: RelocationSummaryView): string {
  const groups = connectionGroups(t, summary);
  return [
    t('relocation.summary.files', { count: summary.files }),
    groups === ''
      ? t('relocation.summary.connections', { count: summary.connections })
      : t('relocation.summary.connectionsBy', { count: summary.connections, groups }),
    t('relocation.summary.skipped', { count: summary.skipped.length }),
  ].join(' · ');
}

/**
 * Relocation's own problems, and the library itself named in the location check (it has no name there: "this
 * library"). Undefined: the folder page's text.
 */
export function relocationMessage(t: TFunction, code: string, params: Record<string, string>): string | undefined {
  if ((code === 'location.insideLibrary' || code === 'location.containsLibrary') && params.library === '') {
    return t('relocation.problems.itself');
  }
  if (code === 'relocation.same') return t('relocation.problems.same');
  if (code === 'relocation.gitBusy') {
    return t(params.operation === 'busy' ? 'relocation.problems.gitRunning' : 'relocation.problems.gitUnfinished');
  }
  return undefined;
}
