import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SleepStore } from '../src/domain/index.js';
import { createSleepTools, safeToolError, sleepContext } from '../src/tools.js';
import type { Fact, Investigation, InvestigationPlan, Question, Report } from '../src/shared/types.js';
import type { HealthEvidenceAnalysis } from '../src/health/evidence.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-tools-test-'));
  const store = new SleepStore(home);
  const tools = createSleepTools(store);
  const call = async <T = unknown>(name: string, params: unknown, signal?: AbortSignal) => {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, name);
    return await tool.execute(params, signal) as T;
  };
  return { home, store, tools, call, cleanup: () => { store.close(); rmSync(home, { recursive: true, force: true }); } };
}
const selected = { start: '2026-09-20T23:00:00+08:00', end: '2026-09-21T00:00:00+08:00', source: 'Synthetic Watch' };
const step = { id: 'report', kind: 'report', description: 'Summarize what is known', status: 'pending' };

test('shared tools complete a self-report investigation without a model or selected device target', async () => {
  const f = fixture();
  try {
    const created = await f.call<Investigation>('sleep_create', { goal: 'Summarize my recalled sleep', language: 'en' });
    const investigationId = created.id;
    const q = await f.call<Question>('sleep_question', { investigationId, topic: 'sleep_duration_hours', text: 'How long do you recall sleeping?', reason: 'Separate recalled duration from device evidence.', scope: 'sleep' });
    assert.equal(f.store.snapshot(investigationId).question?.id, q.id);
    await f.call('sleep_fact', { investigationId, topic: 'sleep_duration_hours', value: 7, scope: 'sleep' });
    const revision = f.store.getInvestigation(investigationId).revision;
    const plan = await f.call<InvestigationPlan>('sleep_plan', { investigationId, objective: 'Report available facts', revision, steps: [step] });
    assert.equal(plan.revision, revision);
    const report = await f.call<Report>('sleep_report', { investigationId, interpretation: '', action: '' });
    assert.equal(report.metrics.find(metric => metric.key === 'selfReportedSleepMinutes')?.value, 420);
    assert.equal(report.metrics.find(metric => metric.key === 'totalSleepMinutes')?.value, null);
    assert.equal(report.score, null);
    assert.equal(f.store.snapshot(investigationId).question, undefined);
    assert.equal((await f.call<Report>('sleep_report', { investigationId, interpretation: '', action: '' })).id, report.id);
    await f.call('sleep_feedback', { investigationId, reportId: report.id, choice: 'later', note: 'Synthetic feedback' });
    assert.equal(f.store.snapshot(investigationId).feedback[0].choice, 'later');
  } finally { f.cleanup(); }
});

test('a range remains verbatim and cannot be saved as an invented midpoint', async () => {
  const f = fixture();
  try {
    const investigationId = f.store.createInvestigation('Uncertain duration', 'en').id;
    const uncertainty = { kind: 'range', original: '6-7 hours, not sure', lower: 6, upper: 7, unit: 'hours' };
    const fact = await f.call<Fact>('sleep_fact', { investigationId, topic: 'sleep_duration_hours', value: uncertainty.original, scope: 'sleep', uncertainty });
    assert.equal(fact.value, uncertainty.original);
    assert.deepEqual(fact.uncertainty, uncertainty);
    await assert.rejects(f.call('sleep_fact', { investigationId, topic: 'sleep_duration_hours', value: 6.5, scope: 'sleep', uncertainty }), /INVALID_FACT_UNCERTAINTY/);
    const report = await f.call<Report>('sleep_report', { investigationId, interpretation: '', action: '' });
    assert.equal(report.metrics.find(metric => metric.key === 'selfReportedSleepMinutes'), undefined);
    assert.doesNotMatch(report.summary, /390|6\.5/);
    assert.equal(f.store.snapshot(investigationId).facts.find(item => item.id === fact.id)?.value, uncertainty.original);
  } finally { f.cleanup(); }
});

