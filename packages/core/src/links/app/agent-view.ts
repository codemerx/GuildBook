// "What the agent sees" (PLAN.md §3.14, A10.5): for each enabled tool, where the skill is linked for it, and the
// SKILL.md the tool reads through that link: the name and description it loads at start, and the body it reads when
// the skill is used. It's read through the link, as the tool reads it, so under a local prefix it's the projected copy.
import { readSkillHeader, splitSkillMd } from '@app/schemas';
import { defineQuery } from '../../engine/index.ts';
import type { FileSystem } from '../../ports/fs.ts';
import type { AbsPath } from '../../shared/brand.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import type { SkillLinkView } from './link-service.ts';

export interface AgentPlace {
  readonly dest: string;
  readonly folder: string;
  readonly status: SkillLinkView['status'];
}

export interface AgentToolView {
  readonly tool: string;
  /** Every link of the skill in a folder this tool reads. */
  readonly places: readonly AgentPlace[];
  /** What the tool reads through its first working link; null when no link works for it. */
  readonly seen: {
    readonly dest: string;
    readonly name: string | null;
    readonly description: string | null;
    readonly body: string;
    /** The whole SKILL.md's size in bytes. */
    readonly size: number;
  } | null;
}

export const AgentViewQuery = defineQuery<{ readonly skill: string }, AgentToolView[]>('AgentView');

export interface AgentViewDeps {
  readonly fs: FileSystem;
  readonly paths: PathFlavour;
  /** The enabled tools' names, in the tools page's order. */
  readonly tools: () => readonly string[];
  readonly links: (skill: string) => readonly SkillLinkView[];
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

export async function agentView(deps: AgentViewDeps, skill: string): Promise<AgentToolView[]> {
  const links = deps.links(skill);
  const views: AgentToolView[] = [];
  for (const tool of deps.tools()) {
    const places = links
      .filter((link) => link.tools.includes(tool))
      .map((link) => ({ dest: link.dest, folder: link.folder, status: link.status }));
    let seen: AgentToolView['seen'] = null;
    for (const place of places.filter((p) => p.status === 'linked')) {
      const file = deps.paths.join(place.dest, 'SKILL.md') as AbsPath;
      try {
        const bytes = await deps.fs.readBytes(file);
        const text = decoder.decode(bytes);
        const header = readSkillHeader(text);
        const field = (key: string) => {
          const value = header.status === 'ok' ? header.fields[key] : undefined;
          return typeof value === 'string' ? value : null;
        };
        seen = {
          dest: place.dest,
          name: field('name'),
          description: field('description'),
          body: splitSkillMd(text).body,
          size: bytes.length,
        };
        break;
      } catch {
        // Not readable through this link: the next one, or nothing (the Doctor reports it).
      }
    }
    views.push({ tool, places, seen });
  }
  return views;
}
