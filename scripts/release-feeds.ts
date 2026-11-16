// The update feed files of a release (electron-builder's latest*.yml; ADR 0027, ADR 0031), for the release pipeline:
//   node scripts/release-feeds.ts merge <out> <folder>...   one file per name: each OS's runners for arm64 and x64
//                                                         write their own latest-mac.yml or latest.yml, and the
//                                                         merged file lists the files of both
//   node scripts/release-feeds.ts rollout <folder> <percent>   the staged rollout: the share of users offered the
//                                                         version (stagingPercentage); 0 stops it, 100 is everyone
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';

interface FeedFile {
  url: string;
  sha512: string;
  size?: number;
  [key: string]: unknown;
}

interface Feed {
  version: string;
  files: FeedFile[];
  path?: string;
  sha512?: string;
  releaseDate?: string;
  stagingPercentage?: number;
  [key: string]: unknown;
}

const isFeed = (name: string) => /^latest(-[\w-]+)?\.yml$/.test(name);

/** Merges the feeds of one name: the same version, every file once. */
export function mergeFeeds(feeds: readonly Feed[]): Feed {
  const [first, ...rest] = feeds;
  if (!first) throw new Error('no feed to merge');
  const files = [...first.files];
  for (const feed of rest) {
    if (feed.version !== first.version) throw new Error(`versions differ: ${first.version} and ${feed.version}`);
    for (const file of feed.files) if (!files.some((f) => f.url === file.url)) files.push(file);
  }
  const latest = feeds
    .map((feed) => feed.releaseDate ?? '')
    .sort()
    .at(-1);
  return latest ? { ...first, files, releaseDate: latest } : { ...first, files };
}

/** The feed with a staged rollout: 0 to 99 % of users, or everyone (the field left out). */
export function rollout(feed: Feed, percent: number): Feed {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error(`not a percentage: ${percent}`);
  const { stagingPercentage: _old, ...rest } = feed;
  return percent === 100 ? rest : { ...rest, stagingPercentage: percent };
}

const read = (file: string) => parse(readFileSync(file, 'utf8')) as Feed;
const write = (file: string, feed: Feed) => writeFileSync(file, stringify(feed, { lineWidth: 0 }));

function main(args: readonly string[]): void {
  const [command, target, ...more] = args;
  if (command === 'merge' && target && more.length > 0) {
    const byName = new Map<string, Feed[]>();
    for (const folder of more) {
      for (const name of readdirSync(folder).filter(isFeed)) {
        byName.set(name, [...(byName.get(name) ?? []), read(path.join(folder, name))]);
      }
    }
    mkdirSync(target, { recursive: true });
    for (const [name, feeds] of byName) write(path.join(target, name), mergeFeeds(feeds));
    process.stdout.write(`merged ${[...byName.keys()].sort().join(', ')} into ${target}\n`);
    return;
  }
  if (command === 'rollout' && target && more.length === 1) {
    const percent = Number(more[0]);
    const names = readdirSync(target).filter(isFeed);
    if (names.length === 0) throw new Error(`no latest*.yml in ${target}`);
    for (const name of names) write(path.join(target, name), rollout(read(path.join(target, name)), percent));
    process.stdout.write(`the rollout is at ${percent} % in ${names.join(', ')}\n`);
    return;
  }
  process.stderr.write('usage: release-feeds.ts merge <out> <folder>... | rollout <folder> <percent>\n');
  process.exit(2);
}

if (import.meta.main) main(process.argv.slice(2));