test('strict schemas reject malformed, additional and missing fields before mutation', async () => {
  const f = fixture();
  try {
    for (const params of [null, [], { goal: 'Sleep' }, { goal: 'Sleep', language: 'fr' }, { goal: 'Sleep', language: 'en', apiKey: 'synthetic-forbidden-field' }]) {
      await assert.rejects(f.call('sleep_create', params), /INVALID_TOOL_ARGUMENTS/);
    }
    assert.equal(f.store.snapshot().investigations.length, 0);
    const investigationId = f.store.createInvestigation('Test', 'en').id;
    await assert.rejects(f.call('sleep_fact', { investigationId, topic: 'x', value: { nested: true }, scope: 'sleep' }), /INVALID_TOOL_ARGUMENTS/);
    await assert.rejects(f.call('sleep_target', selected), /INVALID_TOOL_ARGUMENTS/);
    await assert.rejects(f.call('sleep_report', { investigationId, interpretation: '' }), /INVALID_TOOL_ARGUMENTS/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(f.call('sleep_fact', { investigationId, topic: 'x', value: 1, scope: 'sleep' }, abort.signal), /CANCELLED/);
    assert.equal(f.store.snapshot(investigationId).facts.length, 0);
  } finally { f.cleanup(); }
});

test('target and queries require explicit timezone and remain inside the selected interval', async () => {
  const f = fixture();
  try {
    const investigationId = f.store.createInvestigation('Selected episode', 'en').id;
    await assert.rejects(f.call('sleep_health_analysis', { investigationId }), /TARGET_REQUIRED/);
    await assert.rejects(f.call('sleep_target', { investigationId, ...selected, start: '2026-09-20T23:00:00' }), /TIMEZONE_REQUIRED/);
    await f.call('sleep_target', { investigationId, ...selected });
    for (const name of ['sleep_data_query', 'sleep_health_analysis']) {
      await assert.rejects(f.call(name, { investigationId, start: '2026-09-20T23:10:00' }), /TIMEZONE_REQUIRED/);
      await assert.rejects(f.call(name, { investigationId, start: '2026-09-20T22:59:00+08:00' }), /INVALID_QUERY_RANGE/);
      await assert.rejects(f.call(name, { investigationId, end: '2026-09-21T00:01:00+08:00' }), /INVALID_QUERY_RANGE/);
      await assert.rejects(f.call(name, { investigationId, start: selected.end, end: selected.start }), /INVALID_QUERY_RANGE/);
      await assert.rejects(f.call(name, { investigationId, source: 'Another Watch' }), /INVALID_TOOL_ARGUMENTS/);
      await f.call(name, { investigationId, start: '2026-09-20T15:10:00Z', end: '2026-09-20T15:50:00Z' });
    }
  } finally { f.cleanup(); }
});

test('import deduplication and health analysis retain observed median, unknown gaps and absent HRV', async () => {
  const f = fixture();
  try {
    const path = join(f.home, 'synthetic-private-name.xml');
    writeFileSync(path, '<HealthData>' +
      '<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Synthetic Watch" startDate="2026-09-20 23:00:00 +0800" endDate="2026-09-20 23:20:00 +0800" value="HKCategoryValueSleepAnalysisAsleepCore"/>' +
      [54, 58, 62].map((value, i) => `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Synthetic Watch" startDate="2026-09-20 23:${String(i * 10).padStart(2, '0')}:00 +0800" endDate="2026-09-20 23:${String(i * 10).padStart(2, '0')}:00 +0800" value="${value}" unit="count/min"/>`).join('') + '</HealthData>');
    const imported = await f.call<{ recordCount: number; duplicateCount: number; name?: string }>('sleep_import', { path });
    const duplicate = await f.call<{ duplicateCount: number }>('sleep_import', { path });
    assert.equal(imported.recordCount, 4); assert.equal(duplicate.duplicateCount, 4);
    assert.equal(imported.name, undefined);
    assert.doesNotMatch(JSON.stringify(imported), /synthetic-private-name|<Record/);
    assert.equal(f.store.getRecords().length, 4);
    const investigationId = f.store.createInvestigation('Imported data', 'en').id;
    await f.call('sleep_target', { investigationId, ...selected });
    const evidence = await f.call<HealthEvidenceAnalysis>('sleep_health_analysis', { investigationId });
    assert.equal(evidence.physiology.find(item => item.type === 'heartRate')?.median, 58);
    assert.equal(evidence.physiology.find(item => item.type === 'hrv')?.median, null);
    assert.equal(evidence.sleep.unobservedMinutes, 40);
    assert.equal(evidence.sleep.observedAwakeMinutes, null);
    assert.equal(evidence.sleep.gaps[0].minutes, 40);
    const bounded = await f.call<{ observations: Array<{ start: string }>; analysis: { recordCount: number } }>('sleep_data_query', {
      investigationId, type: 'heartRate', start: '2026-09-20T23:10:00+08:00', end: '2026-09-20T23:20:00+08:00',
    });
    assert.equal(bounded.analysis.recordCount, 1);
    assert.equal(bounded.observations.length, 1, 'the exclusive end-boundary point must not leak into observations');
  } finally { f.cleanup(); }
});

test('target rejects impossible calendar dates without silently normalizing them', async () => {
  const f = fixture();
  try {
    const investigation = f.store.createInvestigation('Calendar validation', 'en');
    await assert.rejects(f.call('sleep_target', {
      investigationId: investigation.id, source: selected.source,
      start: '2026-02-30T23:00:00+08:00', end: '2026-03-03T07:00:00+08:00',
    }), /TIMEZONE_REQUIRED/);
    assert.equal(f.store.getInvestigation(investigation.id).start, undefined);
    assert.equal(f.store.getInvestigation(investigation.id).revision, investigation.revision);
  } finally { f.cleanup(); }
});

test('fact corrections stale plans and reports, then produce a new report revision', async () => {
  const f = fixture();
  try {
    const investigationId = f.store.createInvestigation('Revisions', 'en').id;
    await f.call('sleep_fact', { investigationId, topic: 'sleep_duration_hours', scope: 'sleep', value: 6 });
    const revision = f.store.getInvestigation(investigationId).revision;
    await f.call('sleep_plan', { investigationId, objective: 'Summarize', revision, steps: [step] });
    const first = await f.call<Report>('sleep_report', { investigationId, interpretation: '', action: '' });
    await f.call('sleep_fact', { investigationId, topic: 'sleep_duration_hours', scope: 'sleep', value: 7 });
    await assert.rejects(f.call('sleep_plan', { investigationId, objective: 'Old context', revision, steps: [step] }), /PLAN_STALE/);
    const context = await f.call<{ guidance: { planStatus: string }; reports: Array<{ id: string; status: string; metrics?: unknown }> }>('sleep_context', { investigationId });
    assert.equal(context.guidance.planStatus, 'stale');
    assert.equal(context.reports[0].status, 'stale'); assert.equal(context.reports[0].metrics, undefined);
    const second = await f.call<Report>('sleep_report', { investigationId, interpretation: '', action: '' });
    assert.equal(second.revision, first.revision + 1);
    assert.equal(second.metrics.find(item => item.key === 'selfReportedSleepMinutes')?.value, 420);
  } finally { f.cleanup(); }
});

test('unscoped context does not auto-select and feedback is isolated to the chosen investigation', async () => {
  const f = fixture();
  try {
    const first = f.store.createInvestigation('First', 'en'), second = f.store.createInvestigation('Second', 'en');
    const report = f.store.buildReport(first.id);
    const overview = sleepContext(f.store) as Record<string, unknown>;
    assert.equal(overview.investigation, undefined); assert.equal(overview.facts, undefined);
    await assert.rejects(f.call('sleep_feedback', { investigationId: second.id, reportId: report.id, choice: 'cannot' }), /REPORT_NOT_FOUND/);
    assert.deepEqual(f.store.snapshot().feedback, []);
    const bound = createSleepTools(f.store, { investigationId: () => first.id });
    assert.equal(bound.some(item => item.name === 'sleep_create'), false);
    assert.equal(bound.some(item => item.name === 'sleep_import'), false);
    await assert.rejects(bound.find(item => item.name === 'sleep_fact')!.execute({ investigationId: second.id, topic: 'x', value: 1, scope: 'sleep' }), /INVALID_TOOL_ARGUMENTS/);
  } finally { f.cleanup(); }
});

test('safe error responses retain known codes without exposing unexpected paths or records', () => {
  assert.equal(safeToolError(new Error('UNKNOWN_TOOL')).code, 'UNKNOWN_TOOL');
  assert.equal(safeToolError(new DOMException('private import cancelled', 'AbortError')).code, 'CANCELLED');
  const sensitive = safeToolError(new Error('ENOENT C:\\private-synthetic\\export.xml patient-details-synthetic token-synthetic'));
  assert.equal(sensitive.code, 'TOOL_FAILED');
  assert.doesNotMatch(JSON.stringify(sensitive), /private-synthetic|patient-details-synthetic|token-synthetic|ENOENT/);
});
