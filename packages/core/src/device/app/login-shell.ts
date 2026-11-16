// Reads the login shell's environment once at start (PLAN.md §3.4), through the Process port so tests script it.
// Off in test mode (TESTING.md §3); never on Windows, where apps get the user's environment directly. A shell that
// fails or times out reports nothing: its output may be cut short.
import type { Logger } from '../../ports/logger.ts';
import type { ProcessRunner } from '../../ports/process.ts';
import { keepAllowedVariables, loginShellCommand, parseShellEnv } from '../domain/shell-env.ts';

export async function readLoginShellEnv(deps: {
  process: ProcessRunner;
  shell: string;
  homeEnvVariables: readonly string[];
  logger: Logger;
  timeoutMs?: number;
}): Promise<Record<string, string>> {
  const { command, args } = loginShellCommand(deps.shell);
  try {
    const result = await deps.process.run(command, args, { timeoutMs: deps.timeoutMs ?? 10_000 });
    if (result.timedOut || result.code !== 0) {
      deps.logger.warn('login shell did not report its environment', { code: result.code, timedOut: result.timedOut });
      return {};
    }
    const kept = keepAllowedVariables(parseShellEnv(result.stdout), deps.homeEnvVariables);
    deps.logger.info('login shell environment read', { variables: Object.keys(kept).sort() });
    return kept;
  } catch (error) {
    deps.logger.warn('login shell could not be started', { error: String(error) });
    return {};
  }
}
