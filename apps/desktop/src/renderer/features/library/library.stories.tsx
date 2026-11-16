import type { Meta, StoryObj } from '@storybook/react-vite';
import { LibraryPageView } from './library-page.tsx';

const instance = {
  id: 'lib_acacacacacacacacacacacacacacacac',
  name: 'Acme',
  status: 'ready' as const,
  error: null,
  libraryPath: '/Users/john/libraries/acme',
  gitUrl: null,
  prefix: null,
  restarts: 0,
  attention: 0,
  instructionsLinked: false,
};

const meta: Meta<typeof LibraryPageView> = {
  title: 'Library/LibraryPage',
  component: LibraryPageView,
  args: {
    home: '/Users/john',
    instance,
    status: {
      instanceId: instance.id,
      name: 'Acme',
      libraryPath: instance.libraryPath,
      dataFolder: '/Users/john/Library/Application Support/App/instances/lib_acac',
      schemaVersion: 1,
      busy: null,
      queued: 0,
    },
  },
};
export default meta;
type Story = StoryObj<typeof LibraryPageView>;

export const Ready: Story = {};
export const Restarting: Story = {
  args: { instance: { ...instance, status: 'restarting', restarts: 2 }, status: undefined },
};
export const NewerData: Story = {
  args: {
    instance: {
      ...instance,
      status: 'error',
      error: { code: 'instance.newerData', params: { version: 99, supported: 1 } },
    },
    status: undefined,
  },
};
export const Working: Story = {
  args: {
    status: {
      instanceId: instance.id,
      name: 'Acme',
      libraryPath: instance.libraryPath,
      dataFolder: '/x',
      schemaVersion: 1,
      busy: { command: 'sample.apply', progress: { done: 1, total: 3 } },
      queued: 1,
    },
  },
};
