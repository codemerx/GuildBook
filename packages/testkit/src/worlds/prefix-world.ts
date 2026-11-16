// The `same-prefix` world (TESTING.md §4, Step 8): two libraries that both use the prefix `acme`. Acme's library (the
// `acme-basic` one) is joined first; Acme Labs' library on the same plain server also says `prefix: acme`, so joining
// it asks for a local prefix (PLAN.md §3.3). Its skills have what the projected copies must keep: a skill with the same
// name as one of Acme's, a link inside a skill, a name that a longer local prefix pushes past 64 characters, and ignore
// rules for files a tool leaves in a skill.
export const LABS_LIBRARY_ID = `lib_${'1a'.repeat(16)}`;
export const LABS_REPO = 'acme-labs/skills';

/** 61 characters: under `acmelabs` it has 65, one too many (PLAN.md §3.3 "Name length"). */
export const LABS_LONG_SKILL = 'acme-incident-postmortem-writing-guide-for-production-outages';

export const LABS_INSTRUCTIONS = '# Acme Labs\n\nWe measure before we optimize.\n';

const skillMd = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;

/** A file of the world's library, or a link inside it (`link` is its target, as git stores it). */
export type WorldFile = string | { readonly link: string };

/** The Acme Labs library's files, as the world's first commit has them. */
export function labsLibraryFiles(): Record<string, WorldFile> {
  return {
    'library.yaml': `id: ${LABS_LIBRARY_ID}\nprefix: acme\nformat: 1\n`,
    'skills/acme-code-review/SKILL.md': skillMd(
      'acme-code-review',
      'Reviews code the Acme Labs way. Use it before every merge request.',
      'Measure first, then review.',
    ),
    'skills/acme-release-notes/SKILL.md': skillMd(
      'acme-release-notes',
      'Writes the Acme Labs release notes. Use it when a release is cut.',
      'Start from templates/latest.md.',
    ),
    'skills/acme-release-notes/templates/v2.md': '# Release {{version}}\n\n## Changes\n',
    // A link inside a skill: it stays a link in the projected copy (PLAN.md §3.15, A8.2).
    'skills/acme-release-notes/templates/latest.md': { link: 'v2.md' },
    [`skills/${LABS_LONG_SKILL}/SKILL.md`]: skillMd(
      LABS_LONG_SKILL,
      'Writes a postmortem after a production outage. Use it within a week of the outage.',
      'Blameless, with a timeline.',
    ),
    'instructions/AGENTS.md': LABS_INSTRUCTIONS,
    '.gitattributes': '* text=auto eol=lf\n',
    '.gitignore': '__pycache__/\n*.log\n.DS_Store\n',
  };
}
