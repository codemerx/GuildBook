// Routes (IMPLEMENTATION.md Step 1): one library's pages under /library/$instanceId, device-wide pages beside them.
// Hash history, so the app:// protocol only ever serves index.html.
import { createHashHistory, createRootRoute, createRoute, createRouter, Navigate } from '@tanstack/react-router';
import { AppShell } from './features/shell/app-shell.tsx';
import { EmptyState } from './features/shell/empty-state.tsx';
import { ErrorPanel, reportError } from './features/errors/error-boundary.tsx';
import { LibraryGitPage } from './features/library/library-git-page.tsx';
import { LibraryInspectorPage } from './features/library/library-inspector-page.tsx';
import { LibraryPage } from './features/library/library-page.tsx';
import { ActivityPage, timelineSearch } from './features/links/activity-page.tsx';
import { AttentionPage } from './features/links/attention-page.tsx';
import { ToolsPage } from './features/links/tools-page.tsx';
import { OverviewPage } from './features/placement/overview-page.tsx';
import { RepoPage } from './features/placement/repo-page.tsx';
import { ReposPage } from './features/placement/repos-page.tsx';
import { SettingsPage } from './features/settings/settings-page.tsx';
import { ConnectPage } from './features/setup/connect-page.tsx';
import { DoctorPage } from './features/doctor/doctor-page.tsx';
import { InstructionsEditorPage } from './features/editor/instructions-editor-page.tsx';
import { EditorHomePage, NewSkillPage } from './features/editor/new-skill-page.tsx';
import { SkillEditorPage } from './features/editor/skill-editor-page.tsx';
import { ImportPage } from './features/imports/import-page.tsx';
import { ImportReviewPage } from './features/imports/import-review-page.tsx';
import { InstructionsPage } from './features/instructions/instructions-page.tsx';
import { SetupWizardPage } from './features/setup/wizard-page.tsx';
import { SetupPage } from './features/setup/setup-page.tsx';
import { AddTestLibraryPage } from './features/test-library/add-test-library-page.tsx';
import { BranchesPage, StashesPage } from './features/sync/branches-page.tsx';
import { ChangesPage } from './features/sync/changes-page.tsx';
import { ConflictsPage } from './features/sync/conflicts-page.tsx';
import { HistoryPage } from './features/sync/history-page.tsx';
import { IncomingPage } from './features/sync/incoming-page.tsx';
import { useDeviceQuery } from './rpc/queries.ts';

function Home() {
  const instances = useDeviceQuery('instances');
  const appInfo = useDeviceQuery('appInfo');
  if (!instances.data || !appInfo.data) return null;
  const first = instances.data[0];
  if (first) return <Navigate to="/library/$instanceId" params={{ instanceId: first.id }} replace />;
  return <EmptyState testLibraries={appInfo.data.features.testLibraries} />;
}

/** The URL page's search: the wizard, and what an invite link carried (Step 15). */
export interface ConnectSearch {
  intent: 'join' | 'create';
  url?: string;
  clientId?: string;
  /** The invite's number, which main forgets once the page showed it. */
  invite?: number;
  /** Why an invite link was refused. */
  invalid?: string;
}

function intentOf(search: Record<string, unknown>): ConnectSearch {
  const text = (value: unknown) => (typeof value === 'string' && value.length <= 4096 ? value : undefined);
  const out: ConnectSearch = { intent: search.intent === 'create' ? 'create' : 'join' };
  const url = text(search.url);
  const clientId = text(search.clientId);
  const invalid = text(search.invalid);
  if (url !== undefined) out.url = url;
  if (clientId !== undefined) out.clientId = clientId;
  if (invalid !== undefined) out.invalid = invalid;
  if (typeof search.invite === 'number') out.invite = search.invite;
  return out;
}

const rootRoute = createRootRoute({
  component: AppShell,
  errorComponent: ({ error, reset }) => {
    reportError(error);
    return <ErrorPanel onRetry={reset} />;
  },
});

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: Home }),
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId', component: LibraryPage }),
  // A developer page: development and test builds only (IMPLEMENTATION.md Step 2).
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/$instanceId/inspector',
    component: LibraryInspectorPage,
  }),
  // A developer page: development and test builds only (IMPLEMENTATION.md Step 3).
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId/git', component: LibraryGitPage }),
  // Step 5: "Needs attention", the activity log and the tools page of a library.
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId/attention', component: AttentionPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/$instanceId/activity',
    component: ActivityPage,
    validateSearch: timelineSearch,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId/tools', component: ToolsPage }),
  // Step 6: the placement overview, the repos, and one repo's page.
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId/overview', component: OverviewPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId/repos', component: ReposPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId/repos/$repoId', component: RepoPage }),
  // Step 7: the Doctor of a library, and the Instructions page across every library on the device.
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId/doctor', component: DoctorPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/instructions', component: InstructionsPage }),
  // Step 10: the editor of a library's skills and instructions, and the new-skill wizard.
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId/edit', component: EditorHomePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId/edit/new', component: NewSkillPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/$instanceId/edit/instructions',
    component: InstructionsEditorPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/$instanceId/edit/skill/$skill',
    component: SkillEditorPage,
  }),
  // Step 13: imports: the sources, the found skills and the review of each one.
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId/edit/import', component: ImportPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/$instanceId/edit/import/$candidate',
    component: ImportReviewPage,
  }),
  // Step 11: the git screens: changes, the incoming preview, conflicts, history, branches and stashes.
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId/changes', component: ChangesPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/$instanceId/changes/incoming',
    component: IncomingPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/$instanceId/changes/conflicts',
    component: ConflictsPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/$instanceId/changes/history',
    component: HistoryPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/$instanceId/changes/branches',
    component: BranchesPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/$instanceId/changes/stashes',
    component: StashesPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
  // Joining and creating a library (Step 4): the URL page, the wizard while the setup is pending, and after the download.
  createRoute({ getParentRoute: () => rootRoute, path: '/connect', component: ConnectPage, validateSearch: intentOf }),
  createRoute({ getParentRoute: () => rootRoute, path: '/setup/$setupId', component: SetupPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/library/$instanceId/setup', component: SetupWizardPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/add-test-library', component: AddTestLibraryPage }),
];

export const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  history: createHashHistory(),
  defaultPreload: false,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
