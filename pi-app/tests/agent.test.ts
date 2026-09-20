import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { chatMessages, makeSession, publicError, testConnection, validateModelConfig } from '../src/agent.js';
import type { ModelConfig } from '../src/shared/types.js';

interface RequestBody { model: string; messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>; tools?: Array<{ type?: string; name?: string; function?: { name: string } }>; stream?: boolean }
type MockRequest = { body: RequestBody; url: string; authorization?: string; apiKey?: string };
type Handler = (request: MockRequest, response: ServerResponse) => void | Promise<void>;
const SYNTHETIC_KEY = 'synthetic-test-key-not-a-credential';

function begin(response: ServerResponse) { response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); }
function chunk(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: 'synthetic-completion', object: 'chat.completion.chunk', created: 1, model: 'mock-sleep-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}
function finish(response: ServerResponse) { response.end('data: [DONE]\n\n'); }
function respondText(response: ServerResponse, text: string) {
  begin(response); chunk(response, { role: 'assistant', content: text.slice(0, 2) }); chunk(response, { content: text.slice(2) }); chunk(response, {}, 'stop'); finish(response);
}
function respondTool(response: ServerResponse, name: string, args: Record<string, unknown> = {}) {
  begin(response);
  const serialized = JSON.stringify(args);
  chunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name, arguments: serialized.slice(0, 1) } }] });
  chunk(response, { tool_calls: [{ index: 0, function: { arguments: serialized.slice(1) } }] });
  chunk(response, {}, 'tool_calls'); finish(response);
}

