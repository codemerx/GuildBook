// The placement calculator (PLAN.md §3.6 "How placement is calculated"): pure, per device and per skill.
// 1. Off: no links. Tag rules and individual additions never turn it back on.
// 2. Everywhere (global by choice): global links only; tag rules add no repo links ("● via global").
// 3. Default: claiming repos are those with a ticked tag the skill carries, or where the user added it; placed repos
//    are the claiming ones that don't exclude it. Placed repos → links there only. No claim → global by default,
//    unless a tag is repo-only. Claimed but excluded everywhere → linked nowhere: never global, which would bring it
//    back into the repo that excluded it.
// So a skill is never global and in a repo at the same time (§3.6 "never visible twice").
import type { SkillMode } from '@app/schemas';

export interface PlacementSkill {
  /** The skill's git name: its folder under skills/. */
  readonly folder: string;
  readonly tags: readonly string[];
}

export interface RepoTag {
  readonly repo: string;
  readonly tag: string;
}

export interface RepoSkill {
  readonly repo: string;
  readonly skill: string;
}

export interface PlacementInputs {
  readonly skills: readonly PlacementSkill[];
  /** Every added repo's id, missing ones included: a skill placed only there stays placed there (§3.8 S10). */
  readonly repos: readonly string[];
  readonly rules: readonly RepoTag[];
  readonly added: readonly RepoSkill[];
  readonly excluded: readonly RepoSkill[];
  /** Skills with a mode other than `default`. */
  readonly modes: ReadonlyArray<{ readonly skill: string; readonly mode: SkillMode }>;
  /** `repoOnlyTags` from library.yaml. */
  readonly repoOnlyTags: readonly string[];
}

/** Why a skill is where it is. */
export type PlacementKind =
  /** Turned Off. */
  | 'off'
  /** Everywhere: global by choice. */
  | 'everywhere'
  /** Nobody chose and no repo claims it: global by default. */
  | 'global'
  /** In its placed repos only. */
  | 'repos'
  /** Repos claim it, but every one excludes it: linked nowhere. */
  | 'excluded'
  /** A repo-only tag, and no repo claims it: linked nowhere until one does. */
  | 'repo-only';

/** How a repo claims a skill: the ticked tags it carries, and whether the user added it individually. */
export interface RepoClaim {
  readonly repo: string;
  readonly via: readonly string[];
  readonly added: boolean;
  /** The repo excludes it, so the claim places nothing there. */
  readonly excluded: boolean;
}

export interface SkillPlacement {
  readonly skill: string;
  readonly mode: SkillMode;
  readonly kind: PlacementKind;
  /** Linked in the global link folders. */
  readonly global: boolean;
  /** The repos it's linked in, sorted. */
  readonly repos: readonly string[];
  /** Every repo that claims it, excluded ones too, sorted by repo. */
  readonly claims: readonly RepoClaim[];
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: where each skill goes. One result per skill, in the order given. */
export function calculatePlacement(inputs: PlacementInputs): SkillPlacement[] {
  const repos = new Set(inputs.repos);
  const rulesByRepo = new Map<string, Set<string>>();
  for (const rule of inputs.rules) {
    if (!repos.has(rule.repo)) continue;
    const tags = rulesByRepo.get(rule.repo) ?? new Set<string>();
    tags.add(rule.tag);
    rulesByRepo.set(rule.repo, tags);
  }
  const key = (repo: string, skill: string) => `${repo}\u0000${skill}`;
  const added = new Set(inputs.added.filter((a) => repos.has(a.repo)).map((a) => key(a.repo, a.skill)));
  const excluded = new Set(inputs.excluded.filter((e) => repos.has(e.repo)).map((e) => key(e.repo, e.skill)));
  const modes = new Map(inputs.modes.map((m) => [m.skill, m.mode]));
  const repoOnly = new Set(inputs.repoOnlyTags);
  const repoList = [...repos].sort(byText);

  return inputs.skills.map((skill) => {
    const mode = modes.get(skill.folder) ?? 'default';
    const tags = new Set(skill.tags);
    const claims: RepoClaim[] = [];
    for (const repo of repoList) {
      const via = [...(rulesByRepo.get(repo) ?? [])].filter((tag) => tags.has(tag)).sort(byText);
      const isAdded = added.has(key(repo, skill.folder));
      if (via.length === 0 && !isAdded) continue;
      claims.push({ repo, via, added: isAdded, excluded: excluded.has(key(repo, skill.folder)) });
    }
    const base = { skill: skill.folder, mode, claims };
    if (mode === 'off') return { ...base, kind: 'off', global: false, repos: [] };
    if (mode === 'global') return { ...base, kind: 'everywhere', global: true, repos: [] };
    const placed = claims.filter((claim) => !claim.excluded).map((claim) => claim.repo);
    if (placed.length > 0) return { ...base, kind: 'repos', global: false, repos: placed };
    if (claims.length > 0) return { ...base, kind: 'excluded', global: false, repos: [] };
    if (skill.tags.some((tag) => repoOnly.has(tag))) return { ...base, kind: 'repo-only', global: false, repos: [] };
    return { ...base, kind: 'global', global: true, repos: [] };
  });
}

/** One overview cell for a repo (PLAN.md §3.6 "Overview screen"). */
export type RepoCell =
  /** ● placed there: via tags, or added individually. */
  | { readonly kind: 'placed'; readonly via: readonly string[]; readonly added: boolean }
  /** ○ excluded from a tag rule or an addition there. */
  | { readonly kind: 'excluded'; readonly via: readonly string[]; readonly added: boolean }
  /** ● via global: the repo claims it, but it's set to Everywhere. */
  | { readonly kind: 'via-global'; readonly via: readonly string[]; readonly added: boolean }
  /** Claimed, but the skill is Off. */
  | { readonly kind: 'off'; readonly via: readonly string[]; readonly added: boolean }
  | { readonly kind: 'none' };

export function repoCell(placement: SkillPlacement, repo: string): RepoCell {
  const claim = placement.claims.find((c) => c.repo === repo);
  if (!claim) return { kind: 'none' };
  const how = { via: claim.via, added: claim.added };
  if (placement.mode === 'off') return { kind: 'off', ...how };
  if (placement.mode === 'global') return { kind: 'via-global', ...how };
  return { kind: claim.excluded ? 'excluded' : 'placed', ...how };
}
