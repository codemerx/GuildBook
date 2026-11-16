// The rules the "Add test library" form checks while the user types (IMPLEMENTATION.md §2.2: each rule exists once).
import { z } from 'zod';

export const LIBRARY_NAME_MAX = 100;

export const TestLibraryInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: 'addTestLibrary.nameRequired' })
    .max(LIBRARY_NAME_MAX, { error: 'errors.testLibrary.nameInvalid' })
    // No control characters (\p{Cc}), the same rule as core's checkTestLibrary.
    .regex(/^\P{Cc}*$/u, { error: 'errors.testLibrary.nameInvalid' }),
  path: z.string().min(1, { error: 'addTestLibrary.folderRequired' }),
});

export type TestLibraryInput = z.infer<typeof TestLibraryInputSchema>;
