// What went wrong, from git's own messages (IMPLEMENTATION.md §2.9). Commands run with LC_ALL=C, so the messages are
// git's English ones. Failures become AppErrors; outcomes the user decides about (conflicts, "would be overwritten",
// a rejected push) are read by the operations themselves.
import { AppError, type PushRejection } from '@app/core';
import type { ErrorCode } from '@app/schemas';

const auth =
  /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Permission denied \((publickey|keyboard-interactive)|HTTP Basic: Access denied|Invalid username or (password|token)|The requested URL returned error: 401/i;
const notFound =
  /Repository not found|repository '.*' not found|The requested URL returned error: 404|does not appear to be a git repository|The project you were looking for could not be found/i;
/** The server knows who it is, but refuses to let them write: a read-only key or token (PLAN.md §3.11). */
const forbidden =
  /The requested URL returned error: 403|has been marked as read only|deploy key does not have write access|You are not allowed to push code to this project|Permission to \S+ denied to|Write access to repository not granted|write access to this repository is not granted/i;
const certificate =
  /SSL certificate problem|certificate verify failed|unable to get local issuer|self[- ]signed certificate|server certificate verification failed|no alternative certificate subject name|Host key verification failed|SSL_ERROR|schannel: .*certificate/i;
const offline =
  /Could not resolve host|Could not resolve hostname|Connection refused|Failed to connect|Network is unreachable|Connection timed out|Operation timed out|Couldn't connect to server|Connection reset by peer|No route to host|connect to host .* port \d+:|Operation too slow|Timeout, server .* not responding|timed out during banner exchange|Connection closed by remote host|kex_exchange_identification/i;
const busy = /Unable to create '.*index\.lock': File exists|Another git process seems to be running/i;
const notARepository = /not a git repository/i;

/** The failure a command's stderr describes, or undefined when it's none of the known ones. */
export function classifyFailure(stderr: string): ErrorCode | undefined {
  if (busy.test(stderr)) return 'git.busy';
  if (certificate.test(stderr)) return 'git.certificate';
  if (auth.test(stderr)) return 'git.authFailed';
  if (forbidden.test(stderr)) return 'git.forbidden';
  if (notFound.test(stderr)) return 'git.notFound';
  if (offline.test(stderr)) return 'git.offline';
  if (notARepository.test(stderr)) return 'git.notARepository';
  return undefined;
}

/** git's first `fatal:` or `error:` line, for the plain message of an unknown failure. */
export function firstError(stderr: string): string {
  const line = stderr.split('\n').find((l) => /^(fatal|error): /.test(l));
  return (line ?? stderr.split('\n').find((l) => l.trim() !== '') ?? '').replace(/^(fatal|error): /, '').trim();
}

export function failure(stderr: string, exitCode: number): AppError {
  const code = classifyFailure(stderr);
  if (code) return new AppError(code, {});
  return new AppError('git.failed', { message: firstError(stderr).slice(0, 300), exitCode });
}

/**
 * The files git lists after "… would be overwritten by merge/checkout:" (local changes or untracked files), each on its
 * own line indented with a tab. Empty when the message isn't there.
 */
export function wouldBeOverwritten(stderr: string): string[] {
  const files: string[] = [];
  const lines = stderr.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/would be (overwritten|removed) by (merge|checkout|switch|reset|revert|cherry-pick)/.test(lines[i] ?? ''))
      continue;
    for (let j = i + 1; j < lines.length && (lines[j] ?? '').startsWith('\t'); j++) {
      const file = (lines[j] ?? '').trim();
      if (file && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

export interface Rejection {
  readonly reason: PushRejection;
  readonly host: 'github' | 'gitlab' | null;
  readonly remoteMessage: string;
}

/** GitHub's rule "Require signed commits" and GitLab's push rule "Reject unsigned commits". */
const unsigned = /Commits must have verified signatures|Commit must be signed|unsigned commit/i;
const githubProtected = /GH006: Protected branch update failed|GH013: Repository rule violations found/;
const gitlabProtected = /GitLab: You are not allowed to (force )?push code to (a )?protected branch/;
const genericProtected = /protected branch/i;

/** The server's own lines of a push (`remote: …`), without the prefix and the empty lines. */
export function remoteLines(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('remote:'))
    .map((line) => line.replace(/^remote:\s?/, '').trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n');
}

/** Why a push's ref was rejected: its porcelain summary (`[rejected] (fetch first)`) and the server's lines. */
export function classifyRejection(summary: string, stderr: string): Rejection {
  const remoteMessage = remoteLines(stderr);
  if (/\[rejected\].*\((fetch first|non-fast-forward|stale info)\)/.test(summary)) {
    return { reason: 'nonFastForward', host: null, remoteMessage };
  }
  if (unsigned.test(stderr)) {
    return {
      reason: 'unsigned',
      host: /GH0\d\d/.test(stderr) ? 'github' : /GitLab/.test(stderr) ? 'gitlab' : null,
      remoteMessage,
    };
  }
  if (githubProtected.test(stderr)) return { reason: 'protected', host: 'github', remoteMessage };
  if (gitlabProtected.test(stderr)) return { reason: 'protected', host: 'gitlab', remoteMessage };
  if (genericProtected.test(stderr) || genericProtected.test(summary)) {
    return { reason: 'protected', host: null, remoteMessage };
  }
  return { reason: 'other', host: null, remoteMessage };
}
