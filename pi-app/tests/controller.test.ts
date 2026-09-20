import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SleepApp } from '../src/controller.js';
import type { AppEvent } from '../src/shared/types.js';

function fixture(onEvent?: (event: AppEvent) => void) {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-controller-test-'));
  const events: AppEvent[] = [];
  const app = new SleepApp(home, event => { events.push(event); onEvent?.(event); });
  return { home, app, events, cleanup: async () => { await app.close(); rmSync(home, { recursive: true, force: true }); } };
}
function writeExport(home: string): string {
  const path = join(home, 'export.xml');
  writeFileSync(path, '<HealthData><Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Synthetic Watch" startDate="2026-09-20 23:00:00 +0800" endDate="2026-09-21 06:00:00 +0800" value="HKCategoryValueSleepAnalysisAsleepCore"/></HealthData>');
  return path;
}

test('no-model first journey saves one precise question, returns idle state and generates an early report', async () => {
  const { app, events, cleanup } = fixture();
  try {
    let state = await app.request('new', { goal: '昨晚为什么还是累？' });
    assert.equal(state.configured, false);
    assert.equal(state.busy, false);
    assert.equal(state.question?.topic, 'age_range');
    const firstQuestionId = state.question!.id;
    assert.equal((await app.request('state')).question?.id, firstQuestionId);
    state = await app.request('answer', { value: null, skip: true });
    assert.equal(state.question?.topic, 'usual_schedule');
    assert.equal(state.facts.find(f => f.topic === 'age_range')?.status, 'unknown');
    await app.request('fact', { topic: 'sleep_duration_hours', value: 6.5, scope: 'sleep' });
    state = await app.request('report');
    assert.equal(state.question, undefined);
    assert.equal(state.active?.status, 'reported');
    assert.equal(state.reports.length, 1);
    assert.equal(state.reports[0].score, null);
    assert.equal(state.reports[0].metrics.find(m => m.key === 'selfReportedSleepMinutes')?.value, 390);
    assert.equal(state.busy, false);
    assert.ok(events.some(event => event.type === 'state' && event.state.busy));
    assert.equal((events.at(-1) as Extract<AppEvent, { type: 'state' }>).state.busy, false);
  } finally { await cleanup(); }
});

test('no-model restart retains selection, language and exact pending question without rebuilding the profile', async () => {
  const { home, app, cleanup } = fixture();
  let restored: SleepApp | undefined;
  try {
    const created = await app.request('new', { goal: '继续上次的调查' });
    const id = created.active!.id;
    await app.request('answer', { value: '30–40' });
    const before = await app.request('language', { language: 'en' });
    assert.equal(before.active?.language, 'en');
    assert.match(before.question!.text, /usually/);
    restored = new SleepApp(home);
    const state = await restored.request('state');
    assert.equal(state.language, 'en');
    assert.equal(state.active?.id, id);
    assert.equal(state.question?.id, before.question?.id);
    assert.equal(state.question?.text, before.question?.text);
    assert.equal(state.facts.find(f => f.topic === 'age_range')?.value, '30–40');
  } finally { await restored?.close(); await cleanup(); }
});

test('import, explicit target, report correction and deletion keep canonical state consistent', async () => {
  const { home, app, cleanup } = fixture();
  try {
    let state = await app.request('new', { goal: '分析这份设备记录' });
    const id = state.active!.id;
    state = await app.request('import', { path: writeExport(home) });
    assert.equal(state.imports.length, 1);
    assert.equal(state.active?.start, undefined, 'import must not silently select the latest sleep');
    const candidate = state.candidates[0];
    state = await app.request('target', { ...candidate });
    assert.equal(state.active?.source, 'Synthetic Watch');
    state = await app.request('report');
    const first = state.reports[0];
    assert.equal(first.metrics.find(m => m.key === 'totalSleepMinutes')?.value, 420);
    state = await app.request('fact', { topic: 'recovery', value: '依然很累', scope: 'sleep' });
    assert.equal(state.reports.find(r => r.id === first.id)?.status, 'stale');
    state = await app.request('report');
    assert.equal(state.reports[0].revision, 2);
    const importId = state.imports[0].id;
    const reportPath = join(home, 'reports', `${state.reports[0].id}.json`);
    assert.ok(existsSync(reportPath));
    state = await app.request('delete', { id });
    assert.equal(state.investigations.length, 0);
    assert.equal(state.reports.length, 0);
    assert.equal(existsSync(reportPath), false);
    assert.equal(state.imports.length, 1, 'shared imports survive investigation deletion');
    state = await app.request('deleteImport', { id: importId });
    assert.equal(state.imports.length, 0);
    assert.equal(state.candidates.length, 0);
  } finally { await cleanup(); }
});

