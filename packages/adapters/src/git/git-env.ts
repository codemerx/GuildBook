// What every git command gets in its environment (IMPLEMENTATION.md §2.9, ADR 0014, ADR 0015): credentials only
// there (never in arguments, URLs or repo config), the proxy and the certificate bundle, and the settings the app
// relies on whatever the user's own git config says. Settings go through GIT_CONFIG_COUNT/KEY/VALUE, which git reads
// like `-c` options: above every config file.
import type { Env, GitAuth, GitIdentity, GitSigning, Platform } from '@app/core';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface GitNetwork {
  /** e.g. `http://proxy.acme.test:3128`, as main resolved it for this URL. */
  readonly proxy: string | null;
  /** A PEM file: the OS trust store plus the "extra certificates" setting. */
  readonly caBundle: string | null;
}

/** The settings every command gets, so the user's own choices can't change what the app reads or waits for. */
export function pinnedConfig(platform: Platform): Array<[string, string]> {
  return [
    // Never ask a credential helper configured on this computer (osxkeychain, manager, …).
    ['credential.helper', ''],
    ['color.ui', 'false'],
    ['core.pager', 'cat'],
    ['log.showSignature', 'false'],
    ['log.follow', 'false'],
    ['submodule.recurse', 'false'],
    // Background maintenance would take the repo's locks at moments no test or user can predict.
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ...(platform === 'win32' ? ([['core.longpaths', 'true']] as Array<[string, string]>) : []),
  ];
}

/**
 * How long a command that talks to a server may get (almost) no data before it ends with an error. Without a limit, a
 * connection that died while a laptop slept, or a server that stops answering, holds the command for ever: git has no
 * time limit of its own.
 */
export const NETWORK_STALL_SECONDS = 120;

/** HTTPS: curl ends the transfer when fewer than 1,000 bytes a second arrive for this long (the wait for a reply too). */
export function stallConfig(seconds: number): Array<[string, string]> {
  return [
    ['http.lowSpeedLimit', '1000'],
    ['http.lowSpeedTime', String(seconds)],
  ];
}

/** SSH: a connect and banner time limit, and keepalives that end a connection the other side no longer answers. */
export function stallSshOptions(seconds: number): string[] {
  const interval = Math.max(1, Math.floor(seconds / 4));
  return [
    '-o',
    `ConnectTimeout=${Math.min(seconds, 30)}`,
    '-o',
    `ServerAliveInterval=${interval}`,
    '-o',
    'ServerAliveCountMax=4',
  ];
}

/**
 * A user's own `url.<base>.insteadOf` and `pushInsteadOf` rewrite an address before git uses it; a developer who wants
 * every https address to use ssh has one. The app's commands must go to the address the library has, with the
 * credentials that belong to it. Git uses the longest rule that matches, so a rule for this very address, rewriting it
 * to itself, wins over any shorter rule of the user's.
 */
export function addressPins(url: string): Array<[string, string]> {
  return [
    [`url.${url}.insteadOf`, url],
    [`url.${url}.pushInsteadOf`, url],
  ];
}

/** The commit's people and dates (IMPLEMENTATION.md §2.12): dates come from the app's clock. */
export interface CommitIdentity {
  readonly identity: GitIdentity;
  /** Epoch milliseconds. */
  readonly now: number;
  /** A rebase gets only the committer, so the commits it replays keep their authors and author dates. */
  readonly committerOnly?: boolean;
}

export function gitDate(ms: number): string {
  return `@${Math.floor(ms / 1000)} +0000`;
}

export function identityEnv(commit: CommitIdentity): Record<string, string> {
  const date = gitDate(commit.now);
  const committer = {
    GIT_COMMITTER_NAME: commit.identity.name,
    GIT_COMMITTER_EMAIL: commit.identity.email,
    GIT_COMMITTER_DATE: date,
  };
  if (commit.committerOnly) return committer;
  return {
    GIT_AUTHOR_NAME: commit.identity.name,
    GIT_AUTHOR_EMAIL: commit.identity.email,
    GIT_AUTHOR_DATE: date,
    ...committer,
  };
}

