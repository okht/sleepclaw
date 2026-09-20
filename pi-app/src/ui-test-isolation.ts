import { isAbsolute, join, parse, resolve } from 'node:path';

/** UI automation must explicitly opt into its own home before Electron takes its lock. */
export function uiTestUserDataPath(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env.SLEEPCLAW_UI_TEST !== '1') return undefined;
  const home = env.SLEEPCLAW_HOME;
  if (!home || !home.trim() || home !== home.trim() || home.includes('\0') || !isAbsolute(home)) throw new Error('UI_TEST_REQUIRES_ABSOLUTE_HOME');
  const normalized = resolve(home);
  if (normalized === parse(normalized).root) throw new Error('UI_TEST_REQUIRES_ABSOLUTE_HOME');
  return join(normalized, 'electron-test-user-data');
}
