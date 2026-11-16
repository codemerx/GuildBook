// What the pull preview, History and change requests mark in a commit (PLAN.md §3.15): changes under a skill's
// `scripts/`, and changes to a skill's `allowed-tools` field. `allowed-tools` lets a skill use tools such as Bash without
// asking, so a one-line header change can matter as much as a new script.
import { readSkillHeader } from '@app/schemas';
import { groupOf } from './changes.ts';

export interface CommitFlags {
  /** A file under a skill's `scripts/` was added, changed or deleted. */
  readonly scripts: boolean;
  /** A skill's `allowed-tools` changed (a new skill that has one counts). */
  readonly allowedTools: boolean;
  /** The skills the commit touches, by folder. */
  readonly skills: readonly string[];
}

/** Whether a library path is a skill's script. */
export function isScript(path: string): boolean {
  const group = groupOf(path);
  return group.skill !== null && path.startsWith(`skills/${group.skill}/scripts/`);
}

/** A SKILL.md's `allowed-tools`, as one comparable value; null without it (or without a readable header). */
export function allowedToolsOf(text: string | null): string | null {
  if (text === null) return null;
  const header = readSkillHeader(text);
  if (header.status !== 'ok') return null;
  const value = header.fields['allowed-tools'];
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** Whether `allowed-tools` changed between two versions of a SKILL.md. A deleted skill's tools go: not a flag. */
export function allowedToolsChanged(before: string | null, after: string | null): boolean {
  if (after === null) return false;
  return allowedToolsOf(before) !== allowedToolsOf(after);
}

/** The skills a set of library paths touches, sorted. */
export function skillsOf(paths: readonly string[]): string[] {
  const skills = new Set<string>();
  for (const path of paths) {
    const skill = groupOf(path).skill;
    if (skill !== null) skills.add(skill);
  }
  return [...skills].sort();
}
