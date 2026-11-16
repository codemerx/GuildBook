// The library snapshot as the renderer sees it (IMPLEMENTATION.md §2.8: the renderer never sees core's types).
import type { LibrarySnapshot } from '@app/core';
import type { LibrarySnapshotView } from '@app/ipc';

export function libraryView(snapshot: LibrarySnapshot | null): LibrarySnapshotView {
  if (snapshot === null) {
    return {
      state: 'loading',
      config: { id: null, prefix: null, format: null, minAppVersion: null, repoOnlyTags: [], suggest: {} },
      compatibility: 'unknown',
      skills: [],
      instructions: null,
      tags: [],
      issues: [],
    };
  }
  const value = snapshot.config.value;
  const count = (folder: string, severity: 'error' | 'warning') =>
    snapshot.issues.filter((issue) => issue.skill === folder && issue.severity === severity).length;
  return {
    state: 'ready',
    config: {
      id: value.id ?? null,
      prefix: snapshot.config.prefix,
      format: value.format ?? null,
      minAppVersion: value.minAppVersion ?? null,
      repoOnlyTags: [...(value.repoOnlyTags ?? [])],
      suggest: Object.fromEntries(Object.entries(value.suggest ?? {}).map(([tag, patterns]) => [tag, [...patterns]])),
    },
    compatibility: snapshot.compatibility,
    skills: snapshot.skills.map((skill) => ({
      ...skill,
      tags: [...skill.tags],
      errors: count(skill.folder, 'error'),
      warnings: count(skill.folder, 'warning'),
    })),
    instructions: snapshot.instructions && { ...snapshot.instructions },
    tags: snapshot.tags.map(({ tag, skills }) => ({ tag, skills: [...skills] })),
    issues: snapshot.issues.map((issue) => ({ ...issue, params: { ...issue.params } })),
  };
}
