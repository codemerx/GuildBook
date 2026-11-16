// Size limits (PLAN.md §3.12): they count the whole file a tool reads, the user's own text and every instance's block
// included. Codex stops reading at 32 KiB (`project_doc_max_bytes`), counted in bytes; Windsurf allows 6,000
// characters for its global rules. Codex also counts a repo's own AGENTS.md against the same limit, which the app
// doesn't read (PLAN.md §3.7), so the room shown for Codex is for the global files only.
import type { InstructionsLimit } from '@app/tools';
import { NEAR_LIMIT } from '../../library/index.ts';

export type RoomState = 'ok' | 'near' | 'over';

export interface RoomLeft {
  readonly tool: string;
  /** The file the tool reads. */
  readonly file: string;
  readonly unit: InstructionsLimit['unit'];
  readonly limit: number;
  readonly used: number;
  /** Below zero when the file is over the limit. */
  readonly left: number;
  readonly state: RoomState;
  /** Codex: a repo's own AGENTS.md uses more of the same limit, which the app doesn't measure. */
  readonly repoFilesCount: boolean;
}

/** A text's size in the limit's unit: UTF-8 bytes, or characters (code points). */
export function measure(text: string, unit: InstructionsLimit['unit']): number {
  return unit === 'bytes' ? new TextEncoder().encode(text).length : [...text].length;
}

export function roomLeft(
  tool: string,
  file: string,
  text: string,
  limit: InstructionsLimit,
  repoFilesCount: boolean,
): RoomLeft {
  const used = measure(text, limit.unit);
  const state: RoomState = used > limit.amount ? 'over' : used >= limit.amount * NEAR_LIMIT ? 'near' : 'ok';
  return { tool, file, unit: limit.unit, limit: limit.amount, used, left: limit.amount - used, state, repoFilesCount };
}
