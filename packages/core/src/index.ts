// core: the domain and use cases, pure TypeScript with I/O only through ports (IMPLEMENTATION.md §2.3, ADR 0006).
// Each module is reached only through its index.ts.
export * from './activity/index.ts';
export * from './catalog/index.ts';
export * from './device/index.ts';
export * from './doctor/index.ts';
export * from './engine/index.ts';
export * from './imports/index.ts';
export * from './instructions/index.ts';
export * from './library/index.ts';
export * from './links/index.ts';
export * from './onboarding/index.ts';
export * from './operations/index.ts';
export * from './placement/index.ts';
export * from './prefix/index.ts';
export * from './ports/index.ts';
export * from './projection/index.ts';
export * from './recovery/index.ts';
export * from './relocation/index.ts';
export * from './review/index.ts';
export * from './shared/index.ts';
export * from './sync/index.ts';
