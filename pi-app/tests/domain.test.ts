import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SleepStore } from '../src/domain/index.js';
import { buildTimeline } from '../src/domain/report.js';
import type { HealthRecord, Investigation } from '../src/shared/types.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-domain-test-'));
  const store = new SleepStore(home);
  return { home, store, cleanup: () => { store.close(); rmSync(home, { recursive: true, force: true }); } };
}
const sleep = '<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Test Watch" startDate="2026-09-20 23:00:00 +0800" endDate="2026-09-21 06:00:00 +0800" value="HKCategoryValueSleepAnalysisAsleepCore"/>';
function xml(home: string, body = sleep, name = 'export.xml'): string {
  const path = join(home, name);
  writeFileSync(path, `<HealthData>${body}</HealthData>`);
  return path;
}

test('questionnaire resumes exactly, distinguishes skipped from false, and permits corrections', () => {
  const { home, store, cleanup } = fixture();
  try {
    const investigation = store.createInvestigation('昨晚为什么累', 'zh');
    assert.equal(investigation.pendingQuestion?.topic, 'age_range');
    const firstId = investigation.pendingQuestion!.id;
    assert.equal(store.nextQuestion(investigation.id)?.id, firstId);
    const skipped = store.answer(investigation.id, null, true);
    assert.equal(skipped.status, 'unknown');
    assert.equal(skipped.value, null);
    assert.equal(store.nextQuestion(investigation.id)?.topic, 'usual_schedule');
    const knownFalse = store.setFact(investigation.id, { topic: 'uses_alcohol', value: false, scope: 'profile' });
    assert.equal(knownFalse.status, 'known');
    assert.equal(knownFalse.value, false);
    const corrected = store.setFact(investigation.id, { topic: 'uses_alcohol', value: true, scope: 'profile' });
    assert.equal(corrected.id, knownFalse.id);
    assert.equal(corrected.revision, 2);
    const secondConnection = new SleepStore(home);
    assert.equal(secondConnection.snapshot(investigation.id).question?.topic, 'usual_schedule');
    assert.equal(secondConnection.snapshot(investigation.id).facts.find(f => f.topic === 'uses_alcohol')?.value, true);
    secondConnection.close();
  } finally { cleanup(); }
});

test('dynamic question and early self-report work without completing questionnaire or scores', () => {
  const { store, cleanup } = fixture();
  try {
    const investigation = store.createInvestigation('Explain my nap', 'en', 'nap');
    store.saveQuestion(investigation.id, { id: 'follow-up', scope: 'sleep', topic: 'noise', text: 'Did noise wake you?', reason: 'Check the interruption you mentioned.' });
    assert.equal(store.snapshot(investigation.id).question?.id, 'follow-up');
    store.answer(investigation.id, false);
    store.setFact(investigation.id, { topic: 'sleep_duration_hours', value: 0.5, scope: 'sleep' });
    store.setFact(investigation.id, { topic: 'recovery', value: 'A little better', scope: 'sleep' });
    const report = store.buildReport(investigation.id, 'This is a short self-reported nap.');
    assert.equal(report.score, null);
    assert.equal(report.dimensions.length, 5);
    assert.ok(report.dimensions.every(d => d.score === null));
    assert.equal(report.metrics.find(m => m.key === 'selfReportedSleepMinutes')?.value, 30);
    assert.equal(report.metrics.find(m => m.key === 'totalSleepMinutes')?.value, null);
    assert.match(report.markdown, /AI-generated and may be wrong/);
    assert.match(report.title, /nap/);
    assert.ok(report.limitations.every(l => !/[\u4e00-\u9fff]/.test(l)));
  } finally { cleanup(); }
});

