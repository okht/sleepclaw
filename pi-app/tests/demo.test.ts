import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { SleepApp } from '../src/controller.js';
import { createDemoHome, createDemoServer, DEMO, demoChildEnvironment, seedDemo } from '../scripts/demo.js';

test('synthetic demo uses the real import, Pi tools, saved answer, and unscored complete report', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sleepclaw-demo-test-'));
  const home = createDemoHome(root);
  const mock = await createDemoServer();
  let app: SleepApp | undefined;
  t.after(async () => {
    await app?.close(); mock.server.closeAllConnections();
    await new Promise<void>(done => mock.server.close(() => done()));
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}sleepclaw-demo-test-`));
    await rm(root, { recursive: true, force: true });
  });
  await seedDemo(home);
  await assert.rejects(seedDemo(home), /must not overwrite/);
  app = new SleepApp(home);
  const seeded = app.snapshot();
  assert.equal(seeded.language, 'en');
  assert.equal(seeded.investigations.length, 3);
  assert.equal(seeded.active?.goal, DEMO.goal);
  assert.equal(seeded.question, undefined);
  assert.equal(seeded.configured, false);
  assert.equal(seeded.imports.length, 1);
  assert.equal(seeded.imports[0].recordCount, 13);
  assert.equal(seeded.candidates[0].asleepMinutes, 420);
  assert.equal(seeded.reports.length, 0);
  await app.request('configure', { provider: DEMO.provider, model: DEMO.model, protocol: 'openai-completions', baseUrl: mock.baseUrl, apiKey: DEMO.apiKey });
  const questioned = await app.request('send', { text: DEMO.prompt });
  assert.equal(questioned.question?.topic, 'night_noise');
  assert.equal(questioned.question?.text, DEMO.question);
  assert.equal(questioned.reports.length, 0);
  assert.deepEqual(mock.status(), { requests: 5, step: 3, failed: false });
  const finished = await app.request('answer', { value: DEMO.answer });
  assert.equal(finished.question, undefined);
  assert.equal(finished.facts.find(fact => fact.topic === 'night_noise')?.value, DEMO.answer);
  const report = finished.reports[0];
  assert.equal(report.status, 'complete'); assert.equal(report.language, 'en'); assert.equal(report.score, null);
  assert.equal(report.metrics.find(item => item.key === 'totalSleepMinutes')?.value, 420);
  assert.equal(report.metrics.find(item => item.key === 'awakeMinutes')?.value, 30);
  assert.equal(report.metrics.find(item => item.key === 'inBedMinutes')?.value, 450);
  assert.equal(report.metrics.find(item => item.key === 'stage_core_minutes')?.value, 245);
  assert.equal(report.metrics.find(item => item.key === 'stage_deep_minutes')?.value, 75);
  assert.equal(report.metrics.find(item => item.key === 'stage_rem_minutes')?.value, 100);
  assert.equal(report.timeline?.length, 12);
  assert.equal(report.aiInterpretation, DEMO.interpretation); assert.equal(report.action, DEMO.action);
  assert.ok(finished.messages.some(message => message.text.includes('Your report is ready.')));
  assert.ok(!JSON.stringify(finished).includes(DEMO.apiKey));
  assert.ok(!(await readFile(join(home, 'settings.json'), 'utf8')).includes(DEMO.apiKey));
  assert.deepEqual(mock.status(), { requests: 8, step: 6, failed: false });
});

test('synthetic model rejects non-demo credentials and remains fail closed', async (t) => {
  const mock = await createDemoServer();
  t.after(async () => { mock.server.closeAllConnections(); await new Promise<void>(done => mock.server.close(() => done())); });
  const response = await fetch(`${mock.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer deliberately-wrong-synthetic-key', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 400);
  assert.equal(mock.status().failed, true);
  const subsequent = await fetch(`${mock.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${DEMO.apiKey}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(subsequent.status, 400);
  assert.ok(!(await subsequent.text()).includes('deliberately-wrong-synthetic-key'));
});

test('desktop environment removes inherited credentials, proxies and smoke configuration', () => {
  const env = demoChildEnvironment('synthetic-new-home', { OPENAI_API_KEY: 'synthetic-inherited-key', HTTPS_PROXY: 'http://127.0.0.1:9', SLEEPCLAW_SMOKE: '1', SLEEPCLAW_HOME: 'synthetic-old-home' });
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.SLEEPCLAW_SMOKE, undefined); assert.equal(env.SLEEPCLAW_HOME, 'synthetic-new-home');
  assert.equal(env.SLEEPCLAW_UI_TEST, '1');
});
