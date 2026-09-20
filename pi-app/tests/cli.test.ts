import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliApiKey, latestActiveReport } from '../src/cli-options.js';
import { SleepStore } from '../src/domain/index.js';

test('CLI selects provider-specific keys without cross-provider fallback', () => {
  const environment = { ANTHROPIC_API_KEY: 'synthetic-anthropic', OPENAI_API_KEY: 'synthetic-openai' };
  assert.equal(cliApiKey('openai', environment), 'synthetic-openai');
  assert.equal(cliApiKey('anthropic', environment), 'synthetic-anthropic');
  assert.equal(cliApiKey('openai-compatible', environment), undefined);
  assert.equal(cliApiKey(undefined, environment), undefined);
  assert.equal(cliApiKey('openai', { ANTHROPIC_API_KEY: 'synthetic-anthropic' }), undefined);
  assert.equal(cliApiKey('anthropic', { OPENAI_API_KEY: 'synthetic-openai' }), undefined);
  assert.equal(cliApiKey('openai-compatible', { ...environment, SLEEPCLAW_API_KEY: ' synthetic-explicit ' }), 'synthetic-explicit');
  assert.equal(cliApiKey('openai', { ...environment, SLEEPCLAW_API_KEY: 'synthetic-explicit' }), 'synthetic-explicit');
});

test('resuming an older investigation prints its report even when another investigation has a newer report', () => {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-cli-test-'));
  const store = new SleepStore(home);
  try {
    const first = store.createInvestigation('First sleep', 'en');
    store.setFact(first.id, { topic: 'sleep_duration_hours', value: 5, scope: 'sleep' });
    const firstReport = store.buildReport(first.id);
    const second = store.createInvestigation('Second sleep', 'en');
    store.setFact(second.id, { topic: 'sleep_duration_hours', value: 8, scope: 'sleep' });
    store.buildReport(second.id);
    assert.equal(store.buildReport(first.id).id, firstReport.id, 'the old report is reused without changing its creation date');
    assert.equal(latestActiveReport(store.snapshot(first.id))?.id, firstReport.id);
    assert.equal(latestActiveReport(store.snapshot(first.id))?.metrics.find(metric => metric.key === 'selfReportedSleepMinutes')?.value, 300);
    store.setFact(first.id, { topic: 'sleep_duration_hours', value: 6, scope: 'sleep' });
    assert.equal(latestActiveReport(store.snapshot(first.id)), undefined, 'a stale report must not be presented as current');
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});