test('invalid numeric facts cannot fabricate a measurement and unknown is not a zero', () => {
  const { store, cleanup } = fixture();
  try {
    const investigation = store.createInvestigation('报告', 'zh');
    assert.throws(() => store.setFact(investigation.id, { topic: 'sleep_duration_hours', value: Number.NaN, scope: 'sleep' }), /INVALID_FACT_VALUE/);
    store.setFact(investigation.id, { topic: 'sleep_duration_hours', value: 'maybe seven hours', scope: 'sleep' });
    let report = store.buildReport(investigation.id);
    assert.equal(report.metrics.find(m => m.key === 'selfReportedSleepMinutes'), undefined);
    store.setFact(investigation.id, { topic: 'sleep_duration_hours', value: 0, scope: 'sleep' });
    report = store.buildReport(investigation.id);
    assert.equal(report.metrics.find(m => m.key === 'selfReportedSleepMinutes')?.value, 0);
  } finally { cleanup(); }
});

test('corrections preserve old reports, invalidate them, and export new revisions', () => {
  const { home, store, cleanup } = fixture();
  try {
    const investigation = store.createInvestigation('睡眠分析', 'zh');
    store.setFact(investigation.id, { topic: 'sleep_duration_hours', value: 6, scope: 'sleep' });
    const oldReport = store.buildReport(investigation.id);
    assert.equal(store.buildReport(investigation.id).id, oldReport.id, 'a retried report must not create a duplicate revision');
    assert.equal(store.snapshot(investigation.id).reports.length, 1);
    assert.ok(existsSync(join(home, 'reports', `${oldReport.id}.md`)));
    store.setFact(investigation.id, { topic: 'sleep_duration_hours', value: 7, scope: 'sleep' });
    const stale = store.snapshot(investigation.id).reports.find(r => r.id === oldReport.id)!;
    assert.equal(stale.status, 'stale');
    assert.equal(stale.metrics.find(m => m.key === 'selfReportedSleepMinutes')?.value, 360);
    assert.equal(JSON.parse(readFileSync(join(home, 'reports', `${oldReport.id}.json`), 'utf8')).status, 'stale');
    const report = store.buildReport(investigation.id);
    assert.equal(report.revision, 2);
    assert.equal(report.metrics.find(m => m.key === 'selfReportedSleepMinutes')?.value, 420);
    assert.equal(store.snapshot(investigation.id).reports.length, 2);
  } finally { cleanup(); }
});

test('streaming imports keep source offsets, deduplicate globally and preserve shared import data on deletion', async () => {
  const { home, store, cleanup } = fixture();
  try {
    const path = xml(home);
    const first = await store.importFile(path);
    const second = await store.importFile(path);
    assert.equal(first.recordCount, 1);
    assert.equal(second.duplicateCount, 1);
    assert.equal(store.getRecords().length, 1);
    assert.equal(store.getRecords()[0].startOffset, '+08:00');
    const investigation = store.createInvestigation('看这一晚', 'zh');
    const candidate = store.snapshot().candidates[0];
    store.setTarget(investigation.id, candidate);
    const report = store.buildReport(investigation.id);
    assert.equal(report.metrics.find(m => m.key === 'totalSleepMinutes')?.value, 420);
    assert.equal(report.basis?.source, 'Test Watch');
    assert.equal(report.basis?.start, '2026-09-20T15:00:00.000Z');
    assert.equal(report.timeline?.length, 1);
    assert.equal(report.timeline?.[0].stage, 'core');
    assert.match(report.markdown, /本次分析依据/);
    assert.match(report.dimensions[0].text, /设备估计/);
    store.deleteImport(first.id);
    assert.equal(store.getRecords().length, 1);
    assert.equal(store.snapshot(investigation.id).reports.length, 0, 'explicit import deletion removes derived reports');
    assert.equal(existsSync(join(home, 'reports', `${report.id}.json`)), false);
    store.deleteImport(second.id);
    assert.equal(store.getRecords().length, 0);
    const revised = store.buildReport(investigation.id);
    assert.equal(revised.metrics.find(m => m.key === 'totalSleepMinutes')?.value, null);
  } finally { cleanup(); }
});

