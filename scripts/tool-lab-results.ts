// A18.7, TESTING.md §9.10: the tool lab's results into the catalog's `verified` fields. The lab (people or a
// supervised agent on dedicated machines, not CI) checks each tool's current version on each OS, and writes one result
// per tool:
//   [{ "id": "codex", "version": "0.52.0", "date": "2026-11-20", "os": ["mac", "linux"], "passed": true }, …]
// A tool that passed gets `verified: { version, date, os }`; one that failed keeps its old entry, and is listed, so
// its catalog entry is fixed before the release.
//   node scripts/tool-lab-results.ts <results.json> [catalog.json]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';

const repo = path.resolve(import.meta.dirname, '..');
const CATALOG = path.join(repo, 'packages', 'tools', 'src', 'catalog.json');

export interface LabResult {
  readonly id: string;
  readonly version: string;
  readonly date: string;
  readonly os: ReadonlyArray<'mac' | 'win' | 'linux'>;
  readonly passed: boolean;
}
export type LabResults = readonly LabResult[];

/** The lab's results file, checked: each entry complete, dates as YYYY-MM-DD, systems from the catalog's list. */
export function parseResults(value: unknown): LabResults {
  if (!Array.isArray(value)) throw new Error('the results are not a list');
  return value.map((entry: unknown, index) => {
    const r = entry as Partial<Record<keyof LabResult, unknown>>;
    const os = Array.isArray(r.os) ? r.os : [];
    const ok =
      typeof r.id === 'string' &&
      r.id !== '' &&
      typeof r.version === 'string' &&
      r.version !== '' &&
      typeof r.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
      os.length > 0 &&
      os.every((o) => o === 'mac' || o === 'win' || o === 'linux') &&
      typeof r.passed === 'boolean';
    if (!ok) throw new Error(`result ${index + 1} is not complete: ${JSON.stringify(entry)}`);
    return entry as LabResult;
  });
}

interface CatalogFile {
  tools: Array<{ id: string; verified: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** The catalog with the passed results applied; the failed and the unknown tools listed. */
export function applyResults(
  catalog: CatalogFile,
  results: LabResults,
): { catalog: CatalogFile; failed: string[]; unknown: string[]; unchecked: string[] } {
  const ids = new Set(catalog.tools.map((tool) => tool.id));
  const unknown = results.filter((r) => !ids.has(r.id)).map((r) => r.id);
  const failed = results.filter((r) => ids.has(r.id) && !r.passed).map((r) => r.id);
  const passed = new Map(results.filter((r) => r.passed).map((r) => [r.id, r]));
  const tools = catalog.tools.map((tool) => {
    const result = passed.get(tool.id);
    return result
      ? { ...tool, verified: { version: result.version, date: result.date, os: [...new Set(result.os)].sort() } }
      : tool;
  });
  const checked = new Set(results.map((r) => r.id));
  const unchecked = catalog.tools.filter((tool) => !checked.has(tool.id)).map((tool) => tool.id);
  return { catalog: { ...catalog, tools }, failed, unknown, unchecked };
}

if (import.meta.main) {
  const [resultsFile, catalogFile = CATALOG] = process.argv.slice(2);
  if (!resultsFile) {
    process.stderr.write('usage: tool-lab-results.ts <results.json> [catalog.json]\n');
    process.exit(2);
  }
  const results = parseResults(JSON.parse(readFileSync(resultsFile, 'utf8')));
  const current = JSON.parse(readFileSync(catalogFile, 'utf8')) as CatalogFile;
  const { catalog, failed, unknown, unchecked } = applyResults(current, results);
  const text = await format(JSON.stringify(catalog, null, 2), { ...(await resolveConfig(CATALOG)), filepath: CATALOG });
  writeFileSync(catalogFile, text);
  process.stdout.write(`verified: ${results.filter((r) => r.passed && !unknown.includes(r.id)).length} tools\n`);
  if (unchecked.length) process.stdout.write(`not in the results: ${unchecked.join(', ')}\n`);
  if (unknown.length) process.stdout.write(`not in the catalog: ${unknown.join(', ')}\n`);
  if (failed.length) process.stdout.write(`failed, entry kept: ${failed.join(', ')}\n`);
  process.exit(failed.length || unknown.length ? 1 : 0);
}