/** Quotes for the POSIX shell that git runs GIT_SSH_COMMAND with (also Git for Windows' sh). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** GitHub takes a token as the password of `x-access-token`, GitLab OAuth tokens as the password of `oauth2`. */
export function basicAuthHeader(user: string, token: string): string {
  return `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
}

export interface CommandEnvOptions {
  readonly platform: Platform;
  readonly auth: GitAuth;
  readonly network: GitNetwork;
  /** Where an app-kept key is written for one command (the instance's data folder's tmp/). */
  readonly keyDir: string;
  /** ssh options the device needs; test mode passes its own config and known-hosts file (TESTING.md §3). */
  readonly sshOptions: readonly string[];
  /** Settings this one command needs besides the pinned ones. */
  readonly config?: ReadonlyArray<readonly [string, string]>;
  /** Signs the commits this command makes with git's SSH signing (PLAN.md §3.10 "Signing"). */
  readonly signing?: GitSigning | null;
  /** A command that talks to a server: seconds without data before it ends with an error (NETWORK_STALL_SECONDS). */
  readonly stallSeconds?: number | undefined;
  /** The address this command talks to: the user's own address rewrite rules do not apply to it (addressPins). */
  readonly url?: string | undefined;
}

export interface CommandEnv {
  readonly env: Record<string, string>;
  /** The app-kept key's temporary file, while the command runs. */
  readonly keyFile: string | null;
  /** The app-kept signing key's temporary file, while the command runs. */
  readonly signingFile: string | null;
  /** Removes the key file, if one was written. Always called when the command ends. */
  cleanup(): Promise<void>;
}

export const KEY_FILE_PREFIX = 'ssh-key-';

export async function commandEnv(options: CommandEnvOptions): Promise<CommandEnv> {
  const config: Array<[string, string]> = [
    ...pinnedConfig(options.platform),
    ...(options.stallSeconds === undefined ? [] : stallConfig(options.stallSeconds)),
    ...(options.url === undefined ? [] : addressPins(options.url)),
    ...(options.config ?? []),
  ].map(([key, value]) => [key, value]);
  const env: Record<string, string> = {
    LC_ALL: 'C',
    LANGUAGE: '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    // No editor: a merge or a continued rebase never waits for one, whatever core.editor says.
    GIT_EDITOR: ':',
    GIT_SEQUENCE_EDITOR: ':',
    GIT_MERGE_AUTOEDIT: 'no',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    // Reading commands (status) don't take the index lock, so they never get in another git program's way.
    GIT_OPTIONAL_LOCKS: '0',
    HTTPS_PROXY: '',
    https_proxy: '',
    HTTP_PROXY: '',
    http_proxy: '',
    ALL_PROXY: '',
    all_proxy: '',
  };
  if (options.network.proxy) config.push(['http.proxy', options.network.proxy]);
  if (options.network.caBundle) {
    // The variable, not http.sslCAInfo: dugite sets GIT_SSL_CAINFO to its own bundle on Linux, and it wins (ADR 0015).
    env.GIT_SSL_CAINFO = options.network.caBundle;
    if (options.platform === 'win32') config.push(['http.sslBackend', 'openssl']);
  }

  const writeKey = async (key: string): Promise<string> => {
    await mkdir(options.keyDir, { recursive: true, mode: 0o700 });
    const file = path.join(options.keyDir, `${KEY_FILE_PREFIX}${randomBytes(8).toString('hex')}`);
    await writeFile(file, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600 });
    return file;
  };
  let keyFile: string | null = null;
  let signingFile: string | null = null;
  if (options.signing) {
    // git's SSH signing runs ssh-keygen -Y sign with this file: a private key, or a public key whose private part the
    // user's agent holds. The user's own gpg settings stay for commits the app doesn't have to sign.
    if (options.signing.kind === 'key') signingFile = await writeKey(options.signing.privateKey);
    const signingKey = options.signing.kind === 'key' ? (signingFile ?? '') : options.signing.path;
    config.push(['gpg.format', 'ssh'], ['user.signingKey', signingKey], ['commit.gpgSign', 'true']);
  }
  // ssh uses the first value it gets for an option, so the device's own options (test mode's) come first.
  const ssh = [
    'ssh',
    '-o',
    'BatchMode=yes',
    ...options.sshOptions,
    ...(options.stallSeconds === undefined ? [] : stallSshOptions(options.stallSeconds)),
  ];
  switch (options.auth.kind) {
    case 'https-header': {
      const origin = options.auth.origin.replace(/\/+$/, '');
      config.push([`http.${origin}/.extraHeader`, options.auth.header]);
      env.GIT_SSH_COMMAND = ssh.map(shellQuote).join(' ');
      break;
    }
    case 'ssh-key': {
      keyFile = await writeKey(options.auth.privateKey);
      env.GIT_SSH_COMMAND = [...ssh, '-i', keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none']
        .map(shellQuote)
        .join(' ');
      break;
    }
    case 'ssh-agent':
    case 'none':
      // The user's agent and SSH config decide which keys (ADR 0014).
      env.GIT_SSH_COMMAND = ssh.map(shellQuote).join(' ');
      break;
  }

  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  const written = [keyFile, signingFile].filter((file): file is string => file !== null);
  return {
    env,
    keyFile,
    signingFile,
    cleanup: async () => {
      await Promise.all(written.map((file) => rm(file, { force: true })));
    },
  };
}

/** At start, removes key files a crash left behind (IMPLEMENTATION.md §2.9). */
export async function sweepLeftoverKeys(keyDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(keyDir);
  } catch {
    return 0;
  }
  const keys = names.filter((name) => name.startsWith(KEY_FILE_PREFIX));
  await Promise.all(keys.map((name) => rm(path.join(keyDir, name), { force: true })));
  return keys.length;
}

/**
 * The device's variables git may see (beyond the Environment's base ones): where its global config is, the temporary
 * folder, and what Windows needs. Test mode's GIT_CONFIG_GLOBAL points into the test root (TESTING.md §3).
 */
export const GIT_VARIABLES = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
] as const;

/** The base environment for git, from the Environment port: HOME (the test root's in test mode) and allowed variables. */
export function gitBaseEnv(env: Env): Record<string, string> {
  const base: Record<string, string> = { HOME: env.home };
  if (env.platform === 'win32') base.USERPROFILE = env.home;
  for (const name of ['PATH', 'LANG', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', ...GIT_VARIABLES]) {
    const value = env.variable(name);
    if (value !== undefined) base[name] = value;
  }
  // Test mode: ssh gets the test root's own config and known hosts, and never the developer's agent (TESTING.md §3).
  if (env.testRoot !== undefined) delete base.SSH_AUTH_SOCK;
  return base;
}

/** Test mode's ssh options: ssh looks up the real home folder in the user database, whatever HOME says. */
export function testSshOptions(env: Env): string[] {
  if (env.testRoot === undefined) return [];
  const ssh = env.paths.join(env.testRoot, 'ssh');
  return ['-F', env.paths.join(ssh, 'config'), '-o', `UserKnownHostsFile=${env.paths.join(ssh, 'known_hosts')}`];
}