test('bad import preserves facts and failed no-model chat can resume other local actions', async () => {
  const { home, app, cleanup } = fixture();
  try {
    await app.request('new', { goal: '今晚睡眠' });
    await app.request('answer', { value: 'adult' });
    const before = app.snapshot();
    const broken = join(home, 'bad.xml');
    writeFileSync(broken, '<HealthData><Record');
    await assert.rejects(app.request('import', { path: broken }));
    assert.equal(app.snapshot().facts.length, before.facts.length);
    assert.equal(app.snapshot().question?.id, before.question?.id);
    assert.equal(app.snapshot().imports.length, 0);
    assert.equal(app.snapshot().busy, false);
    await assert.rejects(app.request('send', { text: '请继续' }), /MODEL_REQUIRED/);
    assert.equal(app.snapshot().busy, false);
    assert.equal((await app.request('report')).reports.length, 1);
  } finally { await cleanup(); }
});

test('deleting recent investigations preserves another selection and falls back until the list is empty', async () => {
  const { home, app, cleanup } = fixture();
  let restored: SleepApp | undefined;
  try {
    const first = (await app.request('new', { goal: 'Synthetic first analysis' })).active!;
    const second = (await app.request('new', { goal: 'Synthetic second analysis' })).active!;
    const third = (await app.request('new', { goal: 'Synthetic third analysis' })).active!;
    await app.request('select', { id: first.id });
    const before = app.snapshot();
    const sessionDirectories = [first, second, third].map(investigation => join(home, 'sessions', investigation.id));
    for (const directory of sessionDirectories) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'synthetic-marker'), 'synthetic conversation');
    }
    let state = await app.request('delete', { id: second.id });
    assert.equal(state.active?.id, first.id, 'deleting an unselected analysis keeps the selected analysis');
    assert.equal(state.question?.id, before.question?.id);
    assert.equal(existsSync(sessionDirectories[1]), false);
    assert.equal(existsSync(sessionDirectories[0]), true);
    assert.equal(existsSync(sessionDirectories[2]), true);
    state = await app.request('delete', { id: first.id });
    assert.equal(state.active?.id, third.id);
    assert.equal(existsSync(sessionDirectories[0]), false);
    assert.equal(existsSync(sessionDirectories[2]), true);
    restored = new SleepApp(home);
    assert.equal(restored.snapshot().active?.id, third.id, 'fallback selection survives restart');
    await restored.close(); restored = undefined;
    state = await app.request('delete', { id: third.id });
    assert.equal(state.investigations.length, 0);
    assert.equal(state.active, undefined);
    assert.equal(state.question, undefined);
    assert.deepEqual(state.messages, []);
    assert.equal(state.busy, false);
    assert.equal(existsSync(sessionDirectories[2]), false);
  } finally { await restored?.close(); await cleanup(); }
});

test('concurrent mutations are rejected and cancelling a streamed import leaves no partial records', async () => {
  let appReference: SleepApp | undefined;
  let cancelled = false;
  const { home, app, cleanup } = fixture(event => {
    if (event.type === 'progress' && !cancelled) { cancelled = true; void appReference!.request('cancel'); }
  });
  appReference = app;
  try {
    await app.request('new', { goal: 'test cancellation' });
    const path = join(home, 'large.xml');
    const records = Array.from({ length: 2000 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 8, 20, 0, 0, i)).toISOString();
      return `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Synthetic Watch" unit="count/min" value="60" startDate="${date}" endDate="${date}"/>`;
    });
    writeFileSync(path, `<HealthData>${records.join('')}</HealthData>`);
    const importing = app.request('import', { path });
    await assert.rejects(app.request('fact', { topic: 'recovery', value: 'fine', scope: 'sleep' }), /BUSY/);
    await assert.rejects(importing, /CANCELLED/);
    assert.equal(cancelled, true);
    assert.equal(app.snapshot().imports.length, 0);
    assert.equal(app.store.getRecords().length, 0);
    assert.equal(app.snapshot().busy, false);
    const state = await app.request('import', { path: writeExport(home) });
    assert.equal(state.imports.length, 1);
  } finally { await cleanup(); }
});

