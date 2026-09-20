/**
 * Synthetic screenshot fixture. Run: npx tsx scripts/demo.ts
 * Configure the hidden desktop through its normal IPC, then send DEMO.prompt and
 * answer the saved question with DEMO.answer. Select light appearance in the UI.
 * This is a deterministic local model simulation, not a model-quality benchmark.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SleepApp } from '../src/controller.js';
import type { FactValue, Metric } from '../src/shared/types.js';

export const DEMO = Object.freeze({
  model: 'Demo model',
  apiKey: 'synthetic-demo-key-no-real-credentials',
  provider: 'local-demo',
  goal: 'Why do I still feel tired?',
  prompt: 'I slept for about seven hours, but I still woke up tired. Can we look at last night?',
  answer: 'Traffic outside woke me around 2 am. I checked the clock and it took a while to settle.',
  question: 'Do you remember anything waking you around 2 am?',
  source: 'Apple Watch (demo)',
  start: '2026-09-20T23:15:00+08:00',
  end: '2026-09-21T06:45:00+08:00',
  interpretation: 'Your watch estimated 7 hours asleep and 30 minutes awake. You said you woke feeling tired and remember traffic waking you around 2 am. That timing overlaps a recorded 20-minute awake period. It is a useful detail to explore, but one night cannot tell us what caused the tiredness. Sleep stages are device estimates, not a diagnosis.',
  action: 'Tonight, try closing the street-facing bedroom window before bed, if the room stays comfortable and ventilated, as a simple quieter-bedroom experiment.',
});

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stages = [
  ['AsleepCore', '2026-09-20 23:15:00', '2026-09-21 00:25:00'],
  ['AsleepDeep', '2026-09-21 00:25:00', '2026-09-21 01:10:00'],
  ['AsleepCore', '2026-09-21 01:10:00', '2026-09-21 01:30:00'],
  ['AsleepREM', '2026-09-21 01:30:00', '2026-09-21 02:00:00'],
  ['Awake', '2026-09-21 02:00:00', '2026-09-21 02:20:00'],
  ['AsleepCore', '2026-09-21 02:20:00', '2026-09-21 03:30:00'],
  ['AsleepDeep', '2026-09-21 03:30:00', '2026-09-21 04:00:00'],
  ['Awake', '2026-09-21 04:00:00', '2026-09-21 04:10:00'],
  ['AsleepREM', '2026-09-21 04:10:00', '2026-09-21 04:50:00'],
  ['AsleepCore', '2026-09-21 04:50:00', '2026-09-21 05:50:00'],
  ['AsleepREM', '2026-09-21 05:50:00', '2026-09-21 06:20:00'],
  ['AsleepCore', '2026-09-21 06:20:00', '2026-09-21 06:45:00'],
] as const;

export function demoAppleHealthXml(): string {
  const sleep = (state: string, start: string, end: string) => `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="${DEMO.source}" value="HKCategoryValueSleepAnalysis${state}" startDate="${start} +0800" endDate="${end} +0800"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Synthetic demonstration data. No real person or health export. -->\n<HealthData>${sleep('InBed', '2026-09-20 23:15:00', '2026-09-21 06:45:00')}${stages.map(([state, start, end]) => sleep(state, start, end)).join('')}</HealthData>\n`;
}

/** A fresh sibling on every run; never accept a supplied home or copy user state. */
export function createDemoHome(root = projectRoot): string {
  const smoke = resolve(root, '.smoke');
  if (existsSync(smoke)) assert.ok(!lstatSync(smoke).isSymbolicLink(), 'Demo root must not be a link.');
  mkdirSync(smoke, { recursive: true });
  assert.equal(realpathSync(smoke), join(realpathSync(root), '.smoke'), 'Demo root must stay inside the project.');
  const home = mkdtempSync(join(smoke, 'demo-'));
  assert.ok(home.startsWith(`${smoke}${sep}demo-`), 'Demo home must remain isolated.');
  return home;
}

