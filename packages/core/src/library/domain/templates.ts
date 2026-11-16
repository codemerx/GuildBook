// The new-skill wizard's templates (PLAN.md §3.14): each makes a valid skill (A10.6). "Reference skill" holds documents
// in `references/`, e.g. an architecture overview. A template is the skill's files; the header comes from the wizard.
// Their text is the content of the user's library, in English like the Agent Skills specification.
import { editSkillMd, friendlyTitle } from '@app/schemas';

export const SKILL_TEMPLATES = ['blank', 'how-to', 'checklist', 'reference'] as const;
export type SkillTemplate = (typeof SKILL_TEMPLATES)[number];

export interface NewSkill {
  /** The name in git: `<git prefix>-<rest>`. */
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly template: SkillTemplate;
}

/** The header: the name, the description and the tags, quoted where YAML needs it (the format-preserving edits). */
function header(skill: NewSkill): string {
  const edited = editSkillMd(`---\nname: ${skill.name}\ndescription: ""\n---\n`, {
    description: skill.description,
    tags: skill.tags,
  });
  // The name is checked before a skill is created, so the edit always succeeds.
  return edited.ok ? edited.text : '';
}

function body(skill: NewSkill, prefix: string | null): string {
  const title = friendlyTitle(skill.name, prefix);
  switch (skill.template) {
    case 'blank':
      return `# ${title}\n\n`;
    case 'how-to':
      return [
        `# ${title}`,
        '',
        '## When to use it',
        '',
        '- Describe the situation where this skill helps.',
        '',
        '## Steps',
        '',
        '1. First step.',
        '2. Second step.',
        '',
        '## Examples',
        '',
        '- An example request and what a good answer looks like.',
        '',
      ].join('\n');
    case 'checklist':
      return [
        `# ${title}`,
        '',
        'Go through every item before you finish.',
        '',
        '- [ ] First item to check',
        '- [ ] Second item to check',
        '',
      ].join('\n');
    case 'reference':
      return [
        `# ${title}`,
        '',
        'This skill holds reference documents. Read the one that fits the question:',
        '',
        '- [Overview](references/overview.md): start here.',
        '',
      ].join('\n');
  }
}

/** The files of a new skill, relative to its folder. */
export function skillFiles(skill: NewSkill, prefix: string | null): Record<string, string> {
  const files: Record<string, string> = { 'SKILL.md': `${header(skill)}\n${body(skill, prefix)}` };
  if (skill.template === 'reference') {
    files['references/overview.md'] = `# ${friendlyTitle(skill.name, prefix)}: overview\n\nWrite the overview here.\n`;
  }
  return files;
}
