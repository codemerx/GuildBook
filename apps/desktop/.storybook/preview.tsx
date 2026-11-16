import type { Preview } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../src/renderer/i18n.ts';
import '../src/renderer/styles.css';

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Light or dark theme',
      toolbar: { title: 'Theme', items: ['light', 'dark'], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: 'light' },
  decorators: [
    (Story, context) => {
      document.documentElement.classList.toggle('dark', context.globals.theme === 'dark');
      const rootRoute = createRootRoute({ component: () => <Story /> });
      const router = createRouter({
        routeTree: rootRoute.addChildren(
          ['/', '/library/$instanceId', '/library/$instanceId/inspector', '/settings', '/add-test-library'].map(
            (path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
          ),
        ),
        history: createMemoryHistory({ initialEntries: ['/'] }),
      });
      return (
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={new QueryClient()}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </I18nextProvider>
      );
    },
  ],
  parameters: { a11y: { test: 'error' } },
};

export default preview;
