import type { UpdateView } from '@app/ipc';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { UpdateAvailableBannerView, UpdatesCardView } from './updates.tsx';

const base: UpdateView = {
  version: '1.0.0',
  supported: true,
  phase: 'up-to-date',
  available: null,
  dismissed: false,
  lastCheckedAt: '2026-01-15T09:02:00.000Z',
  error: null,
};
const actions = { check: () => {}, download: () => {}, later: () => {} };

const meta: Meta<typeof UpdatesCardView> = {
  title: 'Settings/Updates',
  component: UpdatesCardView,
  args: { view: base, actions },
};
export default meta;
type Story = StoryObj<typeof UpdatesCardView>;

export const UpToDate: Story = {};
export const NotChecked: Story = { args: { view: { ...base, phase: 'idle', lastCheckedAt: null } } };
export const Checking: Story = { args: { view: { ...base, phase: 'checking' } } };
export const Available: Story = { args: { view: { ...base, phase: 'available', available: '1.1.0' } } };
export const Offline: Story = {
  args: { view: { ...base, phase: 'failed', error: { code: 'update.offline', params: {} } } },
};
export const Unsupported: Story = { args: { view: { ...base, supported: false, phase: 'idle' } } };
export const Banner: StoryObj<typeof UpdateAvailableBannerView> = {
  render: () => (
    <UpdateAvailableBannerView view={{ ...base, phase: 'available', available: '1.1.0' }} actions={actions} />
  ),
};