test('parse failure and cancellation roll back streamed rows and permit retry', async () => {
  const { home, store, cleanup } = fixture();
  try {
    const malformed = join(home, 'broken.xml');
    writeFileSync(malformed, `<HealthData>${sleep}<Record`);
    await assert.rejects(store.importFile(malformed));
    assert.equal(store.getRecords().length, 0);
    assert.equal(store.snapshot().imports.length, 0);
    const controller = new AbortController();
    await assert.rejects(store.importFile(xml(home), { signal: controller.signal, onProgress: () => controller.abort() }));
    assert.equal(store.getRecords().length, 0);
    assert.equal(store.snapshot().imports.length, 0);
    await store.importFile(xml(home));
    assert.equal(store.getRecords().length, 1);
  } finally { cleanup(); }
});

test('feedback and investigation deletion cascade to owned reports but preserve profile and shared imports', async () => {
  const { home, store, cleanup } = fixture();
  try {
    await store.importFile(xml(home));
    const investigation = store.createInvestigation('my sleep', 'en');
    store.setFact(investigation.id, { topic: 'work_pattern', value: 'shifts', scope: 'profile' });
    store.setFact(investigation.id, { topic: 'recovery', value: 'tired', scope: 'sleep' });
    const report = store.buildReport(investigation.id);
    store.recordFeedback(report.id, 'cannot', 'I work nights');
    assert.equal(store.snapshot(investigation.id).feedback[0].choice, 'cannot');
    const revised = store.buildReport(investigation.id);
    assert.match(revised.action, /not repeat a declined suggestion/);
    store.deleteInvestigation(investigation.id);
    assert.equal(store.snapshot().investigations.length, 0);
    assert.equal(store.snapshot().reports.length, 0);
    assert.equal(store.snapshot().feedback.length, 0);
    assert.equal(store.snapshot().facts[0].scope, 'profile');
    assert.equal(store.getRecords().length, 1);
    assert.equal(existsSync(join(home, 'reports', `${report.id}.md`)), false);
  } finally { cleanup(); }
});

test('profile changes invalidate linked reports in all conversations', () => {
  const { store, cleanup } = fixture();
  try {
    const a = store.createInvestigation('first', 'en');
    const b = store.createInvestigation('second', 'en');
    store.buildReport(a.id);
    store.buildReport(b.id);
    const fact = store.setFact(a.id, { topic: 'usual_schedule', value: 'midnight', scope: 'profile' });
    assert.ok(store.snapshot().reports.every(r => r.status === 'stale'));
    assert.equal(store.snapshot(b.id).facts.find(f => f.id === fact.id)?.value, 'midnight');
    store.deleteFact(fact.id);
    assert.equal(store.snapshot(a.id).facts.find(f => f.id === fact.id), undefined);
    assert.equal(store.snapshot().reports.length, 0);
    store.clearProfile();
    assert.equal(store.snapshot().facts.length, 0);
  } finally { cleanup(); }
});

test('investigation deletion never recreates an export left pending by an earlier write failure', () => {
  const { home, store, cleanup } = fixture();
  try {
    const deleted = store.createInvestigation('Synthetic deleted analysis', 'en');
    const retained = store.createInvestigation('Synthetic retained analysis', 'en');
    const report = store.buildReport(deleted.id, 'Synthetic information to remove.');
    const retainedReport = store.buildReport(retained.id);
    store.recordFeedback(report.id, 'later', 'Synthetic feedback to remove.');
    const blockedTemporary = join(home, 'reports', `${report.id}.json.tmp`);
    mkdirSync(blockedTemporary);
    assert.throws(() => store.setFact(deleted.id, { topic: 'recovery', value: 'tired', scope: 'sleep' }));
    assert.throws(() => store.deleteInvestigation(deleted.id));
    assert.throws(() => store.getInvestigation(deleted.id), /INVESTIGATION_NOT_FOUND/);
    rmSync(blockedTemporary, { recursive: true });
    store.setFact(retained.id, { topic: 'recovery', value: 'rested', scope: 'sleep' });
    for (const extension of ['json', 'md', 'json.tmp', 'md.tmp']) {
      assert.equal(existsSync(join(home, 'reports', `${report.id}.${extension}`)), false, `deleted ${extension} export must stay deleted after retry`);
    }
    assert.equal(store.snapshot(retained.id).feedback.length, 0);
    assert.deepEqual(store.snapshot(retained.id).reports.map(item => item.id), [retainedReport.id]);
    assert.ok(existsSync(join(home, 'reports', `${retainedReport.id}.json`)));
  } finally { cleanup(); }
});

