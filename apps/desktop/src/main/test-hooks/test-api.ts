// The test API in main (TESTING.md §6, IMPLEMENTATION.md §2.16). Only test-hooks builds import this module; Playwright
// and the drive tool reach it through `electronApplication.evaluate`, and main forwards instance calls to workers.
import { tailLines, treeOf } from '@app/adapters';
import { AppError, type DeviceOperationRunner, type DeviceRegistry } from '@app/core';
import type { ArmedFaults } from '@app/core/samples';
import { type Client, type Handlers, invokeLocal } from '@app/ipc';
import { TEST_API_MARKER, testApi, type TestApi, type WorkerTestApi } from '@app/ipc/test-api';
import path from 'node:path';
import type { InstanceManager } from '../instances.ts';
import type { RecordingOs } from '../os/recording.ts';
import type { WorkerSupervisor } from '../supervisor.ts';

export interface TestApiDeps {
  readonly testRoot: string;
  readonly mainLog: string;
  readonly instances: InstanceManager;
  readonly supervisor: WorkerSupervisor;
  readonly registry: DeviceRegistry;
  readonly deviceOperations: DeviceOperationRunner;
  readonly os: RecordingOs;
  readonly faults: ArmedFaults;
  readonly workerTest: (instanceId: string) => Client<WorkerTestApi> | undefined;
  readonly locks: () => unknown;
  readonly clock: { now(): number; advance(ms: number): number; setTime(time: number): number };
  readonly setOnline: (online: boolean) => void;
  readonly power: (state: 'suspend' | 'resume') => void;
  readonly focus: (focused: boolean) => void;
  readonly wait: (ms: number) => Promise<void>;
  /** One request from main, through the session (and so through the test proxy). */
  readonly fetch: (url: string) => Promise<number>;
  readonly trustCertificate: (pem: string) => Promise<void>;
  readonly simulateKeyring: (available: boolean) => void;
  readonly scriptToolCommand: (program: string, stdout: string, code: number) => void;
  readonly setups: () => unknown;
  /** Delivers an app link as the OS would: through the second-instance event (Step 15). */
  readonly openLink: (url: string) => void;
  /** How many windows are open: none after a start through the login item (A15.8). */
  readonly windows: () => number;
  /** The device API's commands, as the renderer calls them: worlds join a library through the app's own flow. */
  readonly device: (name: string, input: unknown) => Promise<unknown>;
}

const settling = new Set(['starting', 'restarting']);

