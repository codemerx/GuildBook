// The Process port on child_process (IMPLEMENTATION.md §2.16): the login shell and the tools' commands. Output is
// capped, and a timeout or an abort ends the program and everything it started.
import type { ProcessOptions, ProcessResult, ProcessRunner } from '@app/core';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { ownProcessGroup, signalTree } from './process-tree.ts';

const maxOutput = 4 * 1024 * 1024;

/**
 * How long the output may keep arriving after the program has ended. A shell profile can start a program that keeps
 * running and keeps the output open; without this limit the call would wait for that program, and a timeout could not end it.
 */
const OUTPUT_GRACE_MS = 1000;

export class NodeProcessRunner implements ProcessRunner {
  run(command: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env === undefined ? undefined : { ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: ownProcessGroup,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let grace: NodeJS.Timeout | undefined;
      const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
      const append = (current: string, text: string) => (current.length < maxOutput ? current + text : current);
      child.stdout.on('data', (chunk: Buffer) => (stdout = append(stdout, decoders.out.write(chunk))));
      child.stderr.on('data', (chunk: Buffer) => (stderr = append(stderr, decoders.err.write(chunk))));
      const onAbort = () => signalTree(child, 'SIGKILL');
      const settle = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        options.signal?.removeEventListener('abort', onAbort);
        // A program the child started may still hold the pipes: stop reading them.
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ code, signal, stdout: stdout + decoders.out.end(), stderr: stderr + decoders.err.end(), timedOut });
      };
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true;
          signalTree(child, 'SIGKILL');
        }, options.timeoutMs);
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        options.signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.on('exit', (code, signal) => {
        // It ended in time: the limit no longer applies. What it printed is read from the pipes, up to the grace time.
        clearTimeout(timer);
        grace = setTimeout(() => settle(code, signal), OUTPUT_GRACE_MS);
      });
      child.on('close', (code, signal) => settle(code, signal));
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin ?? '');
    });
  }
}
