import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import assert from 'node:assert/strict';

const syntheticKey = 'synthetic-package-key-no-real-credentials';
const syntheticModel = 'synthetic-packaging-model';
interface RequestBody {
  model?: string;
  stream?: boolean;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
}

function frame(response: ServerResponse, delta: Record<string, unknown>, finish: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: 'synthetic-packaged-smoke', object: 'chat.completion.chunk', created: 1, model: syntheticModel, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
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

// Count physical files, not ASAR entries, so dependency trees cannot silently return.
function resourceFileCount(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Packaged resources must not contain symlinks.');
    total += entry.isDirectory() ? resourceFileCount(join(directory, entry.name)) : 1;
    assert.ok(total <= 1_000, 'Packaged resources exceed the 1,000-file limit; check ASAR packaging.');
  }
  return total;
}

const smokeRoot = resolve('.smoke'); mkdirSync(smokeRoot, { recursive: true });
const home = mkdtempSync(join(smokeRoot, 'packaged-'));
const executable = resolve('out/SleepClaw-win32-x64/sleepclaw.exe');
const resources = resolve('out/SleepClaw-win32-x64/resources');
assert.ok(statSync(join(resources, 'runtime.asar')).isFile(), 'Packaged runtime.asar is required.');
assert.ok(statSync(join(resources, 'runtime.asar')).size > 0, 'Packaged runtime.asar must not be empty.');
const resourceFiles = resourceFileCount(resources);

let requests = 0;
let connectionToolCalls = 0;
let reportToolCalls = 0;
let mockFailed = false;
const server = createServer(async (request, response) => {
  try {
    assert.ok(request.method === 'POST' && request.url === '/v1/chat/completions', 'Unexpected mock endpoint.');
    // Boolean assertions deliberately never print an unexpected credential or body.
    assert.ok(request.headers.authorization === `Bearer ${syntheticKey}`, 'Only the synthetic credential is allowed.');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length; assert.ok(bytes <= 1_048_576, 'Synthetic request is unexpectedly large.'); chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody;
    assert.ok(body.model === syntheticModel && body.stream === true && Array.isArray(body.messages), 'Unexpected mock request format.');
    assert.ok(++requests <= 12, 'Packaged smoke exceeded its bounded model request count.');
    const last = body.messages.at(-1);
    const names = new Set(body.tools?.map(item => item.function?.name));
    if (names.has('sleepclaw_connection_test')) {
      assert.ok(names.size === 1, 'Connection test must expose only its synthetic tool.');
      assert.ok(!JSON.stringify(body.messages).includes('sleepclaw-current-context'), 'Connection test must not include health context.');
      if (last?.role === 'tool') {
        assert.ok(typeof last.content === 'string' && /^[a-f0-9-]{36}$/i.test(last.content), 'Connection test must return a synthetic nonce.');
        text(response, last.content);
      } else { connectionToolCalls++; tool(response, 'sleepclaw_connection_test'); }
    } else if (names.has('sleep_report')) {
      if (last?.role === 'tool') text(response, 'The synthetic packaged smoke report is ready.');
      else {
        reportToolCalls++;
        tool(response, 'sleep_report', {
          interpretation: 'Synthetic packaging check only. No real sleep data was provided; no sleep quality conclusion can be drawn.',
          action: 'This is a synthetic test recommendation; no user action is needed.',
        });
      }
    } else throw new Error('Unexpected tools in packaged smoke.');
  } catch {
    mockFailed = true;
    if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Synthetic packaged smoke request failed validation.' } }));
  }
});
let child: ChildProcess | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  // Do not inherit real API credentials or proxy settings into this isolated smoke home.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|(?:^|_)PROXY$|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$)/i.test(key)));
  child = spawn(executable, [], {
    windowsHide: true,
    env: { ...env, SLEEPCLAW_HOME: home, SLEEPCLAW_SMOKE: '1', SLEEPCLAW_SMOKE_MODEL_URL: `http://127.0.0.1:${address.port}/v1` },
    stdio: 'ignore',
  });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child!.once('error', reject); child!.once('exit', resolveExit);
    timer = setTimeout(() => {
      try { child?.kill(); } catch { /* Still reject so the mock server is closed. */ }
      reject(new Error('Packaged smoke timed out after 45 seconds.'));
    }, 45_000);
  });
  assert.equal(code, 0, 'Packaged application must exit successfully.');
  assert.equal(mockFailed, false, 'Local mock request validation failed.');
  assert.ok(requests >= 4, 'Packaged Pi must complete connection and report tool continuations.');
  assert.equal(connectionToolCalls, 1); assert.equal(reportToolCalls, 1);
  const result = JSON.parse(readFileSync(join(home, 'packaged-smoke.json'), 'utf8'));
  assert.equal(result.ok, true); assert.equal(result.piLoaded, true); assert.equal(result.sqlite, true);
  assert.equal(result.modelTested, true); assert.equal(result.aiInterpretation, true);
  assert.ok(!JSON.stringify(result).includes(syntheticKey), 'Smoke result must not contain credentials.');
  console.log(JSON.stringify({ ...result, requests, resourceFiles, syntheticHome: home }, null, 2));
} finally {
  if (timer) clearTimeout(timer);
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill(); } catch { /* Always continue closing local connections. */ }
  }
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
