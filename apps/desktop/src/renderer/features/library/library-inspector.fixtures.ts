// Library snapshots as the worker sends them, for the inspector's stories and component tests.
import type { InstanceView, LibrarySnapshotView } from '@app/ipc';

export const acmeInstance: InstanceView = {
  id: 'lib_acacacacacacacacacacacacacacacac',
  name: 'Acme',
  status: 'ready',
  error: null,
  libraryPath: '/Users/john/libraries/acme',
  gitUrl: null,
  prefix: 'acme',
  restarts: 0,
  attention: 0,
  instructionsLinked: false,
};

const config = {
  id: 'lib_acacacacacacacacacacacacacacacac',
  prefix: 'acme',
  format: 1,
  minAppVersion: null,
  repoOnlyTags: ['frontend'],
  suggest: { backend: ['acme/backend-*'] },
};

const skill = (folder: string, tags: string[], errors = 0, warnings = 0) => ({
  folder,
  name: folder,
  description: 'Use when …',
  tags,
  source: null,
  allowedTools: null,
  files: 1,
  bytes: 1200,
  scripts: false,
  fingerprint: 'e5c1a4f0c2d94b3a8e7f6d5c4b3a291807f6e5d4',
  errors,
  warnings,
});

export const validSnapshot: LibrarySnapshotView = {
  state: 'ready',
  config,
  compatibility: 'ok',
  skills: [skill('acme-code-review', ['backend']), skill('acme-release-notes', ['writing', 'backend'])],
  instructions: { path: 'instructions/AGENTS.md', bytes: 2031, characters: 2031 },
  tags: [
    { tag: 'backend', skills: ['acme-code-review', 'acme-release-notes'] },
    { tag: 'writing', skills: ['acme-release-notes'] },
  ],
  issues: [],
};

export const invalidSnapshot: LibrarySnapshotView = {
  ...validSnapshot,
  compatibility: 'appTooOld',
  config: { ...config, minAppVersion: '99.0.0' },
  skills: [skill('acme-links', [], 1, 2), skill('composition-patterns', ['frontend'], 2)],
  issues: [
    {
      code: 'library.appTooOld',
      severity: 'error',
      messageKey: 'issues.library.appTooOld',
      path: 'library.yaml',
      skill: null,
      params: { minAppVersion: '99.0.0', appVersion: '0.1.0' },
    },
    {
      code: 'instructions.nearLimit',
      severity: 'warning',
      messageKey: 'issues.instructions.nearLimit',
      path: 'instructions/AGENTS.md',
      skill: null,
      params: { tool: 'Windsurf', size: 5302, limit: 6000, unit: 'characters' },
    },
    {
      code: 'link.broken',
      severity: 'warning',
      messageKey: 'issues.link.broken',
      path: 'skills/acme-links/SKILL.md',
      skill: 'acme-links',
      params: { target: 'references/missing.md', line: 6 },
    },
    {
      code: 'symlink.outsideSkill',
      severity: 'error',
      messageKey: 'issues.symlink.outsideSkill',
      path: 'skills/acme-links/credentials',
      skill: 'acme-links',
      params: { target: '/home/someone/.aws/credentials' },
    },
    {
      code: 'skill.nameMismatch',
      severity: 'error',
      messageKey: 'issues.skill.nameMismatch',
      path: 'skills/composition-patterns/SKILL.md',
      skill: 'composition-patterns',
      params: { name: 'vercel-composition-patterns', folder: 'composition-patterns' },
    },
  ],
};

export const loadingSnapshot: LibrarySnapshotView = { ...validSnapshot, state: 'loading', skills: [], tags: [] };