function anthropicEvent(response: ServerResponse, type: string, payload: Record<string, unknown>) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}
function respondAnthropic(response: ServerResponse, value: { text: string } | { tool: string; args: Record<string, unknown> }) {
  begin(response);
  anthropicEvent(response, 'message_start', { message: { id: 'synthetic-anthropic', type: 'message', role: 'assistant', model: 'mock-sleep-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  if ('tool' in value) {
    anthropicEvent(response, 'content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'synthetic-anthropic-call', name: value.tool, input: {} } });
    anthropicEvent(response, 'content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(value.args) } });
  } else {
    anthropicEvent(response, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    anthropicEvent(response, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: value.text } });
  }
  anthropicEvent(response, 'content_block_stop', { index: 0 });
  anthropicEvent(response, 'message_delta', { delta: { stop_reason: 'tool' in value ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  anthropicEvent(response, 'message_stop', {});
  response.end();
}

async function fixture(handler: Handler) {
  const home = await mkdtemp(join(tmpdir(), 'sleepclaw-agent-test-'));
  const requests: MockRequest[] = [];
  let handlerError: unknown;
  const server = createServer(async (request: IncomingMessage, response) => {
    try {
      let content = '';
      for await (const chunk of request) content += chunk.toString();
      const received = { body: JSON.parse(content) as RequestBody, url: request.url ?? '', authorization: request.headers.authorization, apiKey: request.headers['x-api-key'] as string | undefined };
      requests.push(received);
      await handler(received, response);
    } catch (error) { handlerError = error; if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const config: ModelConfig = { provider: 'local-test', model: 'mock-sleep-model', apiKey: SYNTHETIC_KEY, baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: 'openai-completions' };
  return { home, requests, config, cleanup: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); if (handlerError) throw handlerError; } };
}

test('model configuration validates protocols, remote TLS, localhost, and URL credentials', () => {
  const model = { provider: ' openai ', model: ' test-model ', apiKey: ' synthetic ' };
  assert.deepEqual(validateModelConfig(model), { provider: 'openai', model: 'test-model', apiKey: 'synthetic', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-completions' });
  assert.equal(validateModelConfig({ ...model, provider: 'anthropic' }).protocol, 'anthropic-messages');
  assert.equal(validateModelConfig({ ...model, baseUrl: 'http://localhost:1234/v1/' }).baseUrl, 'http://localhost:1234/v1');
  for (const baseUrl of ['http://example.com/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?api_key=secret', 'https://example.com/v1#secret', 'file:///tmp/api']) {
    assert.throws(() => validateModelConfig({ ...model, baseUrl }), /BASE_URL_INVALID/);
  }
  assert.throws(() => validateModelConfig({ ...model, apiKey: '' }), /CONFIG_REQUIRED/);
  assert.throws(() => validateModelConfig({ ...model, model: 'x'.repeat(201) }), /CONFIG_INVALID/);
});

test('public errors redact upstream text, keys and personal-data payloads', () => {
  assert.equal(publicError(new DOMException('导入已取消。', 'AbortError'), 'zh').code, 'CANCELLED');
  const cases: Array<[string, string]> = [
    [`401 unauthorized: ${SYNTHETIC_KEY} personal-data-sentinel`, 'AUTH_FAILED'],
    [`429 quota ${SYNTHETIC_KEY}`, 'QUOTA'],
    [`404 model not found ${SYNTHETIC_KEY}`, 'MODEL_NOT_FOUND'],
    [`aborted ${SYNTHETIC_KEY}`, 'CANCELLED'],
    [`timeout ${SYNTHETIC_KEY}`, 'TIMEOUT'],
    [`unexpected JSON personal-data-sentinel ${SYNTHETIC_KEY}`, 'REQUEST_FAILED'],
    ['PRIVATE_HEALTH_SENTINEL', 'REQUEST_FAILED'],
  ];
  for (const [raw, code] of cases) for (const language of ['zh', 'en'] as const) {
    const value = publicError(new Error(raw), language);
    assert.equal(value.code, code);
    assert.ok(!JSON.stringify(value).includes(SYNTHETIC_KEY));
    assert.ok(!JSON.stringify(value).includes('personal-data-sentinel'));
  }
});

test('real Pi SDK streams text and tool calls against localhost, without builtin tools', { timeout: 20_000 }, async () => {
  let executions = 0;
  const tool = defineTool({ name: 'synthetic_sleep_measurement', label: 'Synthetic test', description: 'Synthetic data only.', parameters: Type.Object({ minutes: Type.Number() }), execute: async (_id, args) => { executions++; return { content: [{ type: 'text', text: JSON.stringify({ minutes: args.minutes }) }], details: {} }; } });
  const f = await fixture(({ body }, response) => {
    const last = body.messages.at(-1);
    if (last?.role === 'tool') respondText(response, 'Synthetic result: 420 minutes.');
    else respondTool(response, 'synthetic_sleep_measurement', { minutes: 420 });
  });
  const session = await makeSession(f.home, f.config, [tool]);
  try {
    const deltas: string[] = [];
    session.subscribe((event) => { if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') deltas.push(event.assistantMessageEvent.delta); });
    await session.prompt('Use synthetic_sleep_measurement with 420 and explain the result.');
    assert.equal(executions, 1);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(session.getActiveToolNames(), ['synthetic_sleep_measurement']);
    assert.deepEqual(f.requests[0].body.tools?.map((tool) => tool.function?.name), ['synthetic_sleep_measurement']);
    assert.equal(f.requests[0].url, '/v1/chat/completions');
    assert.equal(f.requests[0].authorization, `Bearer ${SYNTHETIC_KEY}`);
    assert.equal(deltas.join(''), 'Synthetic result: 420 minutes.');
    assert.equal(session.messages.at(-1)?.role, 'assistant');
    const modelFile = await readFile(join(f.home, 'pi', 'sleepclaw-models.json'), 'utf8');
    assert.ok(!modelFile.includes(SYNTHETIC_KEY));
  } finally { session.dispose(); await f.cleanup(); }
});

test('real Pi Anthropic Messages adapter streams tool_use and tool_result continuation', { timeout: 20_000 }, async () => {
  let executions = 0;
  const tool = defineTool({ name: 'synthetic_sleep_measurement', label: 'Synthetic test', description: 'Synthetic data only.', parameters: Type.Object({ minutes: Type.Number() }), execute: async (_id, args) => { executions++; return { content: [{ type: 'text', text: JSON.stringify({ minutes: args.minutes }) }], details: {} }; } });
  const f = await fixture(({ body }, response) => {
    const content = body.messages.at(-1)?.content;
    if (Array.isArray(content) && content.some((block) => block.type === 'tool_result')) respondAnthropic(response, { text: 'Anthropic synthetic result: 420 minutes.' });
    else respondAnthropic(response, { tool: 'synthetic_sleep_measurement', args: { minutes: 420 } });
  });
  const session = await makeSession(f.home, { ...f.config, protocol: 'anthropic-messages', baseUrl: f.config.baseUrl!.replace(/\/v1$/, '') }, [tool]);
  try {
    const deltas: string[] = [];
    session.subscribe((event) => { if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') deltas.push(event.assistantMessageEvent.delta); });
    await session.prompt('Call synthetic_sleep_measurement with 420.');
    assert.equal(executions, 1);
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests[0].url.startsWith('/v1/messages'));
    assert.equal(f.requests[0].apiKey, SYNTHETIC_KEY);
    assert.deepEqual(f.requests[0].body.tools?.map((entry) => entry.name), ['synthetic_sleep_measurement']);
    assert.equal(deltas.join(''), 'Anthropic synthetic result: 420 minutes.');
    const last = session.messages.findLast((message) => message.role === 'assistant');
    assert.equal(last?.stopReason, 'stop');
  } finally { session.dispose(); await f.cleanup(); }
});

test('real Pi session resumes persisted messages and strips internal context from displayed chat', { timeout: 20_000 }, async () => {
  const f = await fixture((_request, response) => respondText(response, 'Saved synthetic answer.'));
  const sessionDir = join(f.home, 'sessions', 'test-investigation');
  let session = await makeSession(f.home, f.config, [], sessionDir);
  try {
    await session.prompt('Synthetic first question.\n<sleepclaw-current-context>{"synthetic":true}</sleepclaw-current-context>');
    assert.ok((await readdir(sessionDir)).some((file) => file.endsWith('.jsonl')));
    session.dispose();
    session = await makeSession(f.home, f.config, [], sessionDir);
    assert.ok(chatMessages(session).some((message) => message.text === 'Synthetic first question.'));
    assert.ok(!JSON.stringify(chatMessages(session)).includes('sleepclaw-current-context'));
    await session.prompt('Continue the synthetic conversation.');
    const sent = JSON.stringify(f.requests.at(-1)?.body.messages);
    assert.match(sent, /Synthetic first question/);
    assert.match(sent, /Saved synthetic answer/);
  } finally { session.dispose(); await f.cleanup(); }
});

test('connection check requires tool execution plus streamed text', { timeout: 20_000 }, async () => {
  const f = await fixture(({ body }, response) => {
    const last = body.messages.at(-1);
    if (last?.role === 'tool') respondText(response, String(last.content));
    else respondTool(response, 'sleepclaw_connection_test');
  });
  try {
    await mkdir(join(f.home, 'workspace'), { recursive: true });
    await writeFile(join(f.home, 'workspace', 'AGENTS.md'), 'PRIVATE_HEALTH_SENTINEL: real user records must never be part of a connection check.');
    await writeFile(join(f.home, 'private-profile.json'), JSON.stringify({ private: 'PRIVATE_HEALTH_SENTINEL' }));
    await testConnection(f.home, f.config);
    assert.equal(f.requests.length, 2);
    const payloads = JSON.stringify(f.requests.map((request) => request.body));
    assert.ok(!payloads.includes('PRIVATE_HEALTH_SENTINEL'));
    assert.ok(!payloads.includes(SYNTHETIC_KEY));
  }
  finally { await f.cleanup(); }
});

test('malformed OpenAI SSE cannot pass the connection check', { timeout: 20_000 }, async () => {
  const f = await fixture((_request, response) => { begin(response); response.write('data: {malformed_json\n\n'); finish(response); });
  try { await assert.rejects(testConnection(f.home, f.config)); }
  finally { await f.cleanup(); }
});

test('Anthropic SSE error is surfaced and redacted', { timeout: 20_000 }, async () => {
  const f = await fixture((_request, response) => {
    begin(response);
    anthropicEvent(response, 'error', { error: { type: 'authentication_error', message: `authentication failed ${SYNTHETIC_KEY}` } });
    response.end();
  });
  try {
    await assert.rejects(testConnection(f.home, { ...f.config, protocol: 'anthropic-messages', baseUrl: f.config.baseUrl!.replace(/\/v1$/, '') }), (error: unknown) => {
      const sanitized = publicError(error, 'en');
      assert.equal(sanitized.code, 'AUTH_FAILED');
      assert.ok(!JSON.stringify(sanitized).includes(SYNTHETIC_KEY));
      return true;
    });
  } finally { await f.cleanup(); }
});

test('connection check rejects a text-only provider and unauthorized provider', { timeout: 20_000 }, async () => {
  const textOnly = await fixture((_request, response) => respondText(response, 'I cannot call tools.'));
  try { await assert.rejects(testConnection(textOnly.home, textOnly.config), /TOOL_TEST_FAILED/); }
  finally { await textOnly.cleanup(); }
  const badAuth = await fixture((_request, response) => { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: `unauthorized ${SYNTHETIC_KEY}`, type: 'invalid_api_key' } })); });
  try { await assert.rejects(testConnection(badAuth.home, badAuth.config), (error: unknown) => { assert.equal(publicError(error, 'en').code, 'AUTH_FAILED'); return true; }); assert.equal(badAuth.requests.length, 1); }
  finally { await badAuth.cleanup(); }
});

test('connection check rejects a tool result that is not reflected in the answer', { timeout: 20_000 }, async () => {
  const f = await fixture(({ body }, response) => {
    if (body.messages.at(-1)?.role === 'tool') respondText(response, 'This does not contain the returned token.');
    else respondTool(response, 'sleepclaw_connection_test');
  });
  try { await assert.rejects(testConnection(f.home, f.config), /TOOL_TEST_FAILED/); }
  finally { await f.cleanup(); }
});

test('connection check cancellation after a tool and partial text cannot be reported as success', { timeout: 20_000 }, async () => {
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const controller = new AbortController();
  const f = await fixture(({ body }, response) => {
    if (body.messages.at(-1)?.role === 'tool') {
      begin(response); chunk(response, { role: 'assistant', content: 'Partial synthetic answer.' }); started();
    } else respondTool(response, 'sleepclaw_connection_test');
  });
  try {
    const check = testConnection(f.home, f.config, controller.signal);
    await began;
    controller.abort();
    await assert.rejects(check, (error: unknown) => { assert.equal(publicError(error, 'en').code, 'CANCELLED'); return true; });
  } finally { await f.cleanup(); }
});

test('session abort cancels an active SSE response', { timeout: 20_000 }, async () => {
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture((_request, response) => { begin(response); chunk(response, { role: 'assistant', content: 'Partial synthetic response.' }); started(); });
  const session = await makeSession(f.home, f.config, []);
  try {
    const prompt = session.prompt('Wait for cancellation.');
    await began;
    await session.abort();
    await prompt;
    const last = session.messages.findLast((message) => message.role === 'assistant');
    assert.ok(last?.role === 'assistant');
    assert.equal(last.stopReason, 'aborted');
    assert.equal(session.isStreaming, false);
  } finally { session.dispose(); await f.cleanup(); }
});
