import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { planSquirrelStartup, runSquirrelStartup } from '../src/squirrel-startup.js';

const executable = 'C:\\Users\\Example\\AppData\\Local\\SleepClaw\\app-0.1.0\\sleepclaw.exe';
class FakeChild extends EventEmitter { killed = 0; kill() { this.killed++; return true; } }

test('normal startup and non-Windows do not invoke Squirrel actions', async () => {
  for (const plan of [planSquirrelStartup([executable], executable, 'win32'), planSquirrelStartup([executable, '--squirrel-install'], executable, 'linux')]) {
    assert.equal(plan.handled, false);
    await runSquirrelStartup(plan, () => assert.fail('normal app must not quit'), () => { assert.fail('must not spawn'); });
  }
});

test('install/update create and uninstall removes only the SleepClaw shortcut', () => {
  for (const event of ['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall']) {
    const plan = planSquirrelStartup([executable, event, '0.1.0'], executable, 'win32');
    assert.equal(plan.handled, true);
    assert.equal(plan.executable, 'C:\\Users\\Example\\AppData\\Local\\SleepClaw\\Update.exe');
    assert.deepEqual(plan.args, [event === '--squirrel-uninstall' ? '--removeShortcut=sleepclaw.exe' : '--createShortcut=sleepclaw.exe']);
    assert.equal(plan.timeoutMs, 10_000);
    assert.ok(!plan.args!.some((argument) => /https?:|--update|--download/i.test(argument)));
  }
});

test('obsolete, conflicting events and unexpected layouts quit without running adjacent binaries', async () => {
  const plans = [
    planSquirrelStartup([executable, '--squirrel-obsolete'], executable, 'win32'),
    planSquirrelStartup([executable, '--squirrel-install', '--squirrel-uninstall'], executable, 'win32'),
    planSquirrelStartup([executable, '--squirrel-install'], 'C:\\dev\\electron.exe', 'win32'),
    planSquirrelStartup([executable, '--squirrel-install'], 'C:\\app-0.1.0\\sleepclaw.exe', 'win32'),
    planSquirrelStartup([executable, '--squirrel-install'], 'relative\\app-0.1.0\\sleepclaw.exe', 'win32'),
  ];
  for (const plan of plans) {
    let quit = 0;
    await runSquirrelStartup(plan, () => { quit++; }, () => { assert.fail('unexpected path must not spawn'); });
    assert.equal(quit, 1);
    assert.equal(plan.action, 'quit');
  }
});

test('shortcut child is hidden, has no shell, and app quits once after exit', async () => {
  const child = new FakeChild();
  let quits = 0;
  const plan = planSquirrelStartup([executable, '--squirrel-install'], executable, 'win32');
  const completed = runSquirrelStartup(plan, () => { quits++; }, (file, args, options) => {
    assert.equal(file, plan.executable);
    assert.deepEqual(args, ['--createShortcut=sleepclaw.exe']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    assert.equal(options.stdio, 'ignore');
    assert.equal(options.cwd, plan.cwd);
    return child;
  });
  assert.equal(quits, 0);
  child.emit('exit', 0);
  child.emit('error', new Error('synthetic late child error'));
  await completed;
  assert.equal(quits, 1);
  assert.equal(child.killed, 0);
});

test('missing Update.exe or spawn failure exits without a normal app launch', async () => {
  let quits = 0;
  const plan = planSquirrelStartup([executable, '--squirrel-uninstall'], executable, 'win32');
  await runSquirrelStartup(plan, () => { quits++; }, () => { throw new Error('synthetic ENOENT'); });
  const child = new FakeChild();
  const completed = runSquirrelStartup(plan, () => { quits++; }, () => child);
  child.emit('error', new Error('synthetic ENOENT'));
  await completed;
  assert.equal(quits, 2);
});

test('a hung shortcut process is killed after a bounded timeout and quits once', async () => {
  const child = new FakeChild();
  let quits = 0;
  const plan = { ...planSquirrelStartup([executable, '--squirrel-install'], executable, 'win32'), timeoutMs: 5 };
  await runSquirrelStartup(plan, () => { quits++; }, () => child);
  child.emit('exit', 0);
  assert.equal(child.killed, 1);
  assert.equal(quits, 1);
});

test('timeout still exits when terminating the shortcut child fails', async () => {
  const child = new FakeChild();
  child.kill = () => { throw new Error('synthetic termination failure'); };
  let quits = 0;
  const plan = { ...planSquirrelStartup([executable, '--squirrel-install'], executable, 'win32'), timeoutMs: 5 };
  await runSquirrelStartup(plan, () => { quits++; }, () => child);
  assert.equal(quits, 1);
});
