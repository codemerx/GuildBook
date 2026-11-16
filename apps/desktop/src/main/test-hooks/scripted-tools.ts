// The tools' version and list commands in test mode (TESTING.md §3): no real program runs. A test says what a program
// prints; any other program is "not found", as on a computer without the tool.
import type { ProcessOptions, ProcessResult, ProcessRunner } from '@app/core';

export class ScriptedTools implements ProcessRunner {
  readonly #answers = new Map<string, { stdout: string; code: number }>();

  script(program: string, stdout: string, code = 0): void {
    this.#answers.set(program, { stdout, code });
  }

  async run(command: string, _args: readonly string[], _options?: ProcessOptions): Promise<ProcessResult> {
    const answer = this.#answers.get(command);
    if (!answer) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
    return { code: answer.code, signal: null, stdout: answer.stdout, stderr: '', timedOut: false };
  }
}
