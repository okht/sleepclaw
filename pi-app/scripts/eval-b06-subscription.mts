import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { SYSTEM_PROMPT } from '../src/agent.js';
import { createSleepTools, sleepContext, safeToolError } from '../src/tools.js';
import { SleepStore } from '../src/domain/index.js';

// Opt-in external subscription harness; never copies or prints credentials.
// Use EVALPI_PROJECT for the already-authorized EvalPi checkout. This exercises
// SleepClaw's prompt/tools/domain through that checkout's Pi SDK, not desktop auth.
const project = process.env.EVALPI_PROJECT;
if (!project) throw new Error('EVALPI_PROJECT_REQUIRED');
const sdk = await import(pathToFileURL(join(project, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
const local = JSON.parse(readFileSync(join(project, 'examples/openai-customer-service/.evalpi-local.json'), 'utf8'));
const runtime = await sdk.ModelRuntime.create({ authPath: local.authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
if ((await runtime.checkAuth(local.provider))?.type !== 'oauth') throw new Error('SUBSCRIPTION_REQUIRED');
const model = runtime.getModel(local.provider, local.model);
if (!model) throw new Error('MODEL_UNAVAILABLE');
const output = resolve('output/playwright/b06-subscription');
mkdirSync(output, { recursive: true });
const results: any[] = [];
const metadata = { synthetic: true, provider: local.provider, model: local.model,
  promptSha256: createHash('sha256').update(SYSTEM_PROMPT).digest('hex'), createdAt: new Date().toISOString(),
  boundary: 'External EvalPi subscription SDK; current SleepClaw prompt, tools and domain. No desktop authentication or controller coverage.' };
function persist() { writeFileSync(join(output, 'results.json'), JSON.stringify({ ...metadata, results }, null, 2)); }
const cases = [
  { id: 'zh-range', language: 'zh', input: '昨晚大概睡了六到七小时，醒来很累，没有设备记录。先直接给我报告，不用继续问问题。', range: [6, 7] },
  { id: 'zh-exact', language: 'zh', input: '这次实际睡了7小时，醒来很累，没有设备记录，请直接生成报告。', minutes: 420 },
  { id: 'en-range', language: 'en', input: 'I slept between 5 and 6 hours last night and woke up exhausted. No wearable data. Please give me the report directly without more questions.', range: [5, 6] },
  { id: 'zh-approximate', language: 'zh', input: '昨晚大概七小时，醒来精神还好。没有设备记录，直接给报告，时长请保留大概这个限定。', approximate: true },
  { id: 'zh-unknown-custom', language: 'zh', input: '昨晚睡了多久完全记不清，醒来很疲惫，卧室窗外施工很吵。没有设备记录，请记录我的原话并直接给报告。', unknown: true },
] as const;

for (const item of cases) {
  const home = mkdtempSync(join(output, `${item.id}-`));
  const store = new SleepStore(home);
  const investigation = store.createInvestigation(item.input, item.language);
  const trace: any[] = [];
  const entry: any = { id: item.id, input: item.input, trace };
  results.push(entry);
  const customTools = createSleepTools(store, { investigationId: () => investigation.id }).map(tool => sdk.defineTool({
    name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
    execute: async (_id: string, params: unknown, signal: AbortSignal) => {
      const call: any = { name: tool.name, params }; trace.push(call);
      try { const result = await tool.execute(params, signal); call.result = result; return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} }; }
      catch (error) { call.error = safeToolError(error); throw error; }
    },
  }));
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off', enableInstallTelemetry: false, enableAnalytics: false });
  const loader = new sdk.DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager: settings,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    systemPromptOverride: () => SYSTEM_PROMPT, agentsFilesOverride: () => ({ agentsFiles: [] }), appendSystemPromptOverride: () => [] });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: home, agentDir: home, modelRuntime: runtime, model, thinkingLevel: 'off', noTools: 'builtin', customTools,
    settingsManager: settings, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(home) });
  let turns = 0;
  const unsubscribe = session.subscribe((event: any) => { if (event.type === 'turn_end' && ++turns >= 12) void session.abort(); });
  const start = Date.now();
  const timer = setTimeout(() => { entry.timedOut = true; void session.abort(); }, 120_000);
  try {
    await session.prompt(`${item.input}\n<sleepclaw-current-context>${JSON.stringify(sleepContext(store, investigation.id))}</sleepclaw-current-context>`, { expandPromptTemplates: true });
    entry.messages = session.messages.filter((m: any) => m.role === 'assistant').map((m: any) => ({ stopReason: m.stopReason, text: m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') }));
    entry.snapshot = store.snapshot(investigation.id);
    const report = entry.snapshot.reports[0];
    assert.ok(!entry.timedOut && report && report.status === 'complete', 'direct report must complete');
    assert.equal(entry.snapshot.question, undefined);
    const duration = entry.snapshot.facts.find((f: any) => f.scope === 'sleep' && f.topic === 'sleep_duration_hours');
    const recovery = entry.snapshot.facts.find((f: any) => f.scope === 'sleep' && f.topic === 'recovery');
    assert.ok(recovery?.status === 'known', 'canonical recovery is available');
    assert.ok(!/资料不足|not enough information/i.test(report.dimensions.find((d: any) => d.key === 'recovery').text));
    const exact = report.metrics.find((m: any) => m.key === 'selfReportedSleepMinutes');
    if ('minutes' in item) assert.equal(exact?.value, item.minutes);
    else assert.equal(exact, undefined, 'uncertainty must not invent an exact duration');
    if ('range' in item) { assert.equal(duration?.uncertainty?.kind, 'range'); assert.equal(duration.uncertainty.lower, item.range[0]); assert.equal(duration.uncertainty.upper, item.range[1]); assert.ok(!/资料不足|not enough information/i.test(report.dimensions.find((d: any) => d.key === 'duration').text)); }
    if ('approximate' in item) assert.equal(duration?.uncertainty?.kind, 'approximate');
    if ('unknown' in item) { assert.ok(duration?.status === 'unknown' || duration?.uncertainty?.kind === 'uncertain'); assert.match(JSON.stringify(report.reportedFacts), /施工|窗外|吵/); }
    assert.ok(report.reportedFacts?.some((f: any) => f.topic === 'recovery'));
    entry.passed = true;
  } catch (error) { entry.passed = false; entry.checkFailure = error instanceof assert.AssertionError ? error.message : safeToolError(error).code; }
  finally { clearTimeout(timer); unsubscribe(); session.dispose(); store.close(); entry.durationMs = Date.now() - start; entry.turns = turns; persist(); }
  console.log(JSON.stringify({ id: item.id, passed: entry.passed, durationMs: entry.durationMs, turns, toolCalls: trace.length }));
}
const passed = results.filter(item => item.passed).length;
console.log(JSON.stringify({ cases: results.length, passed }));
if (passed !== results.length) process.exitCode = 1;
