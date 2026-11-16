# The fixture corpus

Real-world SKILL.md and AGENTS.md files, plus generated ones, for the fixture libraries that the worlds build. Every file is kept byte for byte as it was downloaded or written (`.gitattributes` turns off line-ending
conversion here, and Prettier skips this folder).

## Real-world files

Downloaded on 2026-10-15, unchanged. Each source's licence allows copying and redistribution with its notice.

| Folder | Source | Commit | Licence |
|---|---|---|---|
| `skills/anthropic/` | [anthropics/skills](https://github.com/anthropics/skills) `skills/<name>/SKILL.md` | `dbd4588f9e10` | Apache-2.0, each skill's own `LICENSE.txt` (same text, kept once as `skills/anthropic/LICENSE.txt`) |
| `skills/openai/` | [openai/skills](https://github.com/openai/skills) `skills/.curated/<name>/SKILL.md` | `49f948faa925` | Apache-2.0, each skill's own `LICENSE.txt` (kept once as `skills/openai/LICENSE.txt`) |
| `skills/vercel/` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) `skills/<name>/SKILL.md` | `063bee94c3f4` | MIT, as the repository's README states (it has no LICENSE file; two of the skills also say `license: MIT`) |
| `agents/agentsmd.AGENTS.md` | [agentsmd/agents.md](https://github.com/agentsmd/agents.md) `AGENTS.md` | `d001185d792e` | MIT, `agents/LICENSE-agentsmd.txt` |
| `agents/vercel-agent-skills.AGENTS.md` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) `AGENTS.md` | `063bee94c3f4` | MIT, as above |

Left out on purpose: skills under proprietary terms (Anthropic's document skills such as `docx`, and OpenAI's curated
Figma skills).

The real files show the variety the app meets: long one-line descriptions, a folded multi-line description, `license`
lines, `metadata` maps with quoted and plain values, and a name that differs from its folder
(`vercel/composition-patterns` says `name: vercel-composition-patterns`).
