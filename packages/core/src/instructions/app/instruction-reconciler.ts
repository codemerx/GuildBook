// The instruction reconciler's I/O parts (IMPLEMENTATION.md §2.5, PLAN.md §3.12). `observe` reads only the files the
// strategies name (PLAN.md §3.7 rule 2): the owned files, the files holding the app's block, OpenCode's config and
// Codex's override file. A link at such a path is followed to the file it points to, which is the one read and
// written, so the link stays (A7.8). `apply` reads each file again under the device-wide lock (other instances write
// the same files, §2.13 rule 8), checks that the app's part is still what the plan saw, and changes only that part.
import {
  addConfigEntry,
  INSTRUCTION_KIND,
  type InstructionRow,
  InstructionRowSchema,
  isEmptyConfig,
  newConfigWithEntry,
  removeConfigEntry,
} from '@app/schemas';
import type { InstanceTrash } from '../../activity/index.ts';
import type { Reconciler } from '../../engine/index.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { RegistryRecord } from '../../ports/store.ts';
import type { AbsPath } from '../../shared/brand.ts';
import { AppError } from '../../shared/errors.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import {
  type DesiredInstruction,
  desiredInstructions,
  type InstructionInputs,
  textFingerprint,
} from '../domain/artifacts.ts';
import { appendBlock, findBlock, removeBlock, replaceInside } from '../domain/blocks.ts';
import {
  type InstructionAction,
  type InstructionDecision,
  type InstructionObserved,
  type ObservedFile,
  planInstructions,
} from '../domain/plan.ts';

export interface InstructionReconcilerDeps {
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  readonly trash: InstanceTrash;
  /** Runs `fn` holding the device-wide lock for one file. */
  readonly locked: <T>(file: string, fn: () => Promise<T>) => Promise<T>;
  /** A path a link leads to: the guard lets the reconciler read and write it from now on. */
  readonly allow: (path: string) => void;
}

export interface InstructionScope {
  readonly decisions?: Readonly<Record<string, InstructionDecision>>;
  readonly only?: readonly string[];
}

export function readInstructionRow(record: RegistryRecord | undefined): InstructionRow | null {
  if (!record) return null;
  const parsed = InstructionRowSchema.safeParse(record.data);
  return parsed.success ? parsed.data : null;
}

/** Links followed at most this many times: a loop of links leads nowhere. */
const MAX_LINKS = 8;

/** The file a path leads to through links, and what's there. */
export async function followLinks(
  fs: FileSystem,
  paths: PathFlavour,
  path: string,
  allow: (path: string) => void,
): Promise<{ written: string; kind: 'missing' | 'file' | 'other' }> {
  let at = paths.normalize(path);
  for (let hop = 0; hop <= MAX_LINKS; hop++) {
    const entry = await fs.lstat(at as AbsPath);
    if (!entry) return { written: at, kind: 'missing' };
    if (entry.kind === 'file') return { written: at, kind: 'file' };
    if (entry.kind !== 'link') return { written: at, kind: 'other' };
    const target = await fs.readLink(at as AbsPath);
    const next = paths.isAbsolute(target) ? target : paths.join(paths.dirname(at), target);
    at = paths.normalize(next);
    allow(at);
  }
  return { written: at, kind: 'other' };
}

interface StepResult {
  readonly fingerprint?: string;
  readonly lead?: string;
  readonly created?: boolean;
  readonly createdKey?: boolean;
  readonly source?: string;
}

