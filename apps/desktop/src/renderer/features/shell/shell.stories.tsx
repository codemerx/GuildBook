import type { InstanceView } from '@app/ipc';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppShellView } from './app-shell.tsx';
import { EmptyState } from './empty-state.tsx';

const acme: InstanceView = {
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
const globex: InstanceView = {
  ...acme,
  id: 'lib_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  name: 'Globex',
  status: 'restarting',
  prefix: null,
};

const meta: Meta<typeof AppShellView> = { title: 'Shell/AppShell', component: AppShellView };
export default meta;
type Story = StoryObj<typeof AppShellView>;

export const Empty: Story = {
  args: { instances: [], currentId: undefined, testLibraries: true, children: <EmptyState testLibraries /> },
};
export const OneLibrary: Story = {
  args: { instances: [acme], currentId: acme.id, testLibraries: false, children: null },
};
export const LibraryRestarting: Story = {
  args: { instances: [acme, globex], currentId: globex.id, testLibraries: true, children: null },
};
