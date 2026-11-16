// Main's entry point. Before anything else it checks how it was started: production builds refuse debugging
// switches, and test builds refuse to start without a test root (ADR 0021, TESTING.md §3). Then it points Electron's
// own folders into the data folder (or the test root) before the app is ready, and starts the composition root.
import { nodeEnv } from '@app/adapters';
import { brand } from '@app/brand';
import { dataLayout, dataRoot } from '@app/core';
import { app } from 'electron';
import { startMain } from './composition.ts';
import { readConfig } from './config.ts';
import { listenForOpenUrl } from './electron/open-url.ts';
import { registerSchemes } from './electron/protocols.ts';

const result = readConfig({
  argv: process.argv,
  env: process.env,
  variant: __TEST_HOOKS__ ? 'test-hooks' : 'production',
  devBuild: __DEV_BUILD__,
});

if (!result.ok) {
  process.stderr.write(`${result.message}\n`);
  app.exit(result.exitCode);
} else {
  const config = result.config;
  const env = nodeEnv(
    config.testRoot === undefined
      ? {}
      : {
          testRoot: config.testRoot,
          ...(config.liveToolHome === undefined ? {} : { liveToolHome: config.liveToolHome }),
        },
  );
  const layout = dataLayout(
    dataRoot({
      platform: env.platform,
      paths: env.paths,
      home: env.home,
      localAppData: env.variable('LOCALAPPDATA'),
      xdgConfigHome: env.variable('XDG_CONFIG_HOME'),
      testRoot: env.testRoot,
    }),
    env.paths,
  );

  app.setName(brand.displayName);
  if (process.platform === 'win32') app.setAppUserModelId(brand.appId);
  app.setPath('userData', layout.electron);
  app.setPath('sessionData', layout.electron);
  app.setPath('logs', layout.logs);
  app.setPath('crashDumps', layout.crashDumps);
  if (env.testRoot !== undefined) {
    // The display switches for screenshots come as arguments from the test launcher: Chromium reads them before this
    // code runs. The proxy is also set on the session once the app is ready.
    app.setPath('home', env.home);
    if (config.testProxy) app.commandLine.appendSwitch('proxy-server', config.testProxy);
  }
  registerSchemes();
  listenForOpenUrl();

  const single = config.deviceOperation !== undefined || app.requestSingleInstanceLock();
  if (!single) {
    app.quit();
  } else {
    app
      .whenReady()
      .then(() => startMain({ config, env, layout, outDir: __dirname }))
      .catch((error: unknown) => {
        process.stderr.write(
          `start failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
        app.exit(1);
      });
  }
}
