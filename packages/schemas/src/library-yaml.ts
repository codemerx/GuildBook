// library.yaml: the library's settings, stored in git (PLAN.md §3.2). Devices run different app versions, so unknown
// fields are ignored, and a newer `format` or a higher `minAppVersion` is reported rather than read as an error
// (A2.5). Reading it never fails: what can't be read becomes a problem code (`issues.<code>`).
import { isMap, isScalar, parseDocument } from 'yaml';
import { z } from 'zod';
import { LibraryIdSchema } from './names.ts';

/** The library layout this app version understands. Raised only for changes older apps can't handle. */
export const LIBRARY_FORMAT = 1;

export const LIBRARY_FILE = 'library.yaml';

/** A version like "1.4.0" (pre-release and build suffixes allowed). */
export const AppVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);

/** The fields this app version reads. Others are ignored, so older apps keep working with newer files. */
export const LibraryYamlSchema = z.object({
  id: LibraryIdSchema,
  prefix: z.string(),
  format: z.number().int().positive(),
  minAppVersion: AppVersionSchema.optional(),
  /** Tag suggestion hints: tag → remote patterns, e.g. `backend: ["acme/backend-*"]` (PLAN.md §3.6). */
  suggest: z.record(z.string(), z.array(z.string())).optional(),
  /** Tags whose skills are never global by default (PLAN.md §3.6). */
  repoOnlyTags: z.array(z.string()).optional(),
});

export type LibraryYaml = z.infer<typeof LibraryYamlSchema>;

export type LibraryYamlProblem =
  | 'library.configInvalid'
  | 'library.idInvalid'
  | 'library.formatInvalid'
  | 'library.prefixMissing'
  | 'library.minAppVersionInvalid'
  | 'library.suggestInvalid'
  | 'library.repoOnlyTagsInvalid';

export interface LibraryYamlRead {
  /** What could be read. Fields that failed their check are left out. */
  readonly value: Partial<LibraryYaml>;
  readonly problems: readonly LibraryYamlProblem[];
}

const fieldProblem: Record<string, LibraryYamlProblem> = {
  id: 'library.idInvalid',
  prefix: 'library.prefixMissing',
  format: 'library.formatInvalid',
  minAppVersion: 'library.minAppVersionInvalid',
  suggest: 'library.suggestInvalid',
  repoOnlyTags: 'library.repoOnlyTagsInvalid',
};

/** Reads library.yaml field by field, so one bad field doesn't hide the others (e.g. a newer `format`). */
export function readLibraryYaml(text: string): LibraryYamlRead {
  const doc = parseDocument(text, { prettyErrors: false });
  let data: unknown;
  try {
    data = doc.errors.length > 0 ? undefined : doc.toJS({ maxAliasCount: 0 });
  } catch {
    data = undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { value: {}, problems: ['library.configInvalid'] };
  }
  const record = data as Record<string, unknown>;
  const value: Record<string, unknown> = {};
  const problems: LibraryYamlProblem[] = [];
  for (const [key, schema] of Object.entries(LibraryYamlSchema.shape)) {
    const field = record[key];
    const parsed = schema.safeParse(field);
    if (parsed.success) {
      if (parsed.data !== undefined) value[key] = parsed.data;
    } else {
      problems.push(fieldProblem[key] ?? 'library.configInvalid');
    }
  }
  return { value, problems };
}

/** library.yaml as the app writes it for a new library (Step 4). */
export function writeLibraryYaml(value: LibraryYaml): string {
  const lines = [`id: ${value.id}`, `prefix: ${value.prefix}`, `format: ${value.format}`];
  if (value.minAppVersion !== undefined) lines.push(`minAppVersion: ${JSON.stringify(value.minAppVersion)}`);
  if (value.suggest !== undefined) lines.push(`suggest: ${JSON.stringify(value.suggest)}`);
  if (value.repoOnlyTags !== undefined) lines.push(`repoOnlyTags: ${JSON.stringify(value.repoOnlyTags)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * library.yaml with another prefix (PLAN.md §3.2: the correction before the lock, and the Admin's prefix change). Only
 * the `prefix:` value's text changes, so the commit changes one line: comments, the other fields and their layout stay
 * as they are. Null when the text can't be read as library.yaml with a plain prefix value.
 */
export function withLibraryPrefix(text: string, prefix: string): string | null {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  const node = doc.contents.get('prefix', true);
  if (!isScalar(node) || typeof node.value !== 'string' || !node.range) return null;
  const [start, end] = node.range;
  return `${text.slice(0, start)}${prefix}${text.slice(end)}`;
}

/**
 * library.yaml with other tag hints (PLAN.md §3.6, §3.17 Admin step 6): `suggest` and `repoOnlyTags` are set, or
 * removed when empty. The other fields and comments stay. Null when the text can't be read as a YAML map.
 */
export function withLibraryTags(
  text: string,
  tags: { readonly suggest: Readonly<Record<string, readonly string[]>>; readonly repoOnlyTags: readonly string[] },
): string | null {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  const suggest = Object.fromEntries(
    Object.entries(tags.suggest)
      .filter(([, patterns]) => patterns.length > 0)
      .map(([tag, patterns]) => [tag, [...new Set(patterns)]]),
  );
  if (Object.keys(suggest).length > 0) doc.set('suggest', doc.createNode(suggest, { flow: true }));
  else doc.delete('suggest');
  if (tags.repoOnlyTags.length > 0)
    doc.set('repoOnlyTags', doc.createNode([...new Set(tags.repoOnlyTags)].sort(), { flow: true }));
  else doc.delete('repoOnlyTags');
  return doc.toString();
}
