// Everything main adds in test-hooks builds. Main imports this module only inside `if (__TEST_HOOKS__)`, so production
// builds contain none of it (A1.6).
export { ArmedFaults, sampleDeviceOperation, SeededRandom, seedFrom } from '@app/core/samples';
export { TEST_CLOCK_START, workerTestApi } from '@app/ipc/test-api';
export { RecordingOs } from '../os/recording.ts';
export { installTestApi, testApiHandlers } from './test-api.ts';
export { ScriptedTools } from './scripted-tools.ts';