test('a failed deletion with an unknown id must not discard unrelated Pi sessions', async () => {
  const { home, app, cleanup } = fixture();
  try {
    const state = await app.request('new', { goal: 'keep my saved conversation' });
    const directory = join(home, 'sessions', state.active!.id);
    mkdirSync(directory, { recursive: true });
    const marker = join(directory, 'saved-session.jsonl');
    writeFileSync(marker, '{"synthetic":true}\n');
    await assert.rejects(app.request('deleteFact', { id: 'unknown-fact' }));
    assert.ok(existsSync(marker));
    await assert.rejects(app.request('deleteImport', { id: 'unknown-import' }));
    await assert.rejects(app.request('delete', { id: 'unknown-investigation' }));
    assert.equal(readFileSync(marker, 'utf8'), '{"synthetic":true}\n');
    assert.equal(app.snapshot().investigations.length, 1);
  } finally { await cleanup(); }
});

test('worker message protocol boots, correlates replies, forwards state and closes without a model', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-worker-test-'));
  type Message = { id: string; method: string; params?: Record<string, unknown> };
  type Reply = { id?: string; value?: unknown; error?: string; event?: AppEvent };
  let receive: ((event: { data: Message }) => Promise<void> | void) | undefined;
  const replies: Reply[] = [];
  const runtime = process as unknown as { parentPort?: unknown };
  const previousPort = runtime.parentPort;
  runtime.parentPort = {
    on: (_name: string, callback: typeof receive) => { receive = callback; },
    postMessage: (reply: Reply) => replies.push(reply),
  };
  let closed = false;
  try {
    await import('../src/worker.js');
    assert.ok(receive);
    await receive({ data: { id: 'boot', method: 'boot', params: { home } } });
    assert.ok(replies.find(reply => reply.id === 'boot' && reply.value));
    await receive({ data: { id: 'new', method: 'new', params: { goal: 'Worker test' } } });
    assert.ok(replies.some(reply => reply.event?.type === 'state'));
    await receive({ data: { id: 'report', method: 'report' } });
    const reportState = replies.find(reply => reply.id === 'report')!.value as { reports: unknown[]; question?: unknown; busy: boolean };
    assert.equal(reportState.reports.length, 1);
    assert.equal(reportState.question, undefined);
    assert.equal(reportState.busy, false);
    await receive({ data: { id: 'invalid', method: 'unsupported' } });
    assert.equal(replies.find(reply => reply.id === 'invalid')?.error, 'UNKNOWN_METHOD');
    await receive({ data: { id: 'close', method: 'close' } });
    assert.ok(replies.some(reply => reply.id === 'close' && !reply.error));
    closed = true;
  } finally {
    if (!closed && receive) await receive({ data: { id: 'cleanup', method: 'close' } });
    if (previousPort === undefined) delete runtime.parentPort; else runtime.parentPort = previousPort;
    rmSync(home, { recursive: true, force: true });
  }
});

test('actual deletion clears model history before domain export cleanup can fail', async () => {
  const { home, app, cleanup } = fixture();
  try {
    await app.request('new', { goal: 'Synthetic deletion failure' });
    const state = await app.request('fact', { topic: 'recovery', value: 'sensitive synthetic fact', scope: 'sleep' });
    const sessions = join(home, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const marker = join(sessions, 'previous-health-conversation.jsonl');
    writeFileSync(marker, 'synthetic');
    app.store.deleteFact = () => {
      assert.equal(existsSync(marker), false, 'old model context must be gone even if a later export removal fails');
      throw new Error('EPERM');
    };
    await assert.rejects(app.request('deleteFact', { id: state.facts[0].id }));
    assert.equal(existsSync(marker), false);
    assert.equal(app.snapshot().busy, false);
  } finally { await cleanup(); }
});
