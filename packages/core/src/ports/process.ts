// Programs the app starts besides git: the login shell, and the tools' list and version commands. Tests script them
// (IMPLEMENTATION.md §2.16).
import type { AbsPath } from '../shared/brand.ts';

export interface ProcessResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ProcessOptions {
  readonly cwd?: AbsPath;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string;
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], options?: ProcessOptions): Promise<ProcessResult>;
}
