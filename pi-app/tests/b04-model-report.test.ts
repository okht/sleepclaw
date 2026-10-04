import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SleepApp } from '../src/controller.js';

// Real Pi sessions talk only to this local synthetic provider. No real model,
// subscription credentials, health records or external service are involved.
interface Body { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }
function respond(response: ServerResponse, delta: Record<string, unknown>, finish: string) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [piece, reason] of [[{ role: 'assistant', ...delta }, null], [{}, finish]]) {
    response.write(`data: ${JSON.stringify({ id: 'synthetic-b04', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: piece, finish_reason: reason }] })}\n\n`);
  }
  response.end('data: [DONE]\n\n');
}
function text(response: ServerResponse, content: string) { respond(response, { content }, 'stop'); }
function call(response: ServerResponse, name: string, args: Record<string, unknown> = {}) {
  respond(response, { tool_calls: [{ index: 0, id: `synthetic-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
}
async function fixture(t: TestContext, handler: (response: ServerResponse, index: number) => void) {
  const home = await mkdtemp(join(tmpdir(), 'sleepclaw-b04-model-'));
  const app = new SleepApp(home);
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
      requests.push(body);
      handler(response, requests.length);
    } catch (error) {
      handlerError = error;
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic B04 provider assertion failed.' } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => {
    await app.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep), 'only remove this synthetic fixture directory');
    await rm(home, { recursive: true, force: true });
    if (handlerError) throw handlerError;
  });
  return { app, home, requests,
    configure: () => app.request('configure', { provider: 'synthetic', model: 'synthetic-model', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'synthetic-b04-key-no-real-credentials' }),
  };
}

const followup = { topic: 'synthetic_context', scope: 'sleep', text: 'Synthetic follow-up that should be paused by a direct report request.', reason: 'Synthetic provider behavior.' };

for (const reasks of [false, true]) test(`B04 real Pi report reuse pauses a resumed question when the model ${reasks ? 'asks again' : 'returns text without a report tool'}`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, (response, index) => {
    if (reasks && index === 1) call(response, 'sleep_question', followup);
    else { assert.equal(index, reasks ? 2 : 1); text(response, 'Synthetic response without creating another report.'); }
  });
  const created = await f.app.request('new', { goal: 'Synthetic report reuse after explicit resume' });
  const id = created.active!.id;
  const saved = f.app.store.buildReport(id, 'Synthetic saved AI interpretation.', 'Synthetic saved AI action.');
  const path = join(f.home, 'reports', `${saved.id}.json`);
  const content = await readFile(path, 'utf8');
  const modified = (await stat(path)).mtimeMs;
  await f.configure();
  const resumed = await f.app.request('resume');
  assert.deepEqual(resumed.question, created.question);
  assert.equal(f.requests.length, 0, 'local continuation does not call the configured provider');
  const reported = await f.app.request('report');
  assert.equal(reported.question, undefined, 'a report request must stop active questioning even when reusing a report');
  assert.equal(reported.active!.status, 'reported');
  assert.equal(reported.canResume, true);
  assert.equal(reported.active!.revision, resumed.active!.revision);
  assert.deepEqual(reported.facts, resumed.facts);
  assert.deepEqual(reported.reports, resumed.reports, 'pausing must preserve the saved interpretation, action and report version');
  assert.equal(await readFile(path, 'utf8'), content);
  assert.equal((await stat(path)).mtimeMs, modified, 'state-only pausing must not rewrite exports');
  const paused = reported.active!.pausedQuestion!;
  assert.equal(paused.topic, reasks ? followup.topic : created.question!.topic);
  const beforeResumeCalls = f.requests.length;
  const again = await f.app.request('resume');
  assert.deepEqual(again.question, paused);
  assert.equal(f.requests.length, beforeResumeCalls);
});

for (const generates of [false, true]) test(`B04 real Pi direct report pauses a model follow-up ${generates ? 'after a generated AI report' : 'before local fallback'}`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, (response, index) => {
    if (generates && index === 1) call(response, 'sleep_report', { interpretation: 'Synthetic new AI interpretation.', action: 'Synthetic new AI action.' });
    else if (index === (generates ? 2 : 1)) call(response, 'sleep_question', followup);
    else { assert.equal(index, generates ? 3 : 2); text(response, 'Synthetic final provider response.'); }
  });
  const created = await f.app.request('new', { goal: 'Synthetic immediate report completion' });
  await f.configure();
  const reported = await f.app.request('report');
  assert.equal(reported.question, undefined);
  assert.equal(reported.active!.status, 'reported');
  assert.equal(reported.active!.pausedQuestion?.topic, followup.topic);
  assert.equal(reported.canResume, true);
  assert.equal(reported.active!.revision, created.active!.revision);
  assert.equal(reported.reports.length, 1);
  assert.equal(reported.reports[0].status, 'complete');
  assert.equal(reported.reports[0].aiInterpretation, generates ? 'Synthetic new AI interpretation.' : undefined);
  const beforeResumeCalls = f.requests.length;
  const resumed = await f.app.request('resume');
  assert.deepEqual(resumed.question, reported.active!.pausedQuestion);
  assert.deepEqual(resumed.reports, reported.reports);
  assert.equal(f.requests.length, beforeResumeCalls);
});
