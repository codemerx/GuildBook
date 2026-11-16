import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettingsPageView } from './settings-page.tsx';

const meta: Meta<typeof SettingsPageView> = {
  title: 'Settings/SettingsPage',
  component: SettingsPageView,
  args: { theme: 'system', version: '0.1.0', certificates: 0, onTheme: () => {} },
};
export default meta;
type Story = StoryObj<typeof SettingsPageView>;

export const Default: Story = {};
export const DarkWithCertificates: Story = { args: { theme: 'dark', certificates: 2 } };
/** Step 16: the Support card with Export diagnostics. */
export const WithSupport: Story = {
  args: {
    diagnostics: {
      home: '/home/john',
      actions: { prepare: async () => ({ id: 'diag_1', text: '', parts: [] }), save: async () => null },
    },
  },
};
/** Step 17: the notification types, one switched off. */
export const WithNotifications: Story = {
  args: { notifications: { off: ['incoming'], doNotDisturb: false }, onNotifications: () => {} },
};
