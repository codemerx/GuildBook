// Named fault points in the operation runner and in reconciler apply (IMPLEMENTATION.md §2.16, TESTING.md §9.3).
// Production builds pass `noFaults`; test builds can make a point crash the process, throw, hang or wait.
export interface FaultPoints {
  hit(point: string): Promise<void>;
}

export const noFaults: FaultPoints = { hit: () => Promise.resolve() };
