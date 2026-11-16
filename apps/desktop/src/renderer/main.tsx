// The renderer's entry: connect the ports, then render the app (IMPLEMENTATION.md §2.11).
import { brand } from '@app/brand';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { ErrorBoundary, reportError } from './features/errors/error-boundary.tsx';
import { NeedsUpdate } from './features/shell/needs-update.tsx';
import { StatusView } from './features/shell/status-view.tsx';
import { i18n, missingKeys, usePseudoLocale } from './i18n.ts';
import { connection } from './rpc/connection.ts';
import { connectCache, queryClient, useDeviceQuery } from './rpc/queries.ts';
import { router } from './router.tsx';
import './styles.css';
import { useApplyTheme } from './theme.ts';

document.title = brand.displayName;
connectCache(
  connection,
  (instanceId) => void router.navigate({ to: '/library/$instanceId', params: { instanceId } }),
  // An invite link opens "Join Acme" (PLAN.md §3.17 step 1): the URL page with the link's git URL filled in.
  (invite) =>
    void router.navigate({
      to: '/connect',
      search: invite.ok
        ? {
            intent: 'join',
            url: invite.url,
            ...(invite.clientId ? { clientId: invite.clientId } : {}),
            invite: invite.seq,
          }
        : { intent: 'join', invalid: invite.problem, invite: invite.seq },
    }),
);
connection.start();
window.addEventListener('error', (event) => reportError(event.error ?? event.message));
if (__TEST_HOOKS__) {
  // Test builds only: send a raw message on an instance's port and return the first answer (A1.5).
  (window as { __appRendererTest?: unknown }).__appRendererTest = {
    // The keys the window asked for that the translation file lacks (the pseudo-locale tour, A17.6).
    missingKeys: () => [...missingKeys],
    sendRaw: (instanceId: string, message: unknown, waitMs = 3000) =>
      new Promise<unknown>((resolve) => {
        const port = connection.rawPort(instanceId);
        if (!port) {
          resolve(null);
          return;
        }
        const id = (message as { id?: unknown } | null)?.id;
        const off = port.onMessage((reply) => {
          const r = reply as { t?: unknown; id?: unknown };
          if (typeof id === 'number' ? r.id === id : r.t === 'err') {
            off();
            resolve(reply);
          }
        });
        port.postMessage(message);
        setTimeout(() => {
          off();
          resolve(null);
        }, waitMs);
      }),
  };
}
window.addEventListener('unhandledrejection', (event) => reportError(event.reason));

function App() {
  const settings = useDeviceQuery('settings');
  const appInfo = useDeviceQuery('appInfo');
  const windowMode = useDeviceQuery('windowMode');
  useApplyTheme(settings.data?.theme);
  usePseudoLocale(appInfo.data?.locale);
  if (appInfo.data?.deviceState === 'newerData') return <NeedsUpdate />;
  // A desktop without a tray (PLAN.md §3.19): the window stays open as a small status view.
  if (windowMode.data?.mode === 'status') return <StatusView />;
  return <RouterProvider router={router} />;
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </QueryClientProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}
