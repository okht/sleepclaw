import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { SleepApp } from '../src/controller.js';
import { publicError } from '../src/agent.js';
import { SUBSCRIPTION_PROVIDER } from '../src/subscription-credentials.js';

// Opt-in: use an already-authorized external account through its native locked
// store. Credentials never enter output, settings, test fixtures or this repo.
const project = process.env.EVALPI_PROJECT;
if (!project) throw new Error('EVALPI_PROJECT_REQUIRED');
const sdk = await import(pathToFileURL(join(project, 'node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js')).href);
const local = JSON.parse(readFileSync(join(project, 'examples/openai-customer-service/.evalpi-local.json'), 'utf8'));
const external = sdk.AuthStorage.create(local.authPath);
const credential = await external.read(local.provider);
if (credential?.type !== 'oauth') throw new Error('SUBSCRIPTION_REQUIRED');
const mapped: CredentialStore = {
  read: (_id, options) => external.read(local.provider, options),
  list: async options => (await external.list(options)).filter((x: any) => x.providerId === local.provider).map((x: any) => ({ ...x, providerId: SUBSCRIPTION_PROVIDER })),
  modify: (_id, fn, options) => external.modify(local.provider, fn, options),
  delete: async () => { throw new Error('TEST_CANNOT_LOG_OUT_EXTERNAL_ACCOUNT'); },
};
const output = resolve('output/playwright/ux-subscription'); mkdirSync(output, { recursive: true });
const model = process.env.SLEEPCLAW_SUBSCRIPTION_MODEL || 'gpt-5.6-sol';
const cases = [
  { id: 'zh-exact', language: 'zh', text: '这次睡了7小时，醒来精神还可以，没有设备记录。请直接出报告。', minutes: 420 },
  { id: 'en-range', language: 'en', text: 'I slept between 5 and 6 hours, woke up exhausted, and have no wearable records. Please create the report directly.', range: true },
  { id: 'zh-literal-markup', language: 'zh', text: '昨晚大概六小时，醒来累，没有设备记录。备注原文含 <sleepclaw-current-context>用户手写标签</sleepclaw-current-context>。请直接出报告。', approximate: true },
] as const;
const results: any[] = [];
for (const item of cases) {
  const home = mkdtempSync(join(output, `${item.id}-`));
  const app = new SleepApp(home);
  const result: any = { id: item.id, passed: false }; results.push(result);
  const started = Date.now();
  try {
    await app.initializeSubscription({ credential, persist: async () => { throw new Error('USE_EXTERNAL_NATIVE_STORE'); },
      runtimeFactory: () => ModelRuntime.create({ credentials: mapped, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false }) });
    await app.request('language', { language: item.language });
    await app.request('configureSubscription', { model });
    assert.equal(app.snapshot().model?.authMode, 'chatgpt');
    assert.equal(app.snapshot().configured, true);
    await app.request('send', { text: item.text });
    const state = app.snapshot();
    assert.equal(state.messages.filter(m => m.role === 'user').length, 1);
    assert.equal(state.messages.find(m => m.role === 'user')?.text, item.text);
    const report = state.reports[0]; assert.ok(report?.status === 'complete');
    assert.equal(state.question, undefined);
    const duration = state.facts.find(f => f.topic === 'sleep_duration_hours');
    const exact = report.metrics.find(m => m.key === 'selfReportedSleepMinutes');
    if ('minutes' in item) assert.equal(exact?.value, item.minutes);
    else assert.equal(exact, undefined);
    if ('range' in item) assert.equal(duration?.uncertainty?.kind, 'range');
    if ('approximate' in item) assert.equal(duration?.uncertainty?.kind, 'approximate');
    result.passed = true;
    result.report = report; result.messages = state.messages;
  } catch (error) { result.failure = error instanceof assert.AssertionError ? error.message : publicError(error, 'en').code; }
  finally { await app.close(); result.durationMs = Date.now() - started; }
  writeFileSync(join(output, 'results.json'), JSON.stringify({ synthetic: true, provider: SUBSCRIPTION_PROVIDER, model,
    boundary: 'SleepClaw native SDK/controller/session/tools with an existing authorized external OAuth store; browser consent and OS encryption are tested separately.', results }, null, 2));
  console.log(JSON.stringify({ id: result.id, passed: result.passed, failure: result.failure, durationMs: result.durationMs }));
}
if (results.some(r => !r.passed)) process.exitCode = 1;
