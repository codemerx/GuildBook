import { RpcError } from '@app/ipc';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AddTestLibraryForm } from './add-test-library-page.tsx';

const meta: Meta<typeof AddTestLibraryForm> = {
  title: 'Test library/AddTestLibraryForm',
  component: AddTestLibraryForm,
  args: {
    home: '/Users/john',
    onChooseFolder: () => Promise.resolve('/Users/john/libraries/acme'),
    onSubmit: () => {},
    onCancel: () => {},
    submitError: null,
  },
};
export default meta;
type Story = StoryObj<typeof AddTestLibraryForm>;

export const Blank: Story = {};
export const NameInUse: Story = { args: { submitError: new RpcError('testLibrary.alreadyAdded', { name: 'Acme' }) } };
