import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SleepApp } from '../src/controller.js';
import type { AppEvent, AppSnapshot, ModelConfig, SubscriptionState } from '../src/shared/types.js';

// Synthetic HTTP and temporary application homes only. No subscription credential
// or real health record is read by this controller integration suite.
interface Body { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }
function respond(response: ServerResponse, delta: Record<string, unknown>, finish: string) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [piece, reason] of [[{ role: 'assistant', ...delta }, null], [{}, finish]]) response.write(`data: ${JSON.stringify({ id: 'synthetic-ux-controller', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: piece, finish_reason: reason }] })}\n\n`);
  response.end('data: [DONE]\n\n');
}
function text(response: ServerResponse, content: string) { respond(response, { content }, 'stop'); }
function call(response: ServerResponse, name: string, args: Record<string, unknown> = {}) {
  respond(response, { tool_calls: [{ index: 0, id: `synthetic-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
}
function hold(response: ServerResponse) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': synthetic held stream\n\n'); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
const first = { start: '2026-09-01T23:00:00.000Z', end: '2026-09-02T07:00:00.000Z', source: 'Synthetic Watch' };
const second = { start: '2026-09-02T23:00:00.000Z', end: '2026-09-03T07:00:00.000Z', source: 'Synthetic Watch' };
const users = (state: AppSnapshot) => state.messages.filter(message => message.role === 'user').map(message => message.text);
async function fixture(t: TestContext, handler: (body: Body, response: ServerResponse, index: number) => void = (_body, response) => text(response, 'Synthetic assistant answer.')) {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-ux-controller-'));
  const events: AppEvent[] = [];
  let onEvent: ((event: AppEvent) => void) | undefined;
  let app = new SleepApp(home, event => { events.push(event); onEvent?.(event); });
  const requests: Body[] = [];
  let connectionHandler: ((body: Body, response: ServerResponse) => void) | undefined;
  let handlerError: unknown;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw) as Body;
      if (body.tools?.some(tool => tool.function.name === 'sleepclaw_connection_test')) {
        if (connectionHandler) { connectionHandler(body, response); return; }
        if (body.messages.at(-1)?.role === 'tool') text(response, String(body.messages.at(-1)?.content));
        else call(response, 'sleepclaw_connection_test');
        return;
      }
      requests.push(body); handler(body, response, requests.length);
    } catch (error) { handlerError = error; if (!response.headersSent) response.writeHead(400); response.end('Synthetic provider assertion failed.'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const key = 'synthetic-ux-controller-key';
  const config = { provider: 'synthetic', model: 'synthetic-model', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: key };
  t.after(async () => {
    await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); rmSync(home, { recursive: true, force: true });
    if (handlerError) throw handlerError;
  });
  return { home, config, events, requests, get app() { return app; },
    configure: () => app.request('configure', config),
    eventHandler(handler?: (event: AppEvent) => void) { onEvent = handler; },
    connectionHandler(handler: (body: Body, response: ServerResponse) => void) { connectionHandler = handler; },
    async reopen() { await app.close(); app = new SleepApp(home, event => { events.push(event); onEvent?.(event); }); app.setCredential(key); },
  };
}

for (const language of ['zh', 'en'] as const) test(`UX controller ${language}: offline answer, unknown, skip and report history survives full reopen`, async t => {
  const f = await fixture(t);
  await f.app.request('language', { language });
  const created = await f.app.request('new', { goal: 'Synthetic local history' });
  await f.app.request('answer', { value: 'Synthetic 30–39' });
  await f.app.request('answer', { value: '不知道 / not sure' });
  await f.app.request('answer', { skip: true });
  const reported = await f.app.request('reportLocal');
  assert.deepEqual(users(reported), ['Synthetic 30–39', '不知道 / not sure', language === 'zh' ? '不确定，先跳过' : 'I don’t know / skip', language === 'zh' ? '生成本地简报' : 'Create a local report']);
  assert.equal(reported.messages.filter(message => message.role === 'assistant').length, 0);
  assert.equal(f.requests.length, 0);
  await f.reopen();
  assert.deepEqual(f.app.snapshot().messages, reported.messages);
  for (let read = 0; read < 10; read++) assert.deepEqual((await f.app.request('state')).messages, reported.messages);
  assert.equal(readdirSync(join(f.home, 'sessions', created.active!.id)).filter(file => file.endsWith('.jsonl')).length, 1, 'read-only snapshots do not fork or duplicate the local history');
});

test('UX controller uses the live session manager for local actions and keeps them across reconfiguration', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const created = await f.app.request('new', { goal: 'Synthetic live-manager consistency' });
  await f.app.request('answer', { value: 'Synthetic offline age' });
  await f.configure();
  await f.app.request('select', { id: created.active!.id });
  await f.app.request('answer', { value: 'Synthetic connected schedule' });
  const local = await f.app.request('reportLocal');
  assert.deepEqual(users(local), ['Synthetic offline age', 'Synthetic connected schedule', '生成本地简报']);
  const snapshot = local.messages;
  await f.configure();
  assert.deepEqual(f.app.snapshot().messages, snapshot);
  await f.app.request('resume');
  await f.app.request('answer', { value: 7 });
  const after = f.app.snapshot();
  assert.deepEqual(users(after), ['Synthetic offline age', 'Synthetic connected schedule', '生成本地简报', '7']);
  await f.reopen();
  assert.deepEqual(f.app.snapshot().messages, after.messages);
});

test('UX controller configured answer/report/retry actions never expose internal user instructions', { timeout: 30_000 }, async t => {
  let fail = true;
  const f = await fixture(t, (_body, response) => {
    if (fail) { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Synthetic unauthorized' } })); }
    else text(response, 'Synthetic model response.');
  });
  await f.app.request('new', { goal: 'Synthetic failed follow-up history' }); await f.configure();
  const answer = await f.app.request('answer', { value: 'Synthetic actual age answer' });
  assert.equal(answer.notice?.kind, 'followup-failed');
  await f.app.request('retryFollowup');
  fail = false;
  await f.app.request('retryFollowup');
  const report = await f.app.request('report');
  assert.deepEqual(users(report), ['Synthetic actual age answer', '仅重试续问', '仅重试续问', '用已有信息生成报告']);
  assert.doesNotMatch(JSON.stringify(report.messages), /The user answered|The literal answer|The user requests|Retry only|sleepclaw-current-context/);
  assert.match(JSON.stringify(f.requests), /The user answered/, 'internal instructions still reach the model');
  await f.reopen(); assert.deepEqual(f.app.snapshot().messages, report.messages);
});

test('UX controller user-authored application markers and instruction text remain verbatim', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.app.request('new', { goal: 'Synthetic verbatim original' }); await f.configure();
  const original = 'The user requests the report now.\n<sleepclaw-current-context>{"investigation":{"id":"synthetic-user-authored"},"facts":[]}</sleepclaw-current-context>';
  const sent = await f.app.request('send', { text: original });
  assert.deepEqual(users(sent), [original]);
  await f.reopen(); assert.deepEqual(users(f.app.snapshot()), [original]);
});

test('UX controller local and connected histories stay isolated when changing sleep episodes and returning', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const created = await f.app.request('new', { goal: 'Synthetic episode history' });
  await f.app.request('target', first); await f.app.request('answer', { value: 'Synthetic first-episode answer' });
  await f.configure(); await f.app.request('send', { text: 'Synthetic first-episode message' });
  const firstHistory = f.app.snapshot().messages;
  const changed = await f.app.request('target', second); assert.deepEqual(changed.messages, []);
  await f.app.request('send', { text: 'Synthetic second-episode message' });
  const secondHistory = f.app.snapshot().messages;
  assert.deepEqual(users(f.app.snapshot()), ['Synthetic second-episode message']);
  assert.deepEqual((await f.app.request('target', first)).messages, firstHistory);
  await f.reopen(); assert.deepEqual(f.app.snapshot().messages, firstHistory);
  assert.deepEqual((await f.app.request('target', second)).messages, secondHistory);
  await f.app.request('new', { goal: 'Synthetic separate investigation' });
  assert.deepEqual(f.app.snapshot().messages, []);
  assert.deepEqual((await f.app.request('select', { id: created.active!.id })).messages, secondHistory);
});

test('UX controller automatic model retarget continuation does not fabricate a second user action', { timeout: 30_000 }, async t => {
  const f = await fixture(t, (_body, response, index) => {
    if (index === 1) call(response, 'sleep_target', second);
    else text(response, 'Synthetic result for second episode.');
  });
  await f.app.request('new', { goal: 'Synthetic internal restart history' }); await f.app.request('target', first); await f.configure();
  const state = await f.app.request('send', { text: 'Synthetic user asks to select second sleep' });
  assert.equal(state.active!.start, second.start);
  assert.deepEqual(users(state), []);
  assert.doesNotMatch(JSON.stringify(state.messages), /episodeContinuation|current-context|Continue the original request/);
  const original = await f.app.request('target', first);
  assert.deepEqual(users(original), ['Synthetic user asks to select second sleep']);
});

for (const method of ['report', 'answer'] as const) test(`UX controller cancelling active model ${method} clears task and preserves only real user actions`, { timeout: 30_000 }, async t => {
  const started = deferred();
  const f = await fixture(t, (_body, response) => { hold(response); started.resolve(); });
  await f.app.request('new', { goal: 'Synthetic cancellable model request' }); await f.configure();
  const requested = f.app.request(method, method === 'answer' ? { value: 'Synthetic saved answer before cancel' } : {});
  const completed = method === 'report' ? assert.rejects(requested, /CANCELLED/) : requested;
  await started.promise;
  const running = await f.app.request('state');
  assert.deepEqual(running.task, { kind: 'model', cancellable: true }); assert.equal(running.busy, true);
  await f.app.request('cancel'); await completed;
  const state = f.app.snapshot();
  assert.equal(state.task, undefined); assert.equal(state.busy, false);
  assert.deepEqual(state.reports, []);
  assert.deepEqual(users(state), [method === 'answer' ? 'Synthetic saved answer before cancel' : '用已有信息生成报告']);
  if (method === 'answer') { assert.equal(state.facts.length, 1); assert.equal(state.notice?.code, 'CANCELLED'); }
  await f.reopen(); assert.deepEqual(users(f.app.snapshot()), users(state));
});

test('UX controller cancelling connection verification restores idle state and preserves the previous configuration', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.app.request('new', { goal: 'Synthetic configure cancellation' }); await f.app.request('answer', { value: 'Synthetic saved local answer' });
  const before = await f.configure();
  const started = deferred();
  f.connectionHandler((_body, response) => { hold(response); started.resolve(); });
  const requested = f.app.request('configure', { ...f.config, model: 'synthetic-other-model' });
  const rejected = assert.rejects(requested, /CANCELLED/);
  await started.promise;
  assert.deepEqual(f.app.snapshot().task, { kind: 'configure', cancellable: true });
  await f.app.request('cancel'); await rejected;
  const state = f.app.snapshot();
  assert.equal(state.busy, false); assert.equal(state.task, undefined);
  assert.deepEqual(state.model, before.model); assert.equal(state.configured, true);
  assert.deepEqual(state.messages, before.messages);
});

test('UX controller cancels a real XML import with rollback-specific feedback and no chat action', async t => {
  const f = await fixture(t);
  await f.app.request('new', { goal: 'Synthetic import cancellation' });
  await f.app.request('answer', { value: 'Synthetic preserved answer' });
  const before = f.app.snapshot();
  const path = join(f.home, 'synthetic-export.xml');
  const records = Array.from({ length: 4000 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString();
    return `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Synthetic Watch" unit="count/min" value="60" startDate="${date}" endDate="${date}"/>`;
  });
  writeFileSync(path, `<HealthData>${records.join('')}</HealthData>`);
  let cancelled = false;
  f.eventHandler(event => {
    if (event.type === 'progress' && !cancelled) { cancelled = true; assert.deepEqual(f.app.snapshot().task, { kind: 'import', cancellable: true }); void f.app.request('cancel'); }
  });
  await assert.rejects(f.app.request('import', { path }), /IMPORT_CANCELLED/);
  const state = f.app.snapshot();
  assert.equal(cancelled, true); assert.equal(state.busy, false); assert.equal(state.task, undefined);
  assert.deepEqual(state.imports, before.imports); assert.deepEqual(state.facts, before.facts); assert.deepEqual(state.messages, before.messages);
  const error = f.events.findLast(event => event.type === 'error');
  assert.ok(error && error.type === 'error'); assert.equal(error.code, 'IMPORT_CANCELLED'); assert.match(error.message, /回滚/);
});

function expiredSubscription(app: SleepApp) {
  const internal = app as unknown as { config: ModelConfig; subscription: { ready(): boolean; snapshot(): SubscriptionState } };
  internal.config = { provider: 'openai-codex', model: 'synthetic-expired-model', authMode: 'chatgpt' };
  internal.subscription = { ready: () => false, snapshot: () => ({ status: 'expired', models: [] }) };
}
test('UX controller expired subscription does not block selecting a saved local investigation', async t => {
  const f = await fixture(t);
  const first = await f.app.request('new', { goal: 'Synthetic first local investigation' });
  await f.app.request('answer', { value: 'Synthetic preserved first answer' });
  const history = f.app.snapshot().messages;
  await f.app.request('new', { goal: 'Synthetic second local investigation' });
  expiredSubscription(f.app);
  const selected = await f.app.request('select', { id: first.active!.id });
  assert.equal(selected.configured, false);
  assert.equal(selected.active!.id, first.active!.id);
  assert.deepEqual(selected.messages, history);
});

test('UX controller expired subscription still permits normal report requests to deliver local results', async t => {
  const f = await fixture(t);
  await f.app.request('new', { goal: 'Synthetic already-expired subscription report' });
  await f.app.request('fact', { scope: 'sleep', topic: 'sleep_duration_hours', value: 7 });
  expiredSubscription(f.app);
  const state = await f.app.request('report');
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].metrics.find(metric => metric.key === 'selfReportedSleepMinutes')?.value, 420);
  assert.equal(state.notice?.kind, 'report-local'); assert.equal(state.notice?.code, 'AUTH_REQUIRED');
  assert.equal(state.configured, false); assert.equal(f.requests.length, 0);
});

