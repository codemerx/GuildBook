import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusBadge } from './status-badge.tsx';

const meta: Meta<typeof StatusBadge> = { title: 'UI/StatusBadge', component: StatusBadge };
export default meta;
type Story = StoryObj<typeof StatusBadge>;

export const Ready: Story = { args: { status: 'ready' } };
export const Starting: Story = { args: { status: 'starting' } };
export const Restarting: Story = { args: { status: 'restarting' } };
export const Error: Story = { args: { status: 'error' } };
export const SettingUp: Story = { args: { status: 'setting-up' } };
export const Removing: Story = { args: { status: 'removing' } };
