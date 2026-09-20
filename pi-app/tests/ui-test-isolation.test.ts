import assert from 'node:assert/strict';
import test from 'node:test';
import { join, parse, resolve } from 'node:path';
import { uiTestUserDataPath } from '../src/ui-test-isolation.js';

test('normal startup keeps the existing Electron data directory even with a custom domain home', () => {
  for (const flag of [undefined, '', '0', 'true', '01']) {
    assert.equal(uiTestUserDataPath({ SLEEPCLAW_UI_TEST: flag, SLEEPCLAW_HOME: resolve('synthetic-home') }), undefined);
  }
  assert.equal(uiTestUserDataPath({}), undefined);
});

test('explicit UI test mode places all Electron state under its selected test home', () => {
  const home = resolve('synthetic-ui-home');
  assert.equal(uiTestUserDataPath({ SLEEPCLAW_UI_TEST: '1', SLEEPCLAW_HOME: home }), join(home, 'electron-test-user-data'));
});

test('UI automation rejects absent, relative, root or invalid homes instead of using production storage', () => {
  for (const home of [undefined, '', ' ', './relative-test', parse(resolve('.')).root, `${resolve('synthetic')}\0`, ` ${resolve('synthetic')}`]) {
    assert.throws(() => uiTestUserDataPath({ SLEEPCLAW_UI_TEST: '1', SLEEPCLAW_HOME: home }), { message: 'UI_TEST_REQUIRES_ABSOLUTE_HOME' });
  }
});

test('independent explicit test homes do not share a single-instance lock directory', () => {
  const first = uiTestUserDataPath({ SLEEPCLAW_UI_TEST: '1', SLEEPCLAW_HOME: resolve('first-ui-test') });
  const second = uiTestUserDataPath({ SLEEPCLAW_UI_TEST: '1', SLEEPCLAW_HOME: resolve('second-ui-test') });
  assert.notEqual(first, second);
});
