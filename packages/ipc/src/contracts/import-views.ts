// The views and inputs of imports (IMPLEMENTATION.md Step 13, PLAN.md §3.18): the source, the table of found skills,
// a skill's review, the import report, and the originals that can be replaced.
import { FILE_SIZE_MAX, LibraryRelativePathSchema } from '@app/schemas';
import { z } from 'zod';
import { IssueViewSchema } from './views.ts';

const Path = z.string().min(1).max(4096);
const Id = z.string().min(1).max(100);

export const ImportSourceInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().min(1).max(2048) }),
  z.object({ kind: z.literal('folder'), path: Path }),
  z.object({ kind: z.literal('archive'), path: Path }),
]);
export type ImportSourceInput = z.infer<typeof ImportSourceInputSchema>;

export const LayoutKindSchema = z.enum(['single', 'root', 'skills', 'agents', 'claude', 'plugin']);

export const NotImportedViewSchema = z.object({
  kind: z.enum(['command', 'agent', 'hook', 'mcp']),
  path: z.string(),
});
export type NotImportedView = z.infer<typeof NotImportedViewSchema>;

export const ImportCandidateViewSchema = z.object({
  id: Id,
  /** Where it was found in the source; '' when the source is the skill. */
  foundAt: z.string(),
  layout: LayoutKindSchema,
  oldName: z.string(),
  /** The name it gets in the library. */
  name: z.string(),
  /** The old name didn't follow the standard and was fixed. */
  fixed: z.boolean(),
  scripts: z.boolean(),
  allowedTools: z.boolean(),
  clash: z.enum(['library', 'import']).nullable(),
  /** Opened in the editor for review: the ✓ (PLAN.md §3.18). */
  opened: z.boolean(),
});
export type ImportCandidateView = z.infer<typeof ImportCandidateViewSchema>;

const ImportSourceViewSchema = z.object({ kind: z.enum(['url', 'folder', 'archive']), label: z.string() });

export const ImportSessionViewSchema = z.object({
  id: Id,
  source: ImportSourceViewSchema,
  candidates: z.array(ImportCandidateViewSchema),
  notImported: z.array(NotImportedViewSchema),
  record: z.string().nullable(),
  replaceable: z.boolean(),
});
export type ImportSessionView = z.infer<typeof ImportSessionViewSchema>;

export const ImportReviewViewSchema = z.object({
  candidate: ImportCandidateViewSchema,
  /** SKILL.md as it is in the source. */
  original: z.string(),
  /** SKILL.md as it will be added. */
  staged: z.string(),
  files: z.array(
    z.object({ path: z.string(), kind: z.enum(['file', 'dir', 'link']), size: z.number().int().nonnegative() }),
  ),
  flags: z.object({
    scripts: z.array(z.string()),
    allowedTools: z.string().nullable(),
    links: z.array(z.object({ path: z.string(), target: z.string() })),
  }),
  issues: z.array(IssueViewSchema),
  mentions: z.array(
    z.object({ file: z.string(), line: z.number().int().positive(), name: z.string(), text: z.string() }),
  ),
});
export type ImportReviewView = z.infer<typeof ImportReviewViewSchema>;

export const ImportReportViewSchema = z.object({
  added: z.array(z.object({ name: z.string(), foundAt: z.string() })),
  notImported: z.array(NotImportedViewSchema),
  source: ImportSourceViewSchema,
});
export type ImportReportView = z.infer<typeof ImportReportViewSchema>;

export const OriginalOfferViewSchema = z.object({ skill: z.string(), original: z.string() });
export type OriginalOfferView = z.infer<typeof OriginalOfferViewSchema>;

export const ImportFileInputSchema = z.object({ id: Id, path: LibraryRelativePathSchema });

export const SaveImportFileInputSchema = z.object({
  id: Id,
  path: LibraryRelativePathSchema,
  text: z.string().max(FILE_SIZE_MAX),
  base: z.string().max(100).nullable(),
});

export const ImportProgressSchema = z.object({ done: z.number(), total: z.number() });
