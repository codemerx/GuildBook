// Test-only samples (IMPLEMENTATION.md §1, Step 1): mechanisms that no feature uses yet are proven by these, so the
// crash suite and the reconciler invariants run from the start (TESTING.md §9). Production code never imports this
// entry point; test builds use it through their test hooks, and the packaging check looks for SAMPLES_MARKER in
// production bundles (A1.6).
export const SAMPLES_MARKER = 'core-samples:only-in-test-builds';

export * from './armed-faults.ts';
export * from './sample-device-operation.ts';
export * from './sample-operation.ts';
export * from './sample-reconciler.ts';
export * from './seeded-random.ts';