test('deleting a sleep fact purges its report and feedback but preserves unrelated investigations', () => {
  const { home, store, cleanup } = fixture();
  try {
    const first = store.createInvestigation('first', 'en');
    const second = store.createInvestigation('second', 'en');
    const fact = store.setFact(first.id, { topic: 'recovery', value: 'sensitive recollection', scope: 'sleep' });
    const report = store.buildReport(first.id, 'sensitive recollection');
    const unrelated = store.buildReport(second.id);
    store.recordFeedback(report.id, 'later', 'sensitive note');
    store.deleteFact(fact.id);
    assert.deepEqual(store.snapshot().reports.map(r => r.id), [unrelated.id]);
    assert.equal(store.snapshot().feedback.length, 0);
    assert.equal(existsSync(join(home, 'reports', `${report.id}.json`)), false);
    assert.equal(existsSync(join(home, 'reports', `${report.id}.md`)), false);
    assert.equal(existsSync(join(home, 'reports', `${unrelated.id}.json`)), true);
  } finally { cleanup(); }
});

test('report stops the questionnaire and retries are idempotent for the same prose and action', () => {
  const { store, cleanup } = fixture();
  try {
    const investigation = store.createInvestigation('A report now', 'en');
    assert.ok(investigation.pendingQuestion);
    const report = store.buildReport(investigation.id, 'Your data is limited.', 'Keep your room quiet for the next sleep.');
    assert.equal(report.action, 'Keep your room quiet for the next sleep.');
    assert.equal(store.snapshot(investigation.id).question, undefined);
    assert.equal(store.nextQuestion(investigation.id), undefined);
    assert.equal(store.buildReport(investigation.id, 'Your data is limited.', 'Keep your room quiet for the next sleep.').id, report.id);
    store.saveQuestion(investigation.id, { id: 'new-followup', scope: 'sleep', topic: 'noise', text: 'Was it noisy?' });
    assert.equal(store.nextQuestion(investigation.id)?.id, 'new-followup');
  } finally { cleanup(); }
});

test('action feedback suppresses only the linked declined action, not unrelated suggestions', () => {
  const { store, cleanup } = fixture();
  try {
    const investigation = store.createInvestigation('Sleep', 'en');
    const first = store.buildReport(investigation.id, undefined, 'Move the noisy fan away.');
    store.recordFeedback(first.id, 'cannot', 'The fan is fixed in place.');
    const alternative = store.buildReport(investigation.id, undefined, 'Record how refreshed you feel tomorrow.');
    assert.equal(alternative.action, 'Record how refreshed you feel tomorrow.');
    const repeated = store.buildReport(investigation.id, undefined, 'Move the noisy fan away.');
    assert.notEqual(repeated.action, first.action);
    store.recordFeedback(first.id, 'accepted', 'I found a way.');
    assert.equal(store.buildReport(investigation.id, undefined, 'Move the noisy fan away.').action, first.action);
  } finally { cleanup(); }
});