const answers: Record<string, FactValue> = {
  age_range: '25-34',
  usual_schedule: 'Usually 11 pm to 7 am.',
  sleep_duration_hours: 7,
  remembered_awakenings: 1,
  recovery: 'I woke feeling tired and unrefreshed.',
  recent_context: 'My time in bed felt normal, but I woke feeling tired.',
  work_pattern: 'Regular daytime work; no shifts.',
  medications: null,
  usual_caffeine: 'One coffee in the morning.',
  usual_alcohol: 'I do not usually drink alcohol.',
  usual_exercise: 'A walk in the late afternoon.',
  sleep_environment: 'A street-facing bedroom.',
  daytime_energy: 'Usually alert during the day.',
  sleep_goal: 'Wake feeling more refreshed.',
};

async function answerIntake(app: SleepApp, overrides: Record<string, FactValue> = {}): Promise<void> {
  const values = { ...answers, ...overrides };
  for (let count = 0; app.snapshot().question; count++) {
    assert.ok(count < 14, 'Demo intake must stay bounded.');
    const topic = app.snapshot().question!.topic;
    assert.ok(Object.hasOwn(values, topic), 'Demo intake has an unexpected question.');
    await app.request('answer', { value: values[topic], skip: values[topic] === null });
  }
}

export async function seedDemo(home: string): Promise<void> {
  assert.ok(basename(home).startsWith('demo-') && basename(dirname(home)) === '.smoke', 'Only a fresh demo home may be seeded.');
  assert.ok(!lstatSync(home).isSymbolicLink() && !existsSync(join(home, 'sleepclaw.sqlite')), 'Demo seed must not overwrite an existing home.');
  const app = new SleepApp(home);
  try {
    await app.request('language', { language: 'en' });
    await app.request('new', { goal: 'Looking back at a late bedtime' });
    await answerIntake(app, { sleep_duration_hours: 6.5, recovery: 'A slow start to the morning.', recent_context: 'I stayed up reading later than usual.' });
    await app.request('new', { goal: 'How did my weekend sleep feel?' });
    await answerIntake(app, { sleep_duration_hours: 7.5, recovery: 'Comfortably rested.', recent_context: 'A quiet evening at home.' });
    const path = join(home, 'demo-apple-health.xml');
    writeFileSync(path, demoAppleHealthXml(), { encoding: 'utf8', flag: 'wx' });
    const imported = await app.request('import', { path });
    assert.equal(imported.candidates.length, 1, 'Demo import must produce exactly one episode.');
    assert.equal(imported.candidates[0].asleepMinutes, 420, 'Demo episode must contain seven hours asleep.');
    await app.request('new', { goal: DEMO.goal });
    await answerIntake(app);
    await app.request('target', { ...imported.candidates[0] });
    assert.equal(app.snapshot().question, undefined, 'Demo must start without an irrelevant intake question.');
    assert.equal(app.snapshot().configured, false, 'Desktop must configure its own synthetic credential.');
  } finally { await app.close(); }
}

interface RequestBody {
  model?: string;
  stream?: boolean;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
}

