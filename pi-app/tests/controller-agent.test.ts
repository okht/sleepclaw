import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { SleepApp } from '../src/controller.js';
import type { AppEvent } from '../src/shared/types.js';

interface Body { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }
function frame(response: ServerResponse, delta: Record<string, unknown>, finish: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: 'synthetic-investigation', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function text(response: ServerResponse, value: string) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  frame(response, { role: 'assistant', content: value }); frame(response, {}, 'stop'); response.end('data: [DONE]\n\n');
}
function tool(response: ServerResponse, name: string, args: Record<string, unknown> = {}) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  frame(response, { role: 'assistant', tool_calls: [{ index: 0, id: `synthetic-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  frame(response, {}, 'tool_calls'); response.end('data: [DONE]\n\n');
}

test('real Pi drives read → question → saved answer → narrower reread → deterministic report and resumes', { timeout: 30_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'sleepclaw-controller-agent-test-'));
  const requests: Body[] = [];
  const events: AppEvent[] = [];
  let handlerError: unknown;
  let app: SleepApp | undefined;
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw) as Body;
      requests.push(body);
      const last = body.messages.at(-1);
      switch (requests.length) {
        case 1: tool(response, 'sleepclaw_connection_test'); break;
        case 2: assert.equal(last?.role, 'tool'); text(response, String(last?.content)); break;
        case 3: tool(response, 'sleep_data_query'); break;
        case 4: {
          assert.equal(last?.role, 'tool');
          const result = JSON.parse(String(last?.content));
          assert.equal(result.analysis.metrics.find((metric: { key: string }) => metric.key === 'totalSleepMinutes').value, 390);
          assert.equal(result.analysis.metrics.find((metric: { key: string }) => metric.key === 'awakeMinutes').value, 30);
          tool(response, 'sleep_question', { topic: 'night_noise', text: 'Did noise wake you around 02:00?', reason: 'The device recorded an interruption then.', scope: 'sleep' });
          break;
        }
        case 5: text(response, 'Did noise wake you around 02:00?'); break;
        case 6: {
          assert.equal(last?.role, 'user');
          assert.match(JSON.stringify(last?.content), /Noise woke me around 02:00/);
          tool(response, 'sleep_data_query', { start: '2026-09-21T02:00:00+08:00', end: '2026-09-21T04:00:00+08:00', type: 'sleep' });
          break;
        }
        case 7: {
          assert.equal(last?.role, 'tool');
          const result = JSON.parse(String(last?.content));
          assert.equal(result.analysis.metrics.find((metric: { key: string }) => metric.key === 'totalSleepMinutes').value, 90);
          assert.equal(result.analysis.start, '2026-09-21T02:00:00+08:00');
          tool(response, 'sleep_report', { interpretation: 'A recorded interruption coincided with the noise you reported. This observation does not establish causation.', action: 'Try reducing bedroom noise tonight, then check whether interruptions change.' });
          break;
        }
        case 8: text(response, 'The synthetic report is ready.'); break;
        default: throw new Error(`Unexpected model request ${requests.length}`);
      }
    } catch (error) {
      handlerError = error;
      t.diagnostic(`Synthetic mock request ${requests.length}: ${String(error)}`);
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic mock assertion failed.' } }));
    }
  });
  t.after(async () => {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    if (handlerError) throw handlerError;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  app = new SleepApp(home, (event) => events.push(event));
  await app.request('language', { language: 'en' });
  const created = await app.request('new', { goal: 'Explain this synthetic interruption.' });
  const investigationId = created.active!.id;
  const path = join(home, 'synthetic-export.xml');
  const part = (state: string, start: string, end: string) => `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Synthetic Watch" value="HKCategoryValueSleepAnalysis${state}" startDate="${start} +0800" endDate="${end} +0800"/>`;
  await writeFile(path, `<HealthData>${part('AsleepCore', '2026-09-20 23:00:00', '2026-09-21 02:00:00')}${part('Awake', '2026-09-21 02:00:00', '2026-09-21 02:30:00')}${part('AsleepCore', '2026-09-21 02:30:00', '2026-09-21 06:00:00')}</HealthData>`);
  const imported = await app.request('import', { path });
  assert.equal(imported.candidates.length, 1);
  await app.request('target', { ...imported.candidates[0] });
  const syntheticKey = 'synthetic-controller-key-no-real-credentials';
  await app.request('configure', { provider: 'local-synthetic', model: 'synthetic-model', protocol: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: syntheticKey });
  assert.equal(requests.length, 2);
  assert.ok(!JSON.stringify(requests).includes('Synthetic Watch'), 'connection check must not include imported health data');
  const questioned = await app.request('send', { text: 'Why did I wake during this sleep?' });
  assert.equal(questioned.question?.topic, 'night_noise');
  assert.equal(requests.length, 5);
  const finished = await app.request('answer', { value: 'Noise woke me around 02:00.' });
  if (handlerError) throw handlerError;
  assert.equal(requests.length, 8);
  assert.equal(finished.busy, false);
  assert.equal(finished.question, undefined);
  const fact = finished.facts.find((fact) => fact.topic === 'night_noise');
  assert.equal(fact?.value, 'Noise woke me around 02:00.');
  assert.equal(fact?.scope, 'sleep');
  assert.equal(finished.reports.length, 1);
  const report = finished.reports[0];
  assert.equal(report.metrics.find((metric) => metric.key === 'totalSleepMinutes')?.value, 390, 'report keeps the full episode, not the last narrow query');
  assert.match(report.aiInterpretation ?? '', /does not establish causation/);
  assert.match(report.action, /reducing bedroom noise/);
  assert.equal(report.score, null);
  assert.ok(!JSON.stringify(requests).includes('<HealthData>'));
  assert.ok(!JSON.stringify(requests).includes(path));
  assert.ok(!JSON.stringify(finished).includes(syntheticKey));
  assert.ok(!JSON.stringify(finished.messages).includes('sleepclaw-current-context'));
  assert.ok(!((await readFile(join(home, 'settings.json'), 'utf8')).includes(syntheticKey)));
  assert.ok(events.some((event) => event.type === 'progress' && event.message === 'sleep_data_query'));
  assert.ok(events.some((event) => event.type === 'delta' && event.text.includes('report is ready')));
  const previousMessageCount = finished.messages.length;
  await app.close();
  app = new SleepApp(home);
  app.setCredential(syntheticKey);
  const resumed = await app.request('select', { id: investigationId });
  assert.equal(resumed.messages.length, previousMessageCount);
  assert.equal(resumed.facts.find((saved) => saved.id === fact!.id)?.value, fact!.value);
  assert.equal(resumed.reports[0].id, report.id);
  assert.equal(requests.length, 8, 'resuming a session must not call a remote model');
  const unrelated = (await app.request('new', { goal: 'Synthetic unrelated analysis' })).active!;
  await app.request('select', { id: investigationId });
  const disposal = t.mock.method(AgentSession.prototype, 'dispose');
  const kept = await app.request('delete', { id: unrelated.id });
  assert.equal(disposal.mock.callCount(), 0, 'deleting another analysis must not dispose the current Pi session');
  assert.equal(kept.active?.id, investigationId);
  assert.equal(kept.messages.length, previousMessageCount);
  const emptied = await app.request('delete', { id: investigationId });
  assert.equal(disposal.mock.callCount(), 1, 'deleting the selected analysis disposes its Pi session');
  assert.equal(emptied.active, undefined);
  assert.deepEqual(emptied.messages, []);
  assert.equal(requests.length, 8, 'deletion must not call a remote model');
});

test('a model claiming success without calling sleep_report produces an honest local brief', { timeout: 30_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'sleepclaw-report-fallback-test-'));
  const events: AppEvent[] = [];
  let calls = 0;
  let app: SleepApp | undefined;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk.toString();
    const body = JSON.parse(raw) as Body;
    calls++;
    if (calls === 1) tool(response, 'sleepclaw_connection_test');
    else if (calls === 2) text(response, String(body.messages.at(-1)?.content));
    else text(response, 'Your report is ready.');
  });
  t.after(async () => {
    await app?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  app = new SleepApp(home, event => events.push(event));
  await app.request('new', { goal: 'Synthetic report fallback' });
  await app.request('fact', { topic: 'sleep_duration_hours', value: 6, scope: 'sleep' });
  await app.request('configure', { provider: 'openai', model: 'synthetic', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'synthetic-key' });
  const state = await app.request('report');
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].aiInterpretation, undefined);
  assert.equal(state.reports[0].metrics.find(metric => metric.key === 'selfReportedSleepMinutes')?.value, 360);
  assert.equal(state.question, undefined);
  assert.ok(events.some(event => event.type === 'progress' && event.message.includes('未加入 AI 解读')));
});