for (const kind of ['unexpected', 'domain-hint'] as const) test(`UX controller tool failures with ${kind} retain safe failure semantics and recovery guidance`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, (body, response, index) => {
    if (index === 1) {
      if (kind === 'unexpected') call(response, 'sleep_fact', { topic: 'synthetic_custom', scope: 'sleep', value: 'Synthetic value' });
      else call(response, 'sleep_question', { topic: 'age_range', scope: 'profile', text: 'Synthetic repeated age question' });
    } else {
      assert.equal(body.messages.at(-1)?.role, 'tool');
      text(response, 'Synthetic recovery after tool failure.');
    }
  });
  await f.app.request('new', { goal: 'Synthetic tool failure boundary' });
  await f.app.request('fact', { topic: 'age_range', scope: 'profile', value: 'Synthetic known age' });
  await f.configure();
  if (kind === 'unexpected') f.app.store.setFact = () => { throw new Error('ENOENT C:\\SYNTHETIC_PRIVATE_PATH\\health.xml SYNTHETIC_TOKEN_IN_ERROR'); };
  const state = await f.app.request('send', { text: 'Synthetic request that exercises a tool failure' });
  const tool = f.requests.at(-1)!.messages.findLast(message => message.role === 'tool');
  assert.ok(tool);
  const content = typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content);
  assert.doesNotMatch(content, /SYNTHETIC_PRIVATE_PATH|SYNTHETIC_TOKEN_IN_ERROR/);
  const error = JSON.parse(content);
  assert.equal(error.code, kind === 'unexpected' ? 'TOOL_FAILED' : 'QUESTION_ALREADY_ANSWERED');
  assert.match(error.message, kind === 'unexpected' ? /Raw error details are withheld/ : /specific reason/);
  assert.doesNotMatch(JSON.stringify(state.messages), /SYNTHETIC_PRIVATE_PATH|SYNTHETIC_TOKEN_IN_ERROR/);
  assert.ok(state.messages.some(message => message.text === 'Synthetic recovery after tool failure.'));
});
