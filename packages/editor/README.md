# @app/editor

The Markdown editor behind an interface (ADR 0019, IMPLEMENTATION.md §2.11). Features use only `MarkdownEditor`, so
the engine can change without touching them.

- **Rich mode:** Milkdown (Crepe) 7, chosen by the fidelity research (ADR 0029). Only the features the app uses are
  added (no LaTeX, image upload, AI or Crepe's list-item view). Tab leaves the editor except in a list item or a table
  cell (A10.11).
- **Untouched blocks keep their text** (`blocks.ts`, ADR 0029): the saved text is the loaded text with only the
  changed blocks written by the engine, in the file's own bullet and rule style. A file opened and saved changes
  nothing (A10.1, `rich.golden.test.ts` over the fixture corpus).
- **Source mode and other text files:** CodeMirror 6, with highlighting by file name and a SKILL.md's header read as
  YAML. The file keeps its line endings.
- **Diffs:** `createDiffView`, a unified view of a past version against the current one (@codemirror/merge).
- **Theme:** `@app/editor/theme.css` maps Crepe's variables to the app's light and dark tokens.
- **Imports:** `schemas`, `brand`.
