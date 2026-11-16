// The login-shell environment (PLAN.md §3.4 "Moved tool folders"): an app started from the Dock or Start menu doesn't
// see variables set in a shell profile, so main reads them once from the user's login shell, as VS Code does. It keeps
// only PATH, the catalog's home_env variables, proxy settings and SSH_AUTH_SOCK, and discards the rest (A1.15).

export const SHELL_ENV_MARKER = '__LOGIN_SHELL_ENV_START__';

export const PROXY_VARIABLES = [
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
] as const;

/** The command that prints the login shell's environment after a marker, NUL-separated (macOS and Linux). */
export function loginShellCommand(shell: string): { command: string; args: string[] } {
  return { command: shell, args: ['-i', '-l', '-c', `printf '%s' '${SHELL_ENV_MARKER}'; command env -0`] };
}

/** Parses `env -0` output that follows the marker. Profile scripts may print anything before it. */
export function parseShellEnv(stdout: string): Record<string, string> {
  const start = stdout.lastIndexOf(SHELL_ENV_MARKER);
  if (start < 0) return {};
  const variables: Record<string, string> = {};
  for (const entry of stdout.slice(start + SHELL_ENV_MARKER.length).split('\0')) {
    const equals = entry.indexOf('=');
    if (equals <= 0) continue;
    const name = entry.slice(0, equals);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    variables[name] = entry.slice(equals + 1);
  }
  return variables;
}

/** Keeps only the variables the app needs (PLAN.md §3.4). */
export function keepAllowedVariables(
  variables: Readonly<Record<string, string>>,
  homeEnvVariables: readonly string[],
): Record<string, string> {
  const allowed = new Set<string>(['PATH', 'SSH_AUTH_SOCK', ...PROXY_VARIABLES, ...homeEnvVariables]);
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(variables)) {
    if (allowed.has(name)) kept[name] = value;
  }
  return kept;
}
