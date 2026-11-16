// Secret scanning (PLAN.md §3.15): before every commit and push made in the app, the changed files are searched for
// tokens and private keys. A finding stops the commit or push with a message that names the file; for a false alarm
// (e.g. a skill that shows a sample key) the user confirms and continues.
//
// The rules are adapted from gitleaks' default configuration (https://github.com/gitleaks/gitleaks,
// config/gitleaks.toml): the ones with a fixed prefix or shape, which rarely fire on ordinary text. gitleaks' generic
// "api key near a keyword" rules are left out, because skills explain such keys in prose. gitleaks' licence:
//
//   MIT License
//
//   Copyright (c) 2019 Zachary Rice
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
//   the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
//   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
//   IN THE SOFTWARE.

export interface SecretRule {
  /** gitleaks' rule id; the renderer names the kind of secret from it. */
  readonly id: string;
  readonly pattern: RegExp;
}

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private-key',
    pattern: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----/,
  },
  { id: 'aws-access-token', pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/ },
  { id: 'github-pat', pattern: /\bghp_[0-9a-zA-Z]{36}\b/ },
  { id: 'github-fine-grained-pat', pattern: /\bgithub_pat_\w{82}\b/ },
  { id: 'github-oauth', pattern: /\bgho_[0-9a-zA-Z]{36}\b/ },
  { id: 'github-app-token', pattern: /\b(?:ghu|ghs)_[0-9a-zA-Z]{36}\b/ },
  { id: 'github-refresh-token', pattern: /\bghr_[0-9a-zA-Z]{36}\b/ },
  { id: 'gitlab-pat', pattern: /\bglpat-[\w-]{20}\b/ },
  { id: 'gitlab-deploy-token', pattern: /\bgldt-[0-9a-zA-Z_-]{20}\b/ },
  { id: 'slack-bot-token', pattern: /\bxoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/ },
  { id: 'slack-user-token', pattern: /\bxox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}/ },
  { id: 'slack-webhook-url', pattern: /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/ },
  { id: 'stripe-access-token', pattern: /\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}\b/ },
  { id: 'gcp-api-key', pattern: /\bAIza[\w-]{35}\b/ },
  {
    id: 'openai-api-key',
    pattern:
      /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{58,74}T3BlbkFJ[A-Za-z0-9_-]{58,74}|[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})\b/,
  },
  { id: 'anthropic-api-key', pattern: /\bsk-ant-(?:api03|admin01)-[a-zA-Z0-9_-]{93}AA\b/ },
  { id: 'npm-access-token', pattern: /\bnpm_[a-zA-Z0-9]{36}\b/ },
  { id: 'pypi-upload-token', pattern: /\bpypi-AgEIcHlwaS5vcmc[\w-]{50,1000}/ },
  { id: 'huggingface-access-token', pattern: /\bhf_[a-zA-Z]{34}\b/ },
  { id: 'sendgrid-api-token', pattern: /\bSG\.[a-zA-Z0-9=_.-]{66}\b/ },
  {
    id: 'jwt',
    pattern: /\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/\\_-]{17,}\.(?:[a-zA-Z0-9/\\_-]{10,}={0,2})?/,
  },
];

/** Files larger than this aren't scanned: secrets live in text files, and a large file has its own check. */
export const SECRET_SCAN_MAX_BYTES = 1024 * 1024;

export interface SecretFinding {
  /** The library path. */
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  readonly rule: string;
  /** The commit it was found in, for a push; null for a commit's files. */
  readonly commit: string | null;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/** Whether bytes look like a binary file: git's rule, a NUL byte in the first 8,000 bytes. */
export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/** The secrets in one file; one finding per rule and line. Binary and very large files are skipped. */
export function scanSecrets(path: string, bytes: Uint8Array, commit: string | null = null): SecretFinding[] {
  if (bytes.length > SECRET_SCAN_MAX_BYTES || isBinary(bytes)) return [];
  const text = decoder.decode(bytes);
  const findings: SecretFinding[] = [];
  for (const rule of SECRET_RULES) {
    const global = new RegExp(rule.pattern.source, 'g');
    const lines = new Set<number>();
    for (const match of text.matchAll(global)) {
      const line = text.slice(0, match.index).split('\n').length;
      if (lines.has(line)) continue;
      lines.add(line);
      findings.push({ path, line, rule: rule.id, commit });
    }
  }
  return findings.sort((a, b) => a.line - b.line || (a.rule < b.rule ? -1 : 1));
}
