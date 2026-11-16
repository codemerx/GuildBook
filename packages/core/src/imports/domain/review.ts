// The review gate (PLAN.md §3.18 "Rule for every import"): every selected skill must be opened in the editor before
// [Add], and the review shows what the reviewer must look at: `scripts/`, an `allowed-tools` field, links inside the
// skill, and mentions of the old names in the text, which the reviewer fixes by hand.

export interface GateState {
  /** [Add] may be used: something is selected, and every selected skill has been opened. */
  readonly canAdd: boolean;
  /** Selected skills not opened yet. */
  readonly waiting: readonly string[];
}

export function reviewGate(selected: readonly string[], opened: ReadonlySet<string>): GateState {
  const waiting = selected.filter((id) => !opened.has(id));
  return { canAdd: selected.length > 0 && waiting.length === 0, waiting };
}

export interface Mention {
  /** The file, relative to the skill's folder. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** The old name found. */
  readonly name: string;
  /** The line's text, trimmed and shortened, for the list. */
  readonly text: string;
}

const NAME_CHAR = /[a-z0-9-]/i;
const MENTION_TEXT_MAX = 160;

/**
 * Where a text names one of the old names as a whole name: not inside a longer name, so `acme-code-review` doesn't
 * count as a mention of `code-review`. The header's `name:` line is the new name, and its `source:` line records where
 * the skill came from: both are left out.
 */
export function mentionsOf(file: string, text: string, oldNames: readonly string[]): Mention[] {
  const names = [...new Set(oldNames.filter((name) => name.length > 0))];
  if (names.length === 0) return [];
  const found: Mention[] = [];
  const lines = text.split(/\r?\n/);
  let inHeader = file === 'SKILL.md' && lines[0]?.trim() === '---';
  lines.forEach((line, index) => {
    if (inHeader && index > 0 && line.trim() === '---') {
      inHeader = false;
      return;
    }
    if (inHeader && (/^name\s*:/.test(line) || /^\s+source\s*:/.test(line))) return;
    for (const name of names) {
      if (hasWholeName(line, name)) {
        const trimmed = line.trim();
        found.push({
          file,
          line: index + 1,
          name,
          text: trimmed.length > MENTION_TEXT_MAX ? `${trimmed.slice(0, MENTION_TEXT_MAX - 1)}…` : trimmed,
        });
      }
    }
  });
  return found;
}

function hasWholeName(line: string, name: string): boolean {
  const lower = line.toLowerCase();
  const wanted = name.toLowerCase();
  let at = lower.indexOf(wanted);
  while (at >= 0) {
    const before = at === 0 ? '' : (line[at - 1] ?? '');
    const after = line[at + wanted.length] ?? '';
    if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) return true;
    at = lower.indexOf(wanted, at + 1);
  }
  return false;
}

/** What the review flags in a skill's files (PLAN.md §3.15, §3.18). */
export interface SkillFlags {
  /** Files under `scripts/`. */
  readonly scripts: readonly string[];
  /** The `allowed-tools` field's value, when the header has one. */
  readonly allowedTools: string | null;
  /** Symbolic links in the skill, with their targets as stored: copied as links, never followed. */
  readonly links: ReadonlyArray<{ readonly path: string; readonly target: string }>;
}

export function skillFlags(
  entries: ReadonlyArray<{ readonly path: string; readonly kind: string; readonly target: string | null }>,
  header: Readonly<Record<string, unknown>> | null,
): SkillFlags {
  const tools = header?.['allowed-tools'];
  return {
    scripts: entries.filter((e) => e.kind !== 'dir' && e.path.startsWith('scripts/')).map((e) => e.path),
    allowedTools:
      typeof tools === 'string'
        ? tools
        : Array.isArray(tools)
          ? tools.map(String).join(' ')
          : tools === undefined || tools === null
            ? null
            : JSON.stringify(tools),
    links: entries.flatMap((e) => (e.kind === 'link' && e.target !== null ? [{ path: e.path, target: e.target }] : [])),
  };
}