function frame(response: ServerResponse, delta: Record<string, unknown>, finish: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: 'synthetic-sleepclaw-demo', object: 'chat.completion.chunk', created: 1, model: DEMO.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function text(response: ServerResponse, content: string): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  frame(response, { role: 'assistant', content }); frame(response, {}, 'stop'); response.end('data: [DONE]\n\n');
}
function tool(response: ServerResponse, id: string, name: string, args: Record<string, unknown> = {}): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  frame(response, { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  frame(response, {}, 'tool_calls'); response.end('data: [DONE]\n\n');
}
function metric(metrics: Metric[], key: string): number | null | undefined { return metrics.find(item => item.key === key)?.value; }
const allowedTools = new Set(['sleep_context', 'sleep_fact', 'sleep_question', 'sleep_target', 'sleep_data_query', 'sleep_report', 'sleep_feedback']);

/** Bind only to loopback. Any failed check closes the fixture to subsequent requests. */
export async function createDemoServer(): Promise<{ server: Server; baseUrl: string; status: () => { requests: number; step: number; failed: boolean } }> {
  let requests = 0; let step = 0; let failed = false; let connectionCalls = 0;
  const server = createServer(async (request, response) => {
    try {
      assert.ok(!failed && ++requests <= 16, 'Demo request budget exhausted.');
      assert.ok(request.socket.remoteAddress === '127.0.0.1', 'Only loopback requests are allowed.');
      assert.ok(request.method === 'POST' && request.url === '/v1/chat/completions', 'Unexpected demo endpoint.');
      assert.ok(request.headers.authorization === `Bearer ${DEMO.apiKey}`, 'Only the synthetic credential is allowed.');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length; assert.ok(bytes <= 1_048_576, 'Demo request is too large.'); chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody;
      assert.ok(body.model === DEMO.model && body.stream === true && Array.isArray(body.messages) && body.messages.length <= 40, 'Unexpected demo request format.');
      const last = body.messages.at(-1);
      const names = new Set(body.tools?.map(item => item.function?.name));
      if (names.has('sleepclaw_connection_test')) {
        assert.ok(names.size === 1 && !JSON.stringify(body.messages).includes('sleepclaw-current-context'), 'Connection test must not include health context.');
        if (last?.role === 'tool') {
          assert.ok(last.tool_call_id === `demo-connection-${connectionCalls}` && typeof last.content === 'string' && /^[a-f0-9-]{36}$/i.test(last.content), 'Expected connection nonce.');
          text(response, last.content);
        } else {
          assert.ok(last?.role === 'user' && ++connectionCalls <= 4, 'Unexpected connection test.');
          tool(response, `demo-connection-${connectionCalls}`, 'sleepclaw_connection_test');
        }
        return;
      }
      assert.ok(names.size === allowedTools.size && [...names].every(name => typeof name === 'string' && allowedTools.has(name)), 'Unexpected demo tools.');
      assert.ok(!JSON.stringify(body.messages).includes('<HealthData>'), 'Raw health XML must not reach the model.');
      const returned = (id: string) => {
        assert.ok(last?.role === 'tool' && last.tool_call_id === id && typeof last.content === 'string', 'Unexpected tool continuation.');
        return JSON.parse(last.content) as Record<string, any>;
      };
      switch (step) {
        case 0:
          assert.ok(last?.role === 'user' && JSON.stringify(last.content).includes(DEMO.prompt), 'Use the documented synthetic opening message.');
          tool(response, 'demo-full-query', 'sleep_data_query'); break;
        case 1: {
          const result = returned('demo-full-query');
          assert.ok(result.analysis.source === DEMO.source && metric(result.analysis.metrics, 'totalSleepMinutes') === 420 && metric(result.analysis.metrics, 'awakeMinutes') === 30, 'Full episode metrics differ from the demo fixture.');
          tool(response, 'demo-noise-question', 'sleep_question', { topic: 'night_noise', text: DEMO.question, reason: 'Your watch recorded an awake period from 2:00 to 2:20 am. Your recollection can add context.', scope: 'sleep' }); break;
        }
        case 2: {
          const question = returned('demo-noise-question');
          assert.ok(question.topic === 'night_noise' && question.text === DEMO.question, 'Expected the saved follow-up question.');
          text(response, 'Your watch estimated 7 hours asleep, with 30 minutes awake. Let\'s look at the interruption around 2 am alongside what you remember.'); break;
        }
        case 3:
          assert.ok(last?.role === 'user' && JSON.stringify(last.content).includes(DEMO.answer), 'Use the documented synthetic answer.');
          tool(response, 'demo-narrow-query', 'sleep_data_query', { start: '2026-09-21T02:00:00+08:00', end: '2026-09-21T02:30:00+08:00', type: 'sleep' }); break;
        case 4: {
          const result = returned('demo-narrow-query');
          assert.ok(metric(result.analysis.metrics, 'totalSleepMinutes') === 10 && metric(result.analysis.metrics, 'awakeMinutes') === 20, 'Narrow query must use its actual bounded metrics.');
          tool(response, 'demo-report', 'sleep_report', { interpretation: DEMO.interpretation, action: DEMO.action }); break;
        }
        case 5: {
          const report = returned('demo-report');
          assert.ok(report.status === 'complete' && report.score === null && metric(report.metrics, 'totalSleepMinutes') === 420 && metric(report.metrics, 'awakeMinutes') === 30, 'Saved report must retain the complete episode and no score.');
          text(response, 'Your report is ready. The traffic you remember lines up with one recorded interruption, though this night alone cannot explain the tiredness. I\'ve suggested one small quieter-bedroom experiment for tonight.'); break;
        }
        default: throw new Error('Demo scenario is complete. Start a fresh demo for another run.');
      }
      step++;
    } catch {
      failed = true;
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic demo validation failed. Restart the fixture and follow its documented steps.' } }));
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.timeout = 15_000;
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, status: () => ({ requests, step, failed }) };
}

export function demoChildEnvironment(home: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/(?:API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|(?:^|_)PROXY$|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^SLEEPCLAW_)/i.test(key)));
  return { ...env, SLEEPCLAW_HOME: home, SLEEPCLAW_UI_TEST: '1' };
}

async function ensureDebugPortAvailable(): Promise<void> {
  const probe = createPortProbe();
  await new Promise<void>((done, reject) => { probe.once('error', () => reject(new Error('Port 9337 is occupied. Close only the previous demo instance before retrying.'))); probe.listen(9337, '127.0.0.1', done); });
  await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
}

async function main(): Promise<void> {
  const executable = join(projectRoot, 'out', 'SleepClaw-win32-x64', 'sleepclaw.exe');
  assert.ok(statSync(executable).isFile(), 'Package the desktop app before starting the demo.');
  await ensureDebugPortAvailable();
  const home = createDemoHome();
  await seedDemo(home);
  const mock = await createDemoServer();
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopChild = () => { if (child && child.exitCode === null && child.signalCode === null) child.kill(); };
  const exitHandler = () => { stopChild(); mock.server.closeAllConnections(); mock.server.close(); };
  const signalHandler = () => { stopChild(); };
  process.once('exit', exitHandler); process.once('SIGINT', signalHandler); process.once('SIGTERM', signalHandler);
  try {
    child = spawn(executable, [], { windowsHide: true, cwd: projectRoot, env: demoChildEnvironment(home), stdio: 'ignore' });
    await new Promise<void>((done, reject) => { child!.once('spawn', done); child!.once('error', reject); });
    console.log(JSON.stringify({ synthetic: true, home, modelUrl: mock.baseUrl, model: DEMO.model, ready: 'Wait for the desktop at loopback port 9337. Configure using DEMO credentials through normal IPC; select light appearance, send DEMO.prompt, then answer with DEMO.answer. This launcher expires after 30 minutes. Ctrl+C closes it. No user files are removed.' }, null, 2));
    await new Promise<void>((done, reject) => {
      child!.once('exit', code => code === 0 || child!.signalCode ? done() : reject(new Error('Demo desktop exited unexpectedly.')));
      child!.once('error', reject);
      timer = setTimeout(() => { stopChild(); reject(new Error('Demo expired after 30 minutes.')); }, 30 * 60_000);
    });
    assert.ok(!mock.status().failed, 'Demo request validation failed.');
  } finally {
    if (timer) clearTimeout(timer);
    stopChild(); mock.server.closeAllConnections();
    await new Promise<void>(done => mock.server.close(() => done()));
    process.removeListener('exit', exitHandler); process.removeListener('SIGINT', signalHandler); process.removeListener('SIGTERM', signalHandler);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error('Synthetic demo stopped. Check the package, port 9337 and the documented fixture steps. No existing home was modified.'); process.exitCode = 1; });
}
