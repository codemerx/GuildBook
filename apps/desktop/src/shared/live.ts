// The live exception (ADR 0033): test builds may be told the real home folder of one tool, where `aisstest-*` entries
// may go. Main and the workers read the same variable, because the workers get main's environment. Production builds
// compile this to nothing, and a test root is required.
export const LIVE_TOOL_HOME_VARIABLE = 'APP_TEST_LIVE_TOOL_HOME';

export function liveToolHomeOf(
  env: Readonly<Record<string, string | undefined>>,
  testRoot: string | undefined,
): string | undefined {
  if (!__TEST_HOOKS__ || testRoot === undefined) return undefined;
  const value = env[LIVE_TOOL_HOME_VARIABLE]?.trim();
  return value ? value : undefined;
}