export function instructionReconciler(
  deps: InstructionReconcilerDeps,
  scope: InstructionScope = {},
): Reconciler<InstructionInputs, DesiredInstruction, InstructionObserved, InstructionAction> {
  const { fs, paths } = deps;
  let current: InstructionInputs | undefined;
  const results = new Map<string, StepResult>();

  const readFile = async (file: string): Promise<string | null> => {
    const entry = await fs.lstat(file as AbsPath);
    if (!entry) return null;
    if (entry.kind !== 'file') throw new AppError('plan.changed', { path: file });
    return fs.readText(file as AbsPath);
  };

  const write = async (file: string, text: string) => {
    const dir = paths.dirname(file) as AbsPath;
    if (!(await fs.lstat(dir))) await fs.mkdirp(dir);
    await fs.writeTextAtomic(file as AbsPath, text);
  };

  const changed = (path: string) => new AppError('plan.changed', { path });

  return {
    kind: INSTRUCTION_KIND,

    desired(inputs) {
      current = inputs;
      return desiredInstructions(inputs, paths);
    },

    async observe(desired, registry) {
      const rows = new Map(registry.map((record) => [record.key, readInstructionRow(record)]));
      const keys = [...new Set([...desired.map((d) => d.key), ...rows.keys()])].sort();
      const observed: InstructionObserved[] = [];
      for (const key of keys) {
        if (scope.only && !scope.only.includes(key)) continue;
        const { written, kind } = await followLinks(fs, paths, key, deps.allow);
        const file: ObservedFile =
          kind === 'file' ? { kind: 'file', text: await fs.readText(written as AbsPath) } : { kind };
        observed.push({ key, written, file, row: rows.get(key) ?? null });
      }
      return observed;
    },

    plan(desired, observed) {
      return planInstructions(
        {
          instance: current?.instance ?? '',
          prefix: current?.prefix ?? '',
          libraryFile: current?.libraryFile ?? null,
          decisions: scope.decisions ?? {},
          ...(scope.only ? { only: scope.only } : {}),
        },
        desired,
        observed,
      );
    },

    async apply(action) {
      // Only the registry changes for these: nothing on disk is read or written.
      if (action.op === 'adopt' || action.op === 'mark' || action.op === 'forget') return;
      const instance = current?.instance ?? '';
      await deps.locked(action.written, async () => {
        const text = await readFile(action.written);
        switch (action.op) {
          case 'adopt':
          case 'mark':
            return;
          case 'write-file': {
            const now = text === null ? null : textFingerprint(text);
            if (now !== action.expect) throw changed(action.key);
            await write(action.written, action.content);
            results.set(action.key, { fingerprint: textFingerprint(action.content), created: text === null });
            return;
          }
          case 'put-block': {
            const span = findBlock(text ?? '', instance);
            let next: string;
            let lead: string | undefined;
            if (action.expect === null) {
              if (span.kind !== 'none') throw changed(action.key);
              ({ text: next, lead } = appendBlock(text ?? '', instance, action.prefix, action.content));
            } else {
              if (span.kind !== 'found' || textFingerprint(span.inside) !== action.expect) throw changed(action.key);
              next = replaceInside(text ?? '', span, action.content, { instance, prefix: action.prefix });
            }
            await write(action.written, next);
            const written = findBlock(next, instance);
            results.set(action.key, {
              fingerprint: written.kind === 'found' ? textFingerprint(written.inside) : '',
              ...(lead !== undefined ? { lead } : {}),
              ...(text === null ? { created: true } : {}),
            });
            return;
          }
          case 'add-entry': {
            const added =
              text === null
                ? { text: newConfigWithEntry(action.content), createdKey: true }
                : addConfigEntry(text, action.content);
            if (!added) throw changed(action.key);
            if (added.text !== text) await write(action.written, added.text);
            results.set(action.key, {
              fingerprint: textFingerprint(action.content),
              createdKey: added.createdKey,
              ...(text === null ? { created: true } : {}),
            });
            return;
          }
          case 'remove-file': {
            if (text === null) return;
            if (textFingerprint(text) !== action.expect) throw changed(action.key);
            // An edited copy is the user's work: it goes to the trash, where it can be restored (PLAN.md §3.8).
            if (action.trash) await deps.trash.put(action.written as AbsPath, 'diverged-copy', null);
            else await fs.remove(action.written as AbsPath);
            return;
          }
          case 'remove-block': {
            if (text === null) return;
            const span = findBlock(text, instance);
            if (span.kind === 'none') return;
            if (span.kind !== 'found' || textFingerprint(span.inside) !== action.expect) throw changed(action.key);
            const next = removeBlock(text, span, action.lead);
            if (action.createdFile && next === '') await fs.remove(action.written as AbsPath);
            else await write(action.written, next);
            return;
          }
          case 'remove-entry': {
            if (text === null) return;
            const next = removeConfigEntry(text, action.content, action.createdKey);
            if (next === null) throw changed(action.key);
            if (action.createdFile && isEmptyConfig(next)) await fs.remove(action.written as AbsPath);
            else if (next !== text) await write(action.written, next);
            return;
          }
          case 'bring-in': {
            if (text === null) throw changed(action.key);
            const span = action.row.artifact === 'block' ? findBlock(text, instance) : null;
            const part = span === null ? text : span.kind === 'found' ? span.inside : null;
            if (part === null || textFingerprint(part) !== action.expect) throw changed(action.key);
            // The library's file changes, and shows as modified on this device (PLAN.md §3.10).
            await fs.writeTextAtomic(action.libraryFile as AbsPath, part);
            results.set(action.key, { fingerprint: action.expect, source: textFingerprint(part) });
            return;
          }
        }
      });
    },

    record(action, registry, now) {
      const before = readInstructionRow(registry.get(INSTRUCTION_KIND, action.key));
      if (
        action.op === 'forget' ||
        action.op === 'remove-file' ||
        action.op === 'remove-block' ||
        action.op === 'remove-entry'
      ) {
        registry.delete(INSTRUCTION_KIND, action.key);
        return;
      }
      const result = results.get(action.key) ?? {};
      results.delete(action.key);
      const draft = action.row;
      const fingerprint =
        result.fingerprint ?? ('fingerprint' in action ? action.fingerprint : null) ?? before?.fingerprint ?? '';
      const row: InstructionRow = {
        artifact: draft.artifact,
        role: draft.role,
        tools: [...draft.tools].sort(),
        written: action.written,
        fingerprint,
        source: result.source ?? draft.source,
        lead: result.lead ?? before?.lead ?? '',
        createdFile: result.created === true || (before?.createdFile ?? false),
        createdKey: result.createdKey ?? before?.createdKey ?? false,
        entry: draft.entry,
        status: draft.status,
        since: before?.status === draft.status ? before.since : now,
      };
      registry.put(INSTRUCTION_KIND, action.key, row, now);
    },
  };
}
