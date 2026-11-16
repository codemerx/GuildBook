// An instance's lifecycle (IMPLEMENTATION.md §2.1, §2.6) has two parts:
// - its phase, which survives restarts (setting-up, ready, removing are stored in device.json; pending isn't)
// - its worker's state, which exists only while the app runs
// What the UI shows combines both: pending, setting up, starting, ready, restarting, error, removing.

export type Phase = 'pending' | 'setting-up' | 'ready' | 'removing' | 'removed';
export type WorkerState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';
export type ShownStatus = 'pending' | 'setting-up' | 'starting' | 'ready' | 'restarting' | 'error' | 'removing';

export type PhaseEvent =
  | 'downloadCompleted' // pending → setting-up: the worker created its data folder (Step 4)
  | 'setupFinished' // setting-up → ready: the wizard's [Finish]
  | 'setupCancelled' // pending → removed: nothing was created
  | 'removeRequested' // → removing, recorded before anything is removed
  | 'removeCompleted'; // removing → removed

const phaseTransitions: Readonly<Record<Phase, Partial<Record<PhaseEvent, Phase>>>> = {
  pending: { downloadCompleted: 'setting-up', setupCancelled: 'removed', removeRequested: 'removing' },
  'setting-up': { setupFinished: 'ready', removeRequested: 'removing' },
  ready: { removeRequested: 'removing' },
  removing: { removeCompleted: 'removed' },
  removed: {},
};

/** The next phase, or undefined when the event isn't allowed in this phase. */
export function nextPhase(phase: Phase, event: PhaseEvent): Phase | undefined {
  return phaseTransitions[phase][event];
}

export type WorkerEvent = 'start' | 'ready' | 'lost' | 'failed' | 'stopped';

const workerTransitions: Readonly<Record<WorkerState, Partial<Record<WorkerEvent, WorkerState>>>> = {
  stopped: { start: 'starting' },
  starting: { ready: 'running', lost: 'restarting', failed: 'failed', stopped: 'stopped' },
  running: { lost: 'restarting', failed: 'failed', stopped: 'stopped' },
  restarting: { start: 'restarting', ready: 'running', lost: 'restarting', failed: 'failed', stopped: 'stopped' },
  failed: { start: 'starting', stopped: 'stopped' },
};

export function nextWorkerState(state: WorkerState, event: WorkerEvent): WorkerState | undefined {
  return workerTransitions[state][event];
}

/** What the switcher and the tray show. A removal wins; then a worker problem; then the phase. */
export function shownStatus(phase: Exclude<Phase, 'removed'>, worker: WorkerState): ShownStatus {
  if (phase === 'removing') return 'removing';
  if (worker === 'failed') return 'error';
  if (worker === 'restarting') return 'restarting';
  if (worker === 'starting' || worker === 'stopped') return phase === 'pending' ? 'pending' : 'starting';
  return phase;
}

/** The status device.json keeps for a phase; pending isn't stored, so an interrupted setup leaves no instance. */
export function persistedStatus(phase: Phase): 'setting-up' | 'ready' | 'removing' | undefined {
  return phase === 'setting-up' || phase === 'ready' || phase === 'removing' ? phase : undefined;
}
