// The client ids that a test says the app carries for github.com and gitlab.com. The real ones are registered before
// the release (packages/brand); until then a test, such as the video of the normal sign-in, supplies one. Main and the
// workers read the same variables, because the workers get main's environment. Production builds compile this to nothing.
export function testClientIdOf(
  env: Readonly<Record<string, string | undefined>>,
  kind: 'github' | 'gitlab',
): string | undefined {
  if (!__TEST_HOOKS__) return undefined;
  const value = env[`APP_TEST_CLIENT_ID_${kind.toUpperCase()}`]?.trim();
  return value ? value : undefined;
}