test('language changes translate a pending fixed question and retain facts and previous reports', () => {
  const { store, cleanup } = fixture();
  try {
    const investigation = store.createInvestigation('睡眠', 'zh');
    const questionId = investigation.pendingQuestion!.id;
    store.setLanguage(investigation.id, 'en');
    assert.equal(store.nextQuestion(investigation.id)?.id, questionId);
    assert.match(store.nextQuestion(investigation.id)!.text, /age range/);
    store.answer(investigation.id, '30-40');
    const report = store.buildReport(investigation.id);
    store.setLanguage(investigation.id, 'zh');
    assert.equal(store.snapshot(investigation.id).facts.find(f => f.topic === 'age_range')?.value, '30-40');
    assert.equal(store.snapshot(investigation.id).reports[0].language, 'en');
    assert.equal(store.snapshot(investigation.id).reports[0].status, 'complete');
    const localized = store.buildReport(investigation.id);
    assert.equal(localized.language, 'zh');
    assert.equal(localized.revision, report.revision + 1);
  } finally { cleanup(); }
});

test('an explicit numeric answer to a numeric question is preserved as a user measurement', () => {
  const { store, cleanup } = fixture();
  try {
    const investigation = store.createInvestigation('last night', 'en');
    store.saveQuestion(investigation.id, { id: 'duration', topic: 'sleep_duration_hours', scope: 'sleep', text: 'How many hours did you sleep?' });
    const fact = store.answer(investigation.id, '7.5');
    assert.equal(fact.value, 7.5);
    assert.equal(store.buildReport(investigation.id).metrics.find(m => m.key === 'selfReportedSleepMinutes')?.value, 450);
  } finally { cleanup(); }
});

test('self-report summary avoids duplicate wording and unrelated empty-device warnings', () => {
  const { store, cleanup } = fixture();
  try {
    const investigation = store.createInvestigation('昨晚情况', 'zh');
    store.setFact(investigation.id, { topic: 'sleep_duration_hours', value: 7, scope: 'sleep' });
    const report = store.buildReport(investigation.id);
    assert.match(report.summary, /^本次睡眠有 420 分钟/);
    assert.doesNotMatch(report.summary, /这次本次/);
    assert.equal(report.limitations.filter(item => item.includes('设备指标暂不可用')).length, 1);
    assert.ok(report.limitations.some(item => item.includes('回忆偏差')));
    assert.ok(report.limitations.every(item => !item.includes('卧床范围') && !item.includes('没有可用的睡眠阶段') && !item.includes('个人历史基线')));
    assert.equal(report.metrics.find(metric => metric.key === 'totalSleepMinutes')?.value, null);
  } finally { cleanup(); }
});

test('timeline clips to the selected source and window, merges stages and avoids generic double-counting', () => {
  const investigation: Investigation = { id: 'test', goal: 'timeline', language: 'en', scope: 'main', revision: 1, createdAt: '2026-09-20T00:00:00Z', status: 'collecting', source: 'Watch', start: '2026-09-20T23:30:00Z', end: '2026-09-21T02:00:00Z' };
  const record = (id: string, start: string, end: string, value: string, source = 'Watch'): HealthRecord => ({ id, type: 'sleep', start, end, value, source, startOffset: '+00:00', endOffset: '+00:00' });
  const records = [
    record('inbed', '2026-09-20T23:00:00Z', '2026-09-21T03:00:00Z', 'inBed'),
    record('generic', '2026-09-20T23:00:00Z', '2026-09-21T03:00:00Z', 'unspecified'),
    record('core1', '2026-09-20T23:00:00Z', '2026-09-21T00:00:00Z', 'core'),
    record('core2', '2026-09-21T00:00:00Z', '2026-09-21T00:30:00Z', 'core'),
    record('deep', '2026-09-21T00:30:00Z', '2026-09-21T01:00:00Z', 'deep'),
    record('another-source', '2026-09-20T23:00:00Z', '2026-09-21T03:00:00Z', 'rem', 'Other Watch'),
  ];
  const result = buildTimeline(records, investigation);
  assert.deepEqual(result.timeline, [
    { start: '2026-09-20T23:30:00.000Z', end: '2026-09-21T00:30:00.000Z', stage: 'core' },
    { start: '2026-09-21T00:30:00.000Z', end: '2026-09-21T01:00:00.000Z', stage: 'deep' },
    { start: '2026-09-21T01:00:00.000Z', end: '2026-09-21T02:00:00.000Z', stage: 'unspecified' },
  ]);
  assert.equal(result.truncated, false);
});

