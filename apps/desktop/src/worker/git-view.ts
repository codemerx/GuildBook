// The library's git state as the renderer and the test API see it (Step 3's developer git page, TESTING.md §6
// `git(repo)`): the branch, its upstream, changes, the latest commits, incoming commits, and a merge or rebase in
// progress. Failures become the view's state, so the page can say what's wrong.
import { type Commit, type GitRepo, isAppError, type StatusEntry } from '@app/core';
import type { GitChangeView, GitCommitView, LibraryGitView } from '@app/ipc';

export const GIT_LOG_LIMIT = 20;

const commitView = (commit: Commit): GitCommitView => ({
  id: commit.id,
  subject: commit.subject,
  author: commit.author.name,
  authorDate: commit.authorDate,
  merge: commit.parents.length > 1,
});

function changeView(entry: StatusEntry): GitChangeView {
  if (entry.kind === 'untracked') {
    return { path: entry.path, from: null, change: 'untracked', staged: false, conflict: null };
  }
  if (entry.kind === 'conflicted') {
    return { path: entry.path, from: null, change: 'conflicted', staged: false, conflict: entry.conflict };
  }
  const staged = entry.staged !== 'unmodified';
  const code = staged ? entry.staged : entry.unstaged;
  return {
    path: entry.path,
    from: entry.from,
    change: code === 'unmodified' ? 'modified' : code,
    staged,
    conflict: null,
  };
}

const empty: Omit<LibraryGitView, 'state' | 'error'> = {
  branch: null,
  head: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: 'none',
  busy: false,
  changes: [],
  log: [],
  incoming: [],
  stashes: 0,
};

export async function libraryGitView(repo: GitRepo): Promise<LibraryGitView> {
  try {
    const state = await repo.state();
    const status = await repo.status();
    const log = await repo.log({ max: GIT_LOG_LIMIT });
    const incoming = status.upstream ? await repo.log({ range: `HEAD..${status.upstream}`, max: GIT_LOG_LIMIT }) : [];
    const stashes = await repo.stashList();
    return {
      state: 'ready',
      error: null,
      branch: status.branch,
      head: status.head,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      operation: state.operation,
      busy: state.busy,
      changes: status.entries.map(changeView),
      log: log.map(commitView),
      incoming: incoming.map(commitView),
      stashes: stashes.length,
    };
  } catch (error) {
    const view = isAppError(error)
      ? { code: error.code, params: error.params }
      : { code: 'internal' as const, params: {} };
    return { ...empty, state: view.code === 'git.notARepository' ? 'notARepository' : 'failed', error: view };
  }
}
