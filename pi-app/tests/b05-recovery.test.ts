import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SleepApp } from '../src/controller.js';
import type { AppEvent, AppSnapshot } from '../src/shared/types.js';

// Synthetic data and a loopback HTTP provider only. Real Pi sessions exercise
// provider errors separately from deterministic controller error-path probes.
const key = 'synthetic-b05-key-no-real-credentials';
const privateMarker = 'SYNTHETIC_PROVIDER_PRIVATE_DETAIL';
const first = { start: '2026-09-01T23:00:00.000Z', end: '2026-09-02T07:00:00.000Z', source: 'Synthetic Watch' };
const second = { start: '2026-09-02T23:00:00.000Z', end: '2026-09-03T07:00:00.000Z', source: 'Synthetic Watch' };
interface Body { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }
interface RecoveryNotice { kind: string; code: string }
const notice = (state: AppSnapshot) => (state as AppSnapshot & { notice?: RecoveryNotice }).notice;
function respond(response: ServerResponse, delta: Record<string, unknown>, finish: string) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [piece, reason] of [[{ role: 'assistant', ...delta }, null], [{}, finish]]) {
    response.write(`data: ${JSON.stringify({ id: 'synthetic-b05', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: piece, finish_reason: reason }] })}\n\n`);
  }
  response.end('data: [DONE]\n\n');
}
function text(response: ServerResponse, content: string) { respond(response, { content }, 'stop'); }
function call(response: ServerResponse, name: string, args: Record<string, unknown> = {}) {
  respond(response, { tool_calls: [{ index: 0, id: `synthetic-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
}
function fail(response: ServerResponse, status: number) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: { message: `Synthetic provider ${status} failure ${privateMarker} ${key}`, type: status === 401 ? 'invalid_api_key' : 'synthetic_error' } }));
}
async function fixture(t: TestContext, handler: (body: Body, response: ServerResponse, index: number) => void = (_body, response) => text(response, 'Synthetic response.')) {
  const home = await mkdtemp(join(tmpdir(), 'sleepclaw-b05-'));
  const events: AppEvent[] = [];
  let app = new SleepApp(home, event => events.push(event));
  const requests: Body[] = [];
  let handlerError: unknown;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw) as Body;
      if (body.tools?.some(tool => tool.function.name === 'sleepclaw_connection_test')) {
        if (body.messages.at(-1)?.role === 'tool') text(response, String(body.messages.at(-1)?.content));
        else call(response, 'sleepclaw_connection_test');
        return;
      }
      requests.push(body); handler(body, response, requests.length);
    } catch (error) {
      handlerError = error;
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic B05 provider assertion failed.' } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => {
    await app.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep), 'only remove this verified synthetic fixture directory');
    await rm(home, { recursive: true, force: true });
    if (handlerError) throw handlerError;
  });
  return { home, requests, events, get app() { return app; },
    configure: () => app.request('configure', { provider: 'synthetic', model: 'synthetic-model', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: key }),
    async reopen() { await app.close(); app = new SleepApp(home, event => events.push(event)); app.setCredential(key); return app; },
    stubPrompt(run: (value: string) => Promise<void>) { (app as unknown as { prompt: typeof run }).prompt = run; },
  };
}

test('B05 original real Pi 401 after successful configuration delivers a persisted local report and a safe notice', { timeout: 30_000 }, async t => {
  const f = await fixture(t, (_body, response) => fail(response, 401));
  await f.app.request('new', { goal: 'Synthetic report after provider authentication expires' });
  await f.app.request('fact', { topic: 'sleep_duration_hours', scope: 'sleep', value: 7 });
  await f.configure(); f.events.length = 0;
  const before = f.app.snapshot();
  const state = await f.app.request('report');
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].aiInterpretation, undefined);
  assert.equal(state.reports[0].metrics.find(metric => metric.key === 'selfReportedSleepMinutes')?.value, 420);
  assert.equal(notice(state)?.kind, 'report-local');
  assert.equal(notice(state)?.code, 'AUTH_FAILED');
  assert.equal(state.question, undefined);
  assert.equal(state.busy, false);
  assert.deepEqual(state.facts, before.facts);
  assert.equal(state.active!.revision, before.active!.revision);
  assert.equal(f.events.filter(event => event.type === 'error').length, 0, 'successful partial recovery must not emit an overall failure');
  assert.doesNotMatch(JSON.stringify({ notice: notice(state), events: f.events }), new RegExp(`${privateMarker}|${key}`));
  const exported = JSON.parse(await readFile(join(f.home, 'reports', `${state.reports[0].id}.json`), 'utf8'));
  assert.equal(exported.id, state.reports[0].id);
  await f.reopen();
  assert.deepEqual(notice(f.app.snapshot()), notice(state));
  assert.deepEqual(f.app.snapshot().reports, state.reports);
});

test('B05 real Pi answer failure is a saved answer, and repeated/reopened follow-up retries never resave it', { timeout: 30_000 }, async t => {
  let succeeds = false;
  const f = await fixture(t, (_body, response) => succeeds ? text(response, 'Synthetic successful follow-up.') : fail(response, 401));
  await f.app.request('new', { goal: 'Synthetic saved answer retry' });
  await f.configure(); f.events.length = 0;
  const before = f.app.snapshot();
  const saved = await f.app.request('answer', { value: 'Synthetic 30–39' });
  assert.equal(notice(saved)?.kind, 'followup-failed');
  assert.equal(notice(saved)?.code, 'AUTH_FAILED');
  assert.equal(saved.facts.length, 1);
  assert.equal(saved.facts[0].topic, 'age_range');
  assert.equal(saved.facts[0].value, 'Synthetic 30–39');
  assert.equal(saved.active!.revision, before.active!.revision + 1);
  assert.equal(saved.question?.topic, 'usual_schedule');
  assert.equal(f.events.filter(event => event.type === 'error').length, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const retried = await f.app.request('retryFollowup');
    assert.deepEqual(retried.facts, saved.facts);
    assert.equal(retried.active!.revision, saved.active!.revision);
    assert.equal(notice(retried)?.kind, 'followup-failed');
  }
  await f.reopen();
  assert.equal(notice(f.app.snapshot())?.kind, 'followup-failed');
  succeeds = true;
  const recovered = await f.app.request('retryFollowup');
  assert.deepEqual(recovered.facts, saved.facts);
  assert.equal(recovered.active!.revision, saved.active!.revision);
  assert.equal(notice(recovered), undefined);
  assert.equal(recovered.question?.topic, 'usual_schedule');
});

for (const [status, code] of [[429, 'QUOTA'], [404, 'MODEL_NOT_FOUND']] as const) test(`B05 real Pi HTTP ${status} during reporting preserves local usability`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, (_body, response) => fail(response, status));
  await f.app.request('new', { goal: `Synthetic provider HTTP ${status}` });
  await f.configure();
  const state = await f.app.request('report');
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].status, 'complete');
  assert.equal(notice(state)?.code, code);
  const count = f.requests.length;
  await f.app.request('reportLocal');
  assert.equal(f.requests.length, count, 'explicit local reporting must never call the failing provider');
});

test('B05 a report saved by a real Pi tool survives failure of the final model response', { timeout: 30_000 }, async t => {
  const f = await fixture(t, (_body, response, index) => {
    if (index === 1) call(response, 'sleep_report', { interpretation: 'Synthetic completed AI interpretation.', action: 'Synthetic completed AI action.' });
    else fail(response, 401);
  });
  const created = await f.app.request('new', { goal: 'Synthetic report already saved before final response failure' });
  await f.configure();
  const state = await f.app.request('report');
  assert.equal(state.reports.length, 1, 'no second local report should replace the completed AI report');
  assert.equal(state.reports[0].aiInterpretation, 'Synthetic completed AI interpretation.');
  assert.equal(state.reports[0].action, 'Synthetic completed AI action.');
  assert.equal(notice(state)?.kind, 'report-saved', 'a preserved AI report must not be described as a local-only fallback');
  assert.equal(notice(state)?.code, 'AUTH_FAILED');
  assert.equal(state.active!.revision, created.active!.revision);
  assert.equal(state.question, undefined);
});

test('B05 local fallback includes facts already saved by real Pi before provider failure', { timeout: 30_000 }, async t => {
  const f = await fixture(t, (_body, response, index) => {
    if (index === 1) call(response, 'sleep_fact', { topic: 'sleep_duration_hours', scope: 'sleep', value: 8 });
    else fail(response, 401);
  });
  await f.app.request('new', { goal: 'Synthetic user explicitly reported eight hours' });
  await f.configure();
  const state = await f.app.request('report');
  assert.equal(state.facts.find(fact => fact.topic === 'sleep_duration_hours')?.value, 8);
  assert.equal(state.reports[0].metrics.find(metric => metric.key === 'selfReportedSleepMinutes')?.value, 480);
  assert.equal(state.reports[0].factRevision, state.active!.revision);
});

test('B05 cancelling an active real Pi request never creates an automatic fallback report', { timeout: 30_000 }, async t => {
  let started!: () => void;
  const receiving = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, (_body, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(': synthetic stream held for explicit cancellation\n\n'); started();
  });
  await f.app.request('new', { goal: 'Synthetic explicit cancellation' });
  await f.configure();
  const requested = f.app.request('report');
  const rejected = assert.rejects(requested, /CANCELLED/);
  await receiving; await f.app.request('cancel'); await rejected;
  const state = f.app.snapshot();
  assert.deepEqual(state.reports, []);
  assert.equal(state.busy, false);
  assert.equal(notice(state), undefined);
});

for (const [raw, code] of [
  ['401 unauthorized synthetic detail', 'AUTH_FAILED'], ['429 quota synthetic detail', 'QUOTA'],
  ['TIMEOUT', 'TIMEOUT'], ['fetch failed: synthetic network outage', 'REQUEST_FAILED'],
  ['404 model not found', 'MODEL_NOT_FOUND'], ['TURN_LIMIT', 'TURN_LIMIT'],
] as const) test(`B05 controlled report error ${code} delivers a local report without mutating facts`, async t => {
  const f = await fixture(t);
  await f.app.request('new', { goal: `Synthetic ${code} fallback` }); await f.configure();
  f.stubPrompt(async () => { throw new Error(raw); });
  const before = f.app.snapshot();
  const state = await f.app.request('report');
  assert.equal(notice(state)?.code, code);
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].aiInterpretation, undefined);
  assert.deepEqual(state.facts, before.facts);
  assert.equal(state.active!.revision, before.active!.revision);
});

for (const code of ['CANCELLED', 'EPISODE_CHANGED', 'INVALID_QUERY_RANGE', 'INVALID_FACT', 'INVALID_TARGET', 'REPORT_TEXT_TOO_LONG']) test(`B05 controlled ${code} remains a failure without silently generating a report`, async t => {
  const f = await fixture(t);
  await f.app.request('new', { goal: `Synthetic non-provider ${code}` }); await f.configure();
  f.stubPrompt(async () => { throw new Error(code); });
  const before = f.app.snapshot();
  await assert.rejects(f.app.request('report'), new RegExp(code));
  const after = f.app.snapshot();
  assert.deepEqual(after.reports, before.reports);
  assert.deepEqual(after.facts, before.facts);
  assert.equal(notice(after), undefined);
});

test('B05 explicit local report bypasses a configured model and keeps the local report resumable', async t => {
  const f = await fixture(t);
  const created = await f.app.request('new', { goal: 'Synthetic local report with configured model' });
  await f.configure();
  f.stubPrompt(async () => assert.fail('reportLocal must not invoke the model'));
  const state = await f.app.request('reportLocal');
  assert.equal(f.requests.length, 0);
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].aiInterpretation, undefined);
  assert.equal(state.question, undefined);
  const resumed = await f.app.request('resume');
  assert.deepEqual(resumed.question, created.question);
  assert.deepEqual(resumed.reports, state.reports);
});

test('B05 recovery notice and retry are isolated across investigations and sleep episodes', async t => {
  const f = await fixture(t);
  const a = await f.app.request('new', { goal: 'Synthetic recovery owner A' });
  await f.app.request('target', first); await f.configure();
  let retryCalls = 0;
  f.stubPrompt(async () => { retryCalls++; throw new Error('401 unauthorized synthetic'); });
  const failed = await f.app.request('answer', { value: 'Synthetic profile age' });
  assert.equal(notice(failed)?.kind, 'followup-failed');
  const b = await f.app.request('new', { goal: 'Synthetic recovery owner B' });
  assert.notEqual(b.active!.id, a.active!.id);
  assert.equal(notice(b), undefined);
  await assert.rejects(f.app.request('retryFollowup'));
  assert.equal(retryCalls, 1);
  const restored = await f.app.request('select', { id: a.active!.id });
  assert.equal(notice(restored)?.kind, 'followup-failed');
  const later = await f.app.request('target', second);
  assert.equal(notice(later), undefined);
  await assert.rejects(f.app.request('retryFollowup'));
  assert.equal(retryCalls, 1, 'the old retry cannot run against the new sleep');
});

test('B05 real Pi broken connection during reporting delivers a local report', { timeout: 30_000 }, async t => {
  const f = await fixture(t, (_body, response) => response.destroy());
  await f.app.request('new', { goal: 'Synthetic dropped local provider connection' });
  await f.configure();
  const state = await f.app.request('report');
  assert.equal(state.reports.length, 1);
  assert.equal(notice(state)?.kind, 'report-local');
  assert.equal(notice(state)?.code, 'REQUEST_FAILED');
  assert.equal(state.busy, false);
});

test('B05 real Pi cancelling an already-saved answer returns successful durable state with a resumable notice', { timeout: 30_000 }, async t => {
  let started!: () => void;
  const receiving = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, (_body, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(': synthetic answer follow-up held for cancellation\n\n'); started();
  });
  await f.app.request('new', { goal: 'Synthetic cancel after answer is saved' });
  await f.configure(); f.events.length = 0;
  const request = f.app.request('answer', { value: 'Synthetic durable age' });
  await receiving; await f.app.request('cancel');
  const state = await request;
  assert.equal(state.facts.length, 1);
  assert.equal(state.facts[0].value, 'Synthetic durable age');
  assert.equal(state.question?.topic, 'usual_schedule');
  assert.equal(notice(state)?.kind, 'followup-failed');
  assert.equal(notice(state)?.code, 'CANCELLED');
  assert.equal(state.busy, false);
  assert.deepEqual(state.reports, []);
  assert.equal(f.events.filter(event => event.type === 'error').length, 0);
  await f.reopen();
  assert.deepEqual(notice(f.app.snapshot()), notice(state));
});

test('B05 explicit local continuation survives reopen and further answers without touching the configured model', async t => {
  const f = await fixture(t);
  const a = await f.app.request('new', { goal: 'Synthetic local continuation' });
  await f.configure();
  f.stubPrompt(async () => { throw new Error('401 unauthorized synthetic'); });
  await f.app.request('answer', { value: 'Synthetic age' });
  const local = await f.app.request('continueLocal');
  assert.equal(local.localCollection, true);
  assert.equal(notice(local), undefined);
  assert.equal(local.question?.topic, 'usual_schedule');
  f.stubPrompt(async () => assert.fail('explicit local collection must not invoke the model'));
  const answered = await f.app.request('answer', { value: 'Synthetic usual schedule' });
  assert.equal(answered.question?.topic, 'sleep_duration_hours');
  await f.reopen();
  assert.equal(f.app.snapshot().localCollection, true);
  f.stubPrompt(async () => assert.fail('restored local collection must not invoke the model'));
  const continued = await f.app.request('answer', { value: 7 });
  assert.equal(continued.facts.find(fact => fact.topic === 'sleep_duration_hours')?.value, 7);
  assert.equal(continued.question?.topic, 'remembered_awakenings');
  const b = await f.app.request('new', { goal: 'Synthetic different local preference owner' });
  assert.equal(b.localCollection, false, 'a local preference does not leak into another investigation');
  const restored = await f.app.request('select', { id: a.active!.id });
  assert.equal(restored.localCollection, true);
});

test('B05 local collection preference does not transfer into a newly selected sleep episode', async t => {
  const f = await fixture(t);
  await f.app.request('new', { goal: 'Synthetic episode-specific local preference' });
  await f.app.request('target', first);
  const local = await f.app.request('continueLocal');
  assert.equal(local.localCollection, true);
  const other = await f.app.request('target', second);
  assert.equal(other.localCollection, false);
  assert.equal(notice(other), undefined);
});

for (const change of ['answer', 'fact', 'question', 'reportLocal'] as const) test(`B05 a ${change} update invalidates an older failed follow-up retry`, async t => {
  const f = await fixture(t);
  const created = await f.app.request('new', { goal: 'Synthetic stale retry invalidation' });
  await f.configure();
  f.stubPrompt(async () => { throw new Error('401 unauthorized synthetic'); });
  const failed = await f.app.request('answer', { value: 'Synthetic original age' });
  assert.equal(notice(failed)?.kind, 'followup-failed');
  if (change === 'answer') await f.app.request('answer', { skip: true });
  if (change === 'fact') await f.app.request('fact', { topic: 'age_range', scope: 'profile', value: 'Synthetic corrected age' });
  if (change === 'question') f.app.store.saveQuestion(created.active!.id, { id: 'synthetic-new-question', topic: 'new_context', scope: 'sleep', text: 'Synthetic newer question' });
  if (change === 'reportLocal') await f.app.request('reportLocal');
  assert.equal(notice(f.app.snapshot()), undefined);
  const before = f.app.snapshot();
  await assert.rejects(f.app.request('retryFollowup'), /NO_PENDING_FOLLOWUP/);
  assert.deepEqual(f.app.snapshot().facts, before.facts);
});

test('B05 reconfiguration preserves an unresolved notice so a successful retry remains available', async t => {
  const f = await fixture(t);
  await f.app.request('new', { goal: 'Synthetic model reconfiguration recovery' }); await f.configure();
  f.stubPrompt(async () => { throw new Error('401 unauthorized synthetic'); });
  const failed = await f.app.request('answer', { value: 'Synthetic retained age' });
  const configured = await f.configure();
  assert.deepEqual(notice(configured), notice(failed));
  let retryPrompt = '';
  f.stubPrompt(async value => { retryPrompt = value; });
  const succeeded = await f.app.request('retryFollowup');
  assert.equal(notice(succeeded), undefined);
  assert.equal(succeeded.localCollection, false);
  assert.deepEqual(succeeded.facts, failed.facts);
  assert.equal(succeeded.active!.revision, failed.active!.revision);
  assert.match(retryPrompt, /already saved|current facts/);
  assert.doesNotMatch(retryPrompt, /Synthetic retained age/, 'retry instructions do not replay the literal old answer');
});

test('B05 cancelled follow-up retry preserves facts and the retry notice', async t => {
  const f = await fixture(t);
  await f.app.request('new', { goal: 'Synthetic follow-up retry cancellation' }); await f.configure();
  f.stubPrompt(async () => { throw new Error('401 unauthorized synthetic'); });
  const failed = await f.app.request('answer', { value: 'Synthetic age survives retry cancellation' });
  f.stubPrompt(async () => { throw new Error('CANCELLED'); });
  const cancelled = await f.app.request('retryFollowup');
  assert.deepEqual(cancelled.facts, failed.facts);
  assert.equal(cancelled.active!.revision, failed.active!.revision);
  assert.equal(notice(cancelled)?.kind, 'followup-failed');
  assert.equal(notice(cancelled)?.code, 'CANCELLED');
});

test('B05 a stale AI report is retained as history while failure generates a current local report', async t => {
  const f = await fixture(t);
  const created = await f.app.request('new', { goal: 'Synthetic stale report should not block fallback' });
  f.app.store.setFact(created.active!.id, { topic: 'sleep_duration_hours', scope: 'sleep', value: 6 });
  const old = f.app.store.buildReport(created.active!.id, 'Synthetic outdated AI interpretation.', 'Synthetic old action.');
  await f.app.request('fact', { topic: 'sleep_duration_hours', scope: 'sleep', value: 8 });
  await f.configure();
  f.stubPrompt(async () => { throw new Error('401 unauthorized synthetic'); });
  const state = await f.app.request('report');
  assert.equal(state.reports.length, 2);
  assert.equal(state.reports.find(report => report.id === old.id)?.status, 'stale');
  const current = state.reports.find(report => report.id !== old.id)!;
  assert.equal(current.status, 'complete');
  assert.equal(current.factRevision, state.active!.revision);
  assert.equal(current.aiInterpretation, undefined);
  assert.equal(current.metrics.find(metric => metric.key === 'selfReportedSleepMinutes')?.value, 480);
  assert.equal(notice(state)?.kind, 'report-local');
});

for (const method of ['reportLocal', 'report'] as const) test(`B05 ${method} does not report success when saving the local report fails`, async t => {
  const f = await fixture(t);
  await f.app.request('new', { goal: 'Synthetic local storage failure' }); await f.configure();
  f.stubPrompt(async () => { throw new Error('401 unauthorized synthetic'); });
  f.app.store.buildReport = () => { throw new Error('SYNTHETIC_REPORT_STORAGE_FAILURE'); };
  await assert.rejects(f.app.request(method), /REQUEST_FAILED/);
  const state = f.app.snapshot();
  assert.deepEqual(state.reports, []);
  assert.equal(notice(state), undefined, 'no local-delivery success notice may be written before the report is durable');
  assert.equal(state.busy, false);
});

test('B05 provider failure after a changed episode must not attach a fallback or notice to the new sleep', async t => {
  const f = await fixture(t);
  const created = await f.app.request('new', { goal: 'Synthetic retarget during failing prompt' });
  await f.app.request('target', first); await f.configure();
  f.stubPrompt(async () => {
    f.app.store.setTarget(created.active!.id, second);
    throw new Error('401 unauthorized synthetic');
  });
  await assert.rejects(f.app.request('report'), /EPISODE_CHANGED/);
  assert.deepEqual(f.app.snapshot().reports, []);
  assert.equal(notice(f.app.snapshot()), undefined);
});

test('B05 deleting an investigation removes its persisted recovery workflow', async t => {
  const f = await fixture(t);
  const created = await f.app.request('new', { goal: 'Synthetic recovery cleanup' }); await f.configure();
  f.stubPrompt(async () => { throw new Error('401 unauthorized synthetic'); });
  await f.app.request('answer', { value: 'Synthetic answer before deletion' });
  assert.equal(notice(f.app.snapshot())?.kind, 'followup-failed');
  await f.app.request('delete', { id: created.active!.id });
  const settings = JSON.parse(await readFile(join(f.home, 'settings.json'), 'utf8'));
  assert.equal(settings.workflows?.[created.active!.id], undefined);
  assert.equal(notice(f.app.snapshot()), undefined);
});

test('B05 real Pi tool loop reaches the twelve-turn limit and still delivers a local report', { timeout: 30_000 }, async t => {
  const f = await fixture(t, (_body, response, index) => {
    assert.ok(index <= 12, 'the provider cannot run beyond the shared turn budget');
    call(response, 'sleep_context');
  });
  await f.app.request('new', { goal: 'Synthetic repeated model context reads' }); await f.configure();
  const state = await f.app.request('report');
  assert.equal(f.requests.length, 12);
  assert.equal(notice(state)?.kind, 'report-local');
  assert.equal(notice(state)?.code, 'TURN_LIMIT', 'budget exhaustion must remain distinct from user cancellation');
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].aiInterpretation, undefined);
  assert.equal(state.busy, false);
});

test('B05 returning from local collection to model mode performs no network call until the next answer', async t => {
  const f = await fixture(t);
  await f.app.request('new', { goal: 'Synthetic explicit model mode restoration' }); await f.configure();
  await f.app.request('continueLocal');
  let prompts = 0;
  f.stubPrompt(async () => { prompts++; });
  const before = f.app.snapshot();
  const restored = await f.app.request('continueWithModel');
  assert.equal(restored.localCollection, false);
  assert.equal(prompts, 0);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(restored.question, before.question);
  assert.deepEqual(restored.facts, before.facts);
  assert.equal(restored.active!.revision, before.active!.revision);
  const answered = await f.app.request('answer', { value: 'Synthetic answer after model mode restored' });
  assert.equal(prompts, 1);
  assert.equal(answered.facts.length, before.facts.length + 1);
});
