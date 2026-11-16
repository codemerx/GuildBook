# @app/schemas

Zod schemas for every format that is stored or crosses a process boundary (IMPLEMENTATION.md §2.2): `device.json`
(versions 0 to 3), instance settings, operation journals, device operations, ids, error codes, and the "Add test
library" form, which the renderer and main check with the same rules.

- **Step 2:** the naming rules the forms check while the user types (`names.ts`: prefix, skill name, tag,
  description, library id, file-size limits), `library.yaml` (`library-yaml.ts`), and SKILL.md (`skill-md.ts`): reading
  its header, and format-preserving edits of `name`, `metadata.tags` and `metadata.source`. The yaml Document API finds
  the field, and only its text is replaced; the result is read back and refused if anything else changed. Golden file:
  `src/__golden__/skill-md-edits.json` (`UPDATE_GOLDEN=1` rewrites it; review the change).
- **Step 7:** the instruction artifact's registry row, and the edits of OpenCode's `opencode.json`
  (`instructions.ts`): `jsonc-parser` parses it, and the app adds and removes its one entry by offsets, so the user's
  comments and formatting stay. `device.json` version 3: a custom tool's instructions file and method.
- **Step 8:** the projected copy's registry row (`projection.ts`), the instance settings' local prefix (a copy of
  `device.json`'s), the trash reason for a copy, and the local prefix's error codes.
- **Imports:** `brand`, and the npm packages `zod`, `yaml` and `jsonc-parser`.
- **Versioned formats** carry `schemaVersion`. Migrations live in `core` (for example `migrateV0ToV1`); a file from a
  newer version is never rewritten (A1.17).
