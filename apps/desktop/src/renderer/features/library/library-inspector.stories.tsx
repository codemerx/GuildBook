import type { Meta, StoryObj } from '@storybook/react-vite';
import { LibraryInspectorView } from './library-inspector-page.tsx';
import { acmeInstance, invalidSnapshot, loadingSnapshot, validSnapshot } from './library-inspector.fixtures.ts';

const meta: Meta<typeof LibraryInspectorView> = {
  title: 'Library/LibraryInspector',
  component: LibraryInspectorView,
  args: { instance: acmeInstance, snapshot: validSnapshot },
};
export default meta;
type Story = StoryObj<typeof LibraryInspectorView>;

export const Valid: Story = {};
export const WithIssues: Story = { args: { snapshot: invalidSnapshot } };
export const Loading: Story = { args: { snapshot: loadingSnapshot } };
export const Empty: Story = {
  args: { snapshot: { ...validSnapshot, skills: [], tags: [], instructions: null } },
};
