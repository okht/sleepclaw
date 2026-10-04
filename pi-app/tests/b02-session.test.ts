import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { SleepApp } from '../src/controller.js';
import { createSleepTools, safeToolError, sleepContext } from '../src/tools.js';

const first = { start: '2026-09-20T23:00:00+08:00', end: '2026-09-21T07:00:00+08:00', source: 'Synthetic Watch' };
const second = { start: '2026-09-21T23:00:00+08:00', end: '2026-09-22T07:00:00+08:00', source: 'Synthetic Watch' };
const marker = 'synthetic-first-night-headache-only';
interface Body { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }

function frame(response: ServerResponse, delta: Record<string, unknown>, finish: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: 'synthetic-b02', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function text(response: ServerResponse, value: string) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  frame(response, { role: 'assistant', content: value }); frame(response, {}, 'stop'); response.end('data: [DONE]\n\n');
}
function toolCalls(response: ServerResponse, calls: Array<{ name: string; args?: Record<string, unknown> }>) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  frame(response, { role: 'assistant', tool_calls: calls.map(({ name, args }, index) => ({ index, id: `synthetic-${index}-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args ?? {}) } })) });
  frame(response, {}, 'tool_calls'); response.end('data: [DONE]\n\n');
}
async function fixture(t: TestContext, handler?: (body: Body, response: ServerResponse, index: number) => void) {
  const home = await mkdtemp(join(tmpdir(), 'sleepclaw-b02-session-'));
  let app = new SleepApp(home);
  let handlerError: unknown;
  const requests: Body[] = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw) as Body;
      if (body.tools?.some(tool => tool.function.name === 'sleepclaw_connection_test')) {
        if (body.messages.at(-1)?.role === 'tool') text(response, String(body.messages.at(-1)?.content));
        else toolCalls(response, [{ name: 'sleepclaw_connection_test' }]);
        return;
      }
      requests.push(body);
      if (handler) handler(body, response, requests.length);
      else text(response, 'Synthetic answer for the current sleep.');
    } catch (error) {
      handlerError = error;
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic B02 provider assertion failed.' } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const key = 'synthetic-b02-key-no-real-credentials';
  t.after(async () => {
    await app.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const target = resolve(home);
    assert.ok(target.startsWith(resolve(tmpdir())), 'only remove the verified synthetic fixture directory');
    await rm(target, { recursive: true, force: true });
    if (handlerError) throw handlerError;
  });
  return {
    home, requests, get app() { return app; },
    configure: () => app.request('configure', { provider: 'synthetic', model: 'synthetic-model', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: key }),
    async reopen(rewrite?: (db: DatabaseSync) => void) {
      await app.close();
      if (rewrite) { const db = new DatabaseSync(join(home, 'sleepclaw.sqlite')); try { rewrite(db); } finally { db.close(); } }
      app = new SleepApp(home); app.setCredential(key); return app;
    },
  };
}

test('B02 model context contains only current-episode facts, reports and feedback, without old goal text', async t => {
  const f = await fixture(t);
  const { store } = f.app;
  const id = store.createInvestigation(marker, 'en').id;
  store.setTarget(id, first);
  store.setFact(id, { topic: 'recovery', scope: 'sleep', value: marker });
  store.setFact(id, { topic: 'usual_schedule', scope: 'profile', value: 'Synthetic night shifts' });
  const oldReport = store.buildReport(id, marker, 'Synthetic first-night action');
  store.recordFeedback(oldReport.id, 'cannot', marker);
  store.saveQuestion(id, { id: 'synthetic-old-question', topic: 'noise', scope: 'sleep', text: marker });
  store.savePlan(id, { objective: marker, revision: store.getInvestigation(id).revision, steps: [{ id: 'read', kind: 'query', description: marker, status: 'pending' }] });
  store.createInvestigation(`Other investigation ${marker}`, 'en');
  store.setTarget(id, second);
  const context = sleepContext(store, id) as { reports: unknown[]; feedback: unknown[]; facts: Array<{ value: unknown }> };
  assert.doesNotMatch(JSON.stringify(context), new RegExp(marker));
  assert.deepEqual(context.reports, []);
  assert.deepEqual(context.feedback, []);
  assert.ok(context.facts.some(fact => fact.value === 'Synthetic night shifts'));
  assert.doesNotMatch(JSON.stringify(sleepContext(store)), new RegExp(marker), 'discovery goals cannot reintroduce another sleep symptom');
  const currentReport = store.buildReport(id);
  store.recordFeedback(currentReport.id, 'later', 'Current-episode feedback');
  const current = sleepContext(store, id) as { reports: Array<{ id: string }>; feedback: Array<{ reportId: string }> };
  assert.deepEqual(current.reports.map(report => report.id), [currentReport.id]);
  assert.deepEqual(current.feedback.map(feedback => feedback.reportId), [currentReport.id]);
  assert.ok(store.snapshot(id).reports.some(report => report.id === oldReport.id), 'historical evidence remains stored');
});

test('B02 a stale episode-bound tool set cannot save facts, questions, reports or feedback', async t => {
  const f = await fixture(t);
  const { store } = f.app;
  const id = store.createInvestigation('Tool epoch test', 'en').id;
  store.setTarget(id, first);
  const oldReport = store.buildReport(id);
  const tools = createSleepTools(store, { investigationId: () => id, episodeId: store.getInvestigation(id).sleepEpisodeId ?? id });
  const call = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute(args);
  await call('sleep_target', second);
  for (const [name, args] of [
    ['sleep_fact', { topic: 'recovery', scope: 'sleep', value: marker }],
    ['sleep_question', { topic: 'noise', scope: 'sleep', text: marker }],
    ['sleep_report', { interpretation: marker, action: '' }],
    ['sleep_feedback', { reportId: oldReport.id, choice: 'cannot', note: marker }],
    ['sleep_target', first],
  ] as const) await assert.rejects(call(name, args), /EPISODE_CHANGED/);
  assert.doesNotMatch(JSON.stringify(await call('sleep_context', {})), new RegExp(marker));
  const currentTools = createSleepTools(store, { investigationId: () => id, episodeId: store.getInvestigation(id).sleepEpisodeId! });
  await currentTools.find(tool => tool.name === 'sleep_fact')!.execute({ topic: 'recovery', scope: 'sleep', value: 'Current sleep feels fine' });
  assert.equal(store.snapshot(id).facts.find(fact => fact.topic === 'recovery')?.value, 'Current sleep feels fine');
  assert.equal(safeToolError(new Error('EPISODE_CHANGED')).code, 'EPISODE_CHANGED');
});

test('B02 real Pi UI retarget isolates sessions, survives reopen and restores the earlier episode history', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const created = await f.app.request('new', { goal: marker });
  const id = created.active!.id;
  await f.app.request('target', first);
  await f.configure();
  await f.app.request('send', { text: marker });
  assert.match(JSON.stringify(f.app.snapshot().messages), new RegExp(marker));
  const secondState = await f.app.request('target', second);
  assert.deepEqual(secondState.messages, []);
  await f.app.request('send', { text: 'Analyze this selected sleep.' });
  assert.equal(f.requests.length, 2);
  assert.doesNotMatch(JSON.stringify(f.requests[1]), new RegExp(marker), 'the real provider request must contain no first-night conversation or goal');
  await f.reopen();
  const reopened = await f.app.request('select', { id });
  assert.match(JSON.stringify(reopened.messages), /Analyze this selected sleep/);
  assert.doesNotMatch(JSON.stringify(reopened.messages), new RegExp(marker));
  const restored = await f.app.request('target', first);
  assert.match(JSON.stringify(restored.messages), new RegExp(marker));
  assert.doesNotMatch(JSON.stringify(restored.messages), /Analyze this selected sleep/);
  assert.equal(f.requests.length, 2, 'switching and resuming never call the provider');
});

test('B02 source changes and small same-episode range corrections retain the Pi conversation', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.app.request('new', { goal: 'Same episode adjustments' });
  await f.app.request('target', first);
  await f.configure();
  const before = await f.app.request('send', { text: marker });
  const changed = await f.app.request('target', { ...first, source: 'Synthetic Other Watch', start: '2026-09-20T23:15:00+08:00' });
  assert.equal(changed.active!.sleepEpisodeId, before.active!.sleepEpisodeId);
  assert.deepEqual(changed.messages, before.messages);
  await assert.rejects(f.app.request('target', { ...second, end: second.start }), /INVALID_TARGET/);
  assert.deepEqual(f.app.snapshot().messages, before.messages, 'invalid targets cannot disturb the current conversation');
});

test('B02 real Pi retarget stops the old tool batch and continues the request in a clean episode', { timeout: 30_000 }, async t => {
  const f = await fixture(t, (body, response, index) => {
    if (index === 1) text(response, 'Stored the synthetic first-night discussion.');
    else if (index === 2) toolCalls(response, [
      { name: 'sleep_target', args: second },
      { name: 'sleep_fact', args: { topic: 'recovery', scope: 'sleep', value: marker } },
      { name: 'sleep_report', args: { interpretation: marker, action: '' } },
    ]);
    else if (index === 3) {
      assert.doesNotMatch(JSON.stringify(body), new RegExp(marker));
      assert.match(JSON.stringify(body), /Continue the original request/);
      toolCalls(response, [{ name: 'sleep_report', args: { interpretation: '', action: '' } }]);
    } else if (index === 4) text(response, 'The selected sleep report is ready.');
    else assert.fail(`Unexpected inference request ${index}`);
  });
  await f.app.request('new', { goal: marker });
  await f.app.request('target', first);
  await f.app.request('fact', { topic: 'recovery', scope: 'sleep', value: marker });
  await f.configure();
  await f.app.request('send', { text: marker });
  const finished = await f.app.request('send', { text: 'Switch to the following night and create its report.' });
  assert.equal(f.requests.length, 4);
  assert.equal(finished.busy, false);
  assert.equal(finished.active!.start, new Date(second.start).toISOString());
  assert.doesNotMatch(JSON.stringify(finished.facts), new RegExp(marker));
  const reports = finished.reports.filter(report => report.sleepEpisodeId === finished.active!.sleepEpisodeId);
  assert.equal(reports.length, 1);
  assert.doesNotMatch(JSON.stringify(reports), new RegExp(marker));
  assert.doesNotMatch(JSON.stringify(finished.messages), new RegExp(marker));
  assert.doesNotMatch(JSON.stringify(finished.messages), /Continue the original request|episodeContinuation/, 'internal restart instructions stay outside displayed conversation');
});

test('B02 repeated model retargeting stops within the shared restart budget and leaves the app usable', { timeout: 30_000 }, async t => {
  const f = await fixture(t, (_body, response, index) => {
    assert.ok(index <= 3, 'at most three episode sessions may run for one request');
    toolCalls(response, [{ name: 'sleep_target', args: index % 2 ? second : first }]);
  });
  await f.app.request('new', { goal: 'Bounded target correction' });
  await f.app.request('target', first);
  await f.configure();
  await assert.rejects(f.app.request('send', { text: 'Analyze the selected sleep.' }), /EPISODE_CHANGED/);
  assert.equal(f.requests.length, 3);
  assert.equal(f.app.snapshot().busy, false);
  const state = await f.app.request('fact', { topic: 'recovery', scope: 'sleep', value: 'Still able to continue' });
  assert.equal(state.facts.find(fact => fact.topic === 'recovery')?.value, 'Still able to continue');
});

test('B02 legacy reports and their feedback require matching target provenance before entering model context', async t => {
  const f = await fixture(t);
  const id = (await f.app.request('new', { goal: 'Legacy target provenance' })).active!.id;
  await f.app.request('target', first);
  const oldReport = f.app.store.buildReport(id, marker, 'Synthetic first-night action');
  f.app.store.recordFeedback(oldReport.id, 'cannot', marker);
  await f.app.request('target', second);
  const currentReport = f.app.store.buildReport(id, 'Second-night legacy interpretation', 'Second-night action');
  f.app.store.recordFeedback(currentReport.id, 'later', 'Current legacy feedback');
  await f.reopen(db => {
    const row = db.prepare('SELECT data FROM investigations WHERE id=?').get(id)!;
    const legacy = JSON.parse(String(row.data)); delete legacy.sleepEpisodeId;
    db.prepare('UPDATE investigations SET data=? WHERE id=?').run(JSON.stringify(legacy), id);
    for (const reportRow of db.prepare('SELECT id,data FROM reports').all()) {
      const report = JSON.parse(String(reportRow.data)); delete report.sleepEpisodeId;
      db.prepare('UPDATE reports SET data=? WHERE id=?').run(JSON.stringify(report), String(reportRow.id));
    }
    db.exec('DELETE FROM sleep_episodes; PRAGMA user_version=1;');
  });
  const context = sleepContext(f.app.store, id) as { reports: Array<{ id: string }>; feedback: Array<{ reportId: string }> };
  assert.doesNotMatch(JSON.stringify(context), new RegExp(marker));
  assert.deepEqual(context.reports.map(report => report.id), [currentReport.id]);
  assert.deepEqual(context.feedback.map(feedback => feedback.reportId), [currentReport.id]);
  assert.equal(f.app.store.snapshot(id).reports.length, 2, 'legacy evidence remains stored');
});

for (const end of ['cancel', 'timeout'] as const) test(`B02 real Pi ${end} prevents a late provider tool call from writing a fact`, { timeout: 30_000 }, async t => {
  let resolveStarted!: () => void;
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  let heldResponse: ServerResponse | undefined;
  const f = await fixture(t, (_body, response) => {
    heldResponse = response;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    frame(response, { role: 'assistant', content: 'Synthetic provider is still considering the selected sleep.' });
    resolveStarted();
  });
  await f.app.request('new', { goal: 'Late tool cancellation' });
  await f.app.request('target', first);
  await f.configure();
  let deadline: (() => void) | undefined;
  const originalTimeout = globalThis.setTimeout;
  const timer = end === 'timeout' ? t.mock.method(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 120_000) deadline = () => callback(...args);
    return originalTimeout(callback, delay, ...args);
  }) as typeof setTimeout) : undefined;
  const pending = f.app.request('send', { text: 'Analyze the current sleep.' }).then(value => value, error => error as Error);
  await started;
  if (end === 'cancel') await f.app.request('cancel');
  else { assert.ok(deadline); deadline(); }
  const outcome = await pending;
  timer?.mock.restore();
  assert.ok(outcome instanceof Error);
  assert.equal(outcome.message, end === 'cancel' ? 'CANCELLED' : 'TIMEOUT');
  assert.ok(heldResponse);
  // Simulate a provider finishing a buffered response after the client aborted.
  frame(heldResponse, { tool_calls: [{ index: 0, id: 'late-synthetic-fact', type: 'function', function: { name: 'sleep_fact', arguments: JSON.stringify({ topic: 'recovery', scope: 'sleep', value: marker }) } }] });
  frame(heldResponse, {}, 'tool_calls'); heldResponse.end('data: [DONE]\n\n');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1);
  assert.equal(f.app.snapshot().busy, false);
  assert.doesNotMatch(JSON.stringify(f.app.snapshot().facts), new RegExp(marker));
  const usable = await f.app.request('fact', { topic: 'recovery', scope: 'sleep', value: 'A new explicit answer after stopping' });
  assert.equal(usable.facts.find(fact => fact.topic === 'recovery')?.value, 'A new explicit answer after stopping');
});
