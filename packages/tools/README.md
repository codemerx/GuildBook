# @app/tools

The tool catalog's format (PLAN.md §3.4): one data entry per agent tool, with its folders, file names and
`home_env` variables. The catalog ships with the app and is refreshed as a signed file (ADR 0026), so the format is
versioned (`CATALOG_SCHEMA_VERSION`).

- `src/catalog.json`: the bundled catalog (Step 2), one entry per tool with documented folders in PLAN.md §1.2. No
  entry is `verified` yet: the tool lab (research R1, postponed by the user on 2026-10-23) fills that in. Instruction
  limits carry a unit (Codex: 32 KiB in bytes; Windsurf: 6,000 characters).
- **Instructions (Step 7):** each entry's `instructions.method` is `import-file`, `owned-file`, `marked-block` or
  `manual`, with `import_from` (Gemini), `override` (Codex), `config_entry` (OpenCode) and `file_suffix` (Copilot)
  where a tool needs them. `home_env_subdir` names the tool's folder inside the `home_env` folder (OpenCode under
  `XDG_CONFIG_HOME`). No catalog was published yet, so `CATALOG_SCHEMA_VERSION` stays 1.
- `src/keys.ts`: the public keys trusted for a refreshed catalog. The development key is trusted by development and
  test builds only; its private half is in `testkit` (`@app/testkit/catalog`).
- `homeEnvVariables` feeds the login-shell reader (A1.15); `instructionLimits` the library's validation.

- **Imports:** `schemas`, `brand`.