test('timeline explicitly marks conflicts and caps display without creating stages for gaps', () => {
  const start = Date.UTC(2026, 8, 20);
  const investigation: Investigation = { id: 'test', goal: 'timeline', language: 'en', scope: 'main', revision: 1, createdAt: new Date(start).toISOString(), status: 'collecting', source: 'Watch', start: new Date(start).toISOString(), end: new Date(start + 500 * 60_000).toISOString() };
  const records: HealthRecord[] = Array.from({ length: 205 }, (_, i) => ({ id: String(i), type: 'sleep', source: 'Watch', value: i % 2 ? 'core' : 'deep', start: new Date(start + i * 120_000).toISOString(), end: new Date(start + i * 120_000 + 60_000).toISOString(), startOffset: '+00:00', endOffset: '+00:00' }));
  records.push({ ...records[0], id: 'conflict', value: 'awake' });
  const result = buildTimeline(records, investigation);
  assert.equal(result.timeline.length, 200);
  assert.equal(result.truncated, true);
  assert.equal(result.timeline[0].stage, 'unknown');
  assert.equal(result.timeline[1].start, new Date(start + 120_000).toISOString(), 'the missing minute is not filled as a sleep stage');
});

test('actual fact and profile deletion remove pending questions that could retain deleted information', () => {
  const { store, cleanup } = fixture();
  try {
    const investigation = store.createInvestigation('sleep', 'en');
    const fact = store.setFact(investigation.id, { topic: 'medications', value: 'Synthetic medicine A', scope: 'profile' });
    store.saveQuestion(investigation.id, { id: 'sensitive', topic: 'medicine_timing', scope: 'sleep', text: 'When did you take Synthetic medicine A?', reason: 'You mentioned Synthetic medicine A.' });
    store.deleteFact(fact.id);
    assert.equal(store.snapshot(investigation.id).question, undefined);
    assert.doesNotMatch(JSON.stringify(store.snapshot(investigation.id)), /Synthetic medicine A/);
    store.saveQuestion(investigation.id, { id: 'sensitive-again', topic: 'medicine_timing', scope: 'sleep', text: 'An old profile detail is embedded here.' });
    store.clearProfile();
    assert.equal(store.snapshot(investigation.id).question, undefined);
  } finally { cleanup(); }
});

test('actual import deletion removes questions referring to deleted observations', async () => {
  const { home, store, cleanup } = fixture();
  try {
    const imported = await store.importFile(xml(home));
    const investigation = store.createInvestigation('sleep', 'en');
    store.setTarget(investigation.id, store.snapshot().candidates[0]);
    store.saveQuestion(investigation.id, { id: 'measurement', topic: 'unexpected_duration', scope: 'sleep', text: 'The deleted data says 420 minutes. How did you feel?' });
    const unselected = store.createInvestigation('choose a sleep', 'en');
    store.saveQuestion(unselected.id, { id: 'selection', topic: 'target_choice', scope: 'sleep', text: 'Do you want to analyze the deleted import?' });
    store.deleteImport(imported.id);
    assert.equal(store.snapshot(investigation.id).question, undefined);
    assert.equal(store.snapshot(unselected.id).question, undefined);
    assert.doesNotMatch(JSON.stringify(store.snapshot(investigation.id)), /deleted data says 420/);
  } finally { cleanup(); }
});
