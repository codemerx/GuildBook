// The editor's views and inputs (IMPLEMENTATION.md Step 10, PLAN.md §3.14): a library file, a skill's files, the new
// skill, version history, and "What the agent sees" per tool.
import { FILE_SIZE_MAX, FileNameSchema, LibraryRelativePathSchema } from '@app/schemas';
import { z } from 'zod';
import { SkillLinkViewSchema } from './link-views.ts';

const LibraryPath = LibraryRelativePathSchema;

export const FileKindSchema = z.enum(['markdown', 'text', 'image', 'binary']);

export const LibraryFileViewSchema = z.object({
  path: z.string(),
  kind: FileKindSchema,
  /** Markdown and other text; null for images and binaries. */
  text: z.string().nullable(),
  size: z.number().int().nonnegative(),
  /** The version on disk; a save names it as its base. */
  hash: z.string(),
});
export type LibraryFileView = z.infer<typeof LibraryFileViewSchema>;

export const SkillFileEntryViewSchema = z.object({
  path: z.string(),
  kind: z.enum(['file', 'dir', 'link']),
  size: z.number().int().nonnegative(),
});
export type SkillFileEntryView = z.infer<typeof SkillFileEntryViewSchema>;

export const SaveFileInputSchema = z.object({
  path: LibraryPath,
  text: z.string().max(FILE_SIZE_MAX),
  /** The version the edit started from; null for a new file. */
  base: z.string().max(100).nullable(),
});

export const SaveResultViewSchema = z.object({ hash: z.string(), written: z.boolean() });

export const SkillTemplateSchema = z.enum(['blank', 'how-to', 'checklist', 'reference']);
export type SkillTemplateView = z.infer<typeof SkillTemplateSchema>;

export const NewSkillInputSchema = z.object({
  /** The name in git: `<git prefix>-<rest>`. */
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  tags: z.array(z.string().max(100)).max(50),
  template: SkillTemplateSchema,
});

export const DropFolderSchema = z.enum(['assets', 'references', 'scripts']);

const Bytes = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array && value.length <= FILE_SIZE_MAX + 1024 * 1024,
  { message: 'bytes' },
);

export const AddSkillFileInputSchema = z.object({
  skill: FileNameSchema,
  /** Into `assets/`, `references/` or `scripts/`; null for the skill's own folder. */
  folder: DropFolderSchema.nullable(),
  name: FileNameSchema,
  bytes: Bytes,
  replace: z.boolean(),
});

export const AddFileResultViewSchema = z.object({ path: z.string(), large: z.boolean() });

export const VersionEntryViewSchema = z.object({
  commit: z.string(),
  author: z.string(),
  email: z.string(),
  date: z.number(),
  subject: z.string(),
});
export type VersionEntryView = z.infer<typeof VersionEntryViewSchema>;

export const AgentToolViewSchema = z.object({
  tool: z.string(),
  places: z.array(z.object({ dest: z.string(), folder: z.string(), status: SkillLinkViewSchema.shape.status })),
  seen: z
    .object({
      dest: z.string(),
      name: z.string().nullable(),
      description: z.string().nullable(),
      body: z.string(),
      size: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type AgentToolView = z.infer<typeof AgentToolViewSchema>;

/** A file the user picked in the OS dialog (main reads it): its name, size, and bytes unless it's over 50 MB. */
export const PickedFileViewSchema = z
  .object({ name: z.string(), size: z.number().int().nonnegative(), bytes: Bytes.nullable() })
  .nullable();
export type PickedFileView = z.infer<typeof PickedFileViewSchema>;
