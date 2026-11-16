// Storybook holds the shared components and every warning and dialog state (IMPLEMENTATION.md §2.11). Telemetry is
// off: nothing calls home (PLAN.md §3.19).
import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/renderer/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  async viteFinal(config) {
    const { default: tailwindcss } = await import('@tailwindcss/vite');
    config.plugins = [...(config.plugins ?? []), tailwindcss()];
    config.define = {
      ...config.define,
      __TEST_HOOKS__: 'false',
      __DEV_BUILD__: 'true',
      __APP_VERSION__: '"0.0.0-storybook"',
    };
    return config;
  },
};

export default config;