export function testApiHandlers(deps: TestApiDeps): Handlers<TestApi> {
  const instance = (ref: string) => {
    const record = deps.instances.find(ref);
    if (!record) throw new AppError('instance.notFound', { ref });
    return record;
  };
  const inTestRoot = (p: string) => {
    const full = path.resolve(deps.testRoot, p);
    if (full !== deps.testRoot && !full.startsWith(deps.testRoot + path.sep)) {
      throw new AppError('fs.outsideAllowedRoots', { path: p });
    }
    return full;
  };

  async function waitForIdle(ref: string | undefined, timeoutMs: number): Promise<void> {
    const deadline = deps.clock.now() + timeoutMs;
    // An instance being removed has no idle to wait for: its worker stops as part of the removal.
    const ids = ref
      ? [instance(ref).id]
      : deps.instances
          .records()
          .filter((r) => r.status !== 'removing')
          .map((r) => r.id);
    // First the workers that are still starting, then each worker's own queue.
    for (;;) {
      const busy = ids.filter((id) => settling.has(deps.supervisor.get(id)?.state ?? 'stopped'));
      if (busy.length === 0) break;
      if (deps.clock.now() > deadline) throw new AppError('rpc.timeout', { waitingFor: busy.join(',') });
      await deps.wait(25);
    }
    for (const id of ids) {
      if (deps.supervisor.get(id)?.state !== 'running') continue;
      try {
        await deps.workerTest(id)?.command.waitForIdle({});
      } catch (error) {
        // A worker that stopped meanwhile (removed, or killed by a test) has nothing left to do.
        if ((error as { code?: unknown }).code !== 'rpc.disconnected') throw error;
      }
    }
  }

  return {
    queries: {
      device: () =>
        ({
          file: deps.registry.usable ? deps.registry.file : null,
          state: deps.registry.state ?? null,
          instances: deps.instances.views(),
          workers: deps.supervisor.list().map((w) => ({
            instanceId: w.instanceId,
            state: w.state,
            pid: w.worker?.pid ?? null,
            generation: w.generation,
            restarts: w.restarts,
          })),
          locks: deps.locks(),
          setups: deps.setups(),
          windows: deps.windows(),
        }) as never,
      dump: async ({ instance: ref }) => {
        const record = instance(ref);
        const worker = deps.workerTest(record.id);
        return { record, worker: worker ? await worker.query.dump({}) : null };
      },
      tree: async ({ path: p }) => treeOf(inTestRoot(p)),
      git: async ({ instance: ref }) => {
        const record = ref === undefined ? deps.instances.views()[0] : instance(ref);
        if (!record) throw new AppError('instance.notFound', {});
        const worker = deps.workerTest(record.id);
        if (!worker) throw new AppError('instance.notFound', { instance: record.id });
        return worker.query.git({});
      },
      recorded: () => {
        const r = deps.os.recorded;
        return {
          ...structuredClone(r),
          tray: {
            tooltip: r.tray.tooltip,
            count: r.tray.count,
            items: r.tray.items.map((i) => ({ label: i.label, enabled: i.enabled, kind: i.kind })),
          },
        };
      },
      logs: async ({ tail }) => tailLines(deps.mainLog, tail ?? 200),
      marker: () => TEST_API_MARKER,
    },
    commands: {
      waitForIdle: async ({ instance: ref, timeoutMs }) => {
        await waitForIdle(ref, timeoutMs ?? 60_000);
        return {};
      },
      clockAdvance: ({ ms }) => ({ now: deps.clock.advance(ms) }),
      clockSet: ({ time }) => ({ now: deps.clock.setTime(time) }),
      networkOnline: ({ online }) => {
        deps.setOnline(online);
        return {};
      },
      powerSleep: () => {
        deps.power('suspend');
        return {};
      },
      powerWake: () => {
        deps.power('resume');
        return {};
      },
      windowFocus: () => {
        deps.focus(true);
        return {};
      },
      windowBlur: () => {
        deps.focus(false);
        return {};
      },
      dialogsAnswer: ({ answers }) => {
        deps.os.answer(...answers.map((a) => (a.path === null ? null : inTestRoot(a.path))));
        return {};
      },
      faultsArm: async ({ instance: ref, point, action, delayMs, skip }) => {
        const options = { ...(delayMs === undefined ? {} : { delayMs }), ...(skip === undefined ? {} : { skip }) };
        if (ref === undefined) {
          deps.faults.arm(point, action, options);
          return {};
        }
        const worker = deps.workerTest(instance(ref).id);
        if (!worker) throw new AppError('instance.notFound', { ref });
        await worker.command.faultsArm({ point, action, ...options });
        return {};
      },
      protocolOpen: ({ url }) => {
        deps.openLink(url);
        return {};
      },
      killWorker: ({ instance: ref }) => {
        deps.supervisor.kill(instance(ref).id);
        return {};
      },
      networkProbe: async ({ url }) => {
        try {
          return { status: await deps.fetch(url), error: null };
        } catch (error) {
          return { status: null, error: String(error) };
        }
      },
      holdLock: async ({ instance: ref, name }) => {
        const worker = deps.workerTest(instance(ref).id);
        if (!worker) throw new AppError('instance.notFound', { ref });
        // Don't wait for it: the lock may be held by another worker until that one exits.
        void worker.command.holdLock({ name }).catch(() => undefined);
        return { held: false };
      },
      trustCertificate: async ({ pem }) => {
        await deps.trustCertificate(pem);
        return {};
      },
      simulateKeyring: ({ available }) => {
        deps.simulateKeyring(available);
        return {};
      },
      scriptToolCommand: ({ program, stdout, code }) => {
        deps.scriptToolCommand(program, stdout, code);
        return {};
      },
      joinLibrary: async ({ url, token, identity, localPrefix }) => {
        type View = {
          defaultFolder: string;
          instanceId: string | null;
          step: string;
          localPrefix: { suggestion: string | null } | null;
        };
        const { setupId } = (await deps.device('startSetup', { url, intent: 'join' })) as { setupId: string };
        const signedIn = (await deps.device('setupSignIn', {
          setupId,
          method: { kind: 'token', token },
          identity,
        })) as View;
        await deps.device('setupCheckFolder', { setupId, path: signedIn.defaultFolder });
        let downloaded = (await deps.device('setupDownload', { setupId })) as View;
        // The git prefix is in use on this device: the local-prefix page (PLAN.md §3.3).
        if (downloaded.step === 'localPrefix') {
          const prefix = localPrefix ?? downloaded.localPrefix?.suggestion ?? '';
          downloaded = (await deps.device('setupChooseLocalPrefix', { setupId, prefix })) as View;
        }
        if (!downloaded.instanceId) throw new AppError('setup.wrongStep', { step: 'download' });
        // The wizard's pages after the download keep their defaults (Step 15): no tools yet, which the worlds enable
        // on their own, and no repos. [Finish] applies the summary's plan.
        // The instance's own worker starts with the handoff: it answers once it read the library.
        await waitForIdle(downloaded.instanceId, 60_000);
        const worker = deps.workerTest(downloaded.instanceId);
        if (!worker) throw new AppError('instance.notFound', { ref: downloaded.instanceId });
        const planHash = await worker.command.setupDefaults({});
        await deps.device('finishSetup', { instanceId: downloaded.instanceId, planHash: planHash.hash });
        return { instanceId: downloaded.instanceId };
      },
      checkAccess: async ({ instance: ref }) => {
        const worker = deps.workerTest(instance(ref).id);
        if (!worker) throw new AppError('instance.notFound', { ref });
        await worker.command.checkAccess({});
        return {};
      },
      enableTools: async ({ instance: ref, tools }) => {
        const worker = deps.workerTest(instance(ref).id);
        if (!worker) throw new AppError('instance.notFound', { ref });
        await worker.command.enableTools({ tools });
        return {};
      },
      arrangePlacement: async ({ instance: ref, repos, roots, edits }) => {
        const worker = deps.workerTest(instance(ref).id);
        if (!worker) throw new AppError('instance.notFound', { ref });
        await worker.command.arrangePlacement({ repos, roots, edits });
        return {};
      },
      runDeviceOperation: async ({ kind, instance: ref }) => {
        const outcome = await deps.deviceOperations.start(
          kind,
          ref === undefined ? {} : { instanceId: instance(ref).id },
        );
        if (outcome.status === 'failed') throw new AppError('operation.failed', { kind, code: outcome.error.code });
        return { operationId: outcome.id, result: outcome.result };
      },
    },
  };
}

/** Installs the test API where Playwright's `evaluate` can reach it. */
export function installTestApi(handlers: Handlers<TestApi>): void {
  const call = (kind: 'query' | 'command', name: string, input: unknown) =>
    invokeLocal(testApi, handlers, kind, name, input);
  (globalThis as { __appTestApi?: typeof call }).__appTestApi = call;
}
