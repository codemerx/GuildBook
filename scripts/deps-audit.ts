// The dependency audit (IMPLEMENTATION.md Step 17, TESTING.md §9.5): every package version in pnpm-lock.yaml, the
// packaged ones and the tools alike, is looked up in the OSV database (osv.dev). Only the names and versions are
// sent. A malicious package (an id starting with MAL-) always fails the audit; any other advisory fails it too, unless
// scripts/deps-audit-allow.json lists it with the reason it doesn't apply. The report goes to artifacts/deps-audit.json.
//   pnpm deps:audit
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const OSV = 'https://api.osv.dev/v1';

interface Allowed {
  readonly id: string;
  readonly package: string;
  readonly reason: string;
}

/** Every `name@version` in the lockfile's `packages:` sections (both documents: the app's and pnpm's own). */
export function lockedPackages(lockfile: string): Array<{ name: string; version: string }> {
  const found = new Map<string, { name: string; version: string }>();
  let inPackages = false;
  for (const line of lockfile.split('\n')) {
    if (/^\S/.test(line)) inPackages = line === 'packages:';
    if (!inPackages) continue;
    const match = /^ {2}'?((?:@[^@/\s']+\/)?[^@\s']+)@([^('":\s]+)/.exec(line);
    if (match?.[1] && match[2]) found.set(`${match[1]}@${match[2]}`, { name: match[1], version: match[2] });
  }
  return [...found.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function main(): Promise<number> {
  const packages = lockedPackages(readFileSync(path.join(repo, 'pnpm-lock.yaml'), 'utf8'));
  const allowed = JSON.parse(readFileSync(path.join(repo, 'scripts', 'deps-audit-allow.json'), 'utf8')) as Allowed[];
  const hits: Array<{ package: string; id: string; summary: string; allowed: string | null }> = [];
  // OSV answers at most 1,000 queries per batch.
  for (let start = 0; start < packages.length; start += 1000) {
    const batch = packages.slice(start, start + 1000);
    const answer = await post<{ results: Array<{ vulns?: Array<{ id: string }> }> }>(`${OSV}/querybatch`, {
      queries: batch.map((p) => ({ package: { ecosystem: 'npm', name: p.name }, version: p.version })),
    });
    for (const [index, result] of answer.results.entries()) {
      const locked = batch[index];
      if (!locked) continue;
      for (const vuln of result.vulns ?? []) {
        const details = (await (await fetch(`${OSV}/vulns/${encodeURIComponent(vuln.id)}`)).json()) as {
          summary?: string;
          aliases?: string[];
        };
        const name = `${locked.name}@${locked.version}`;
        const allow = vuln.id.startsWith('MAL-')
          ? undefined
          : allowed.find((a) => a.package === name && [vuln.id, ...(details.aliases ?? [])].includes(a.id));
        hits.push({ package: name, id: vuln.id, summary: details.summary ?? '', allowed: allow?.reason ?? null });
      }
    }
  }
  const failing = hits.filter((hit) => hit.allowed === null);
  mkdirSync(path.join(repo, 'artifacts'), { recursive: true });
  const report = { checked: packages.length, advisories: hits, failing: failing.length };
  writeFileSync(path.join(repo, 'artifacts', 'deps-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${packages.length} package versions checked on OSV: ${hits.length} advisories\n`);
  for (const hit of hits)
    process.stdout.write(
      `${hit.allowed === null ? 'FAIL' : 'allowed'}  ${hit.package}  ${hit.id}  ${hit.summary}` +
        `${hit.allowed === null ? '' : ` (${hit.allowed})`}\n`,
    );
  return failing.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
