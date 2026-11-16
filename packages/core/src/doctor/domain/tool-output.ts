// What the Doctor takes from a tool's own commands (PLAN.md §3.4): the version a `version_command` prints, and the
// skill names a `list_command` prints. The list is filtered to names that start with a prefix in use on the device
// before anything keeps it (PLAN.md §3.7 rule 3): the user's own skills never leave this function.

/** The first version-like word in the output, e.g. "2.1.4" in "claude 2.1.4 (Claude Code)". */
export function parseVersion(output: string): string | null {
  const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output);
  return match?.[1] ?? null;
}

/** The names in the output that are a prefix's skill names: `acme` or `acme-…`. Sorted, each once. */
export function filterListedSkills(output: string, prefixes: readonly string[]): string[] {
  if (prefixes.length === 0) return [];
  const out = new Set<string>();
  for (const word of output.match(/[a-z0-9][a-z0-9-]*/g) ?? []) {
    if (word.length > 64) continue;
    if (prefixes.some((prefix) => word === prefix || word.startsWith(`${prefix}-`))) out.add(word);
  }
  return [...out].sort();
}

/** A command line from the catalog as a program and its arguments; the catalog's commands have no quoting. */
export function splitCommand(command: string): { program: string; args: string[] } | null {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const [program, ...args] = parts;
  return program ? { program, args } : null;
}

/**
 * "verified with Kimi Code 1.47; you have 1.52" (PLAN.md §3.4): drift when the installed version is another than the
 * catalog's verified one. Unknown when either is missing.
 */
export function versionDrift(verified: string | null, installed: string | null): 'same' | 'drift' | 'unknown' {
  if (verified === null || installed === null) return 'unknown';
  const norm = (v: string) => v.split(/[.-]/).slice(0, 2).join('.');
  return norm(verified) === norm(installed) ? 'same' : 'drift';
}
