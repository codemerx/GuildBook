// The brand check (PLAN.md §3.16, A1.16): no product name or name-derived value is written anywhere outside
// packages/brand, translation files included. The values come from packages/brand itself, so this file holds none.
//   node scripts/brand-check.ts [folder]   (default: the repository)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { brandNeedles } from '../packages/brand/src/index.ts';

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));

/** Where brand values belong: the brand package, and the documents that specify them (docs/, the README and NOTICE). */
export const exempt = [/^packages\/brand\//, /^docs\//, /^README\.md$/, /^NOTICE$/];
const binary = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|zip|gz|db|sqlite)$/i;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function brandPattern(): RegExp {
  // Case-insensitive, and tolerant of separators: a name written with a dash, a dot, an underscore or a space is caught too.
  const variants = brandNeedles().map((needle) => escape(needle).replace(/(\\[.-]|\s)/g, '[\\s._-]?'));
  return new RegExp(variants.join('|'), 'i');
}

function trackedFiles(): string[] {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split('\0').filter(Boolean);
}

const pattern = brandPattern();
const findings: string[] = [];
for (const file of trackedFiles()) {
  if (exempt.some((rule) => rule.test(file)) || binary.test(file)) continue;
  let text: string;
  try {
    text = readFileSync(path.join(root, file), 'utf8');
  } catch {
    continue;
  }
  if (!pattern.test(path.basename(file)) && !pattern.test(text)) continue;
  text.split('\n').forEach((line, index) => {
    if (pattern.test(line)) findings.push(`${file}:${index + 1}: ${line.trim().slice(0, 140)}`);
  });
  if (pattern.test(path.basename(file))) findings.push(`${file}: the file name`);
}

if (findings.length > 0) {
  process.stderr.write(`brand values outside packages/brand (PLAN.md §3.16):\n${findings.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('brand check: no product name outside packages/brand\n');
