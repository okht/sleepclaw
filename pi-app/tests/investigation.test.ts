import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SleepStore } from '../src/domain/index.js';
import { buildInvestigationGuidance } from '../src/domain/investigation.js';
import type { FactInput, FactUncertainty, InvestigationPlanInput, InvestigationPlanStep } from '../src/shared/types.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-investigation-test-'));
  const store = new SleepStore(home);
  return { home, store, cleanup: () => { store.close(); rmSync(home, { recursive: true, force: true }); } };
}

function plan(revision: number, steps: InvestigationPlanStep[] = [{ id: 'summary', kind: 'report', description: 'Report what is known.', status: 'pending' }]): InvestigationPlanInput {
  return { objective: 'Understand this sleep episode.', revision, steps };
}

function ask(store: SleepStore, id: string, topic: string, scope: FactInput['scope'] = 'sleep') {
  store.saveQuestion(id, { id: `ask-${topic}`, topic, scope, text: 'What do you remember?' });
}

function guidance(store: SleepStore, id: string) {
  const snapshot = store.snapshot(id);
  return buildInvestigationGuidance(snapshot.active!, snapshot.facts);
}

const target = { start: '2026-09-20T15:00:00.000Z', end: '2026-09-20T22:00:00.000Z', source: 'Test Watch' };

test('explicit ranges retain both bounds and the original answer without fabricating a midpoint', () => {
  const { store, cleanup } = fixture();
  try {
    const { id } = store.createInvestigation('Understand my sleep', 'en');
    const uncertainty: FactUncertainty = { kind: 'range', original: 'Between six and eight hours', lower: 6, upper: 8, unit: 'hours' };
    const fact = store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', value: uncertainty.original, uncertainty });
    assert.equal(fact.value, uncertainty.original);
    assert.deepEqual(fact.uncertainty, uncertainty);
    uncertainty.lower = 7;
    assert.equal(store.snapshot(id).facts.find(item => item.id === fact.id)?.uncertainty?.lower, 6, 'caller mutation must not alter saved metadata');
    const report = store.buildReport(id);
    assert.equal(report.metrics.find(metric => metric.key === 'selfReportedSleepMinutes'), undefined);
    assert.equal(report.metrics.find(metric => metric.key === 'totalSleepMinutes')?.value, null);
    assert.equal(report.score, null);
  } finally { cleanup(); }
});

test('uncertainty validation rejects malformed metadata atomically at the store boundary', () => {
  const { store, cleanup } = fixture();
  try {
    const investigation = store.createInvestigation('Understand my sleep', 'en');
    const invalid: unknown[] = [
      null, [], 'about seven', { kind: 'guess', original: 'about seven' },
      { kind: 'approximate', original: '' }, { kind: 'approximate', original: '  ' },
      { kind: 'approximate', original: 7 }, { kind: 'approximate', original: 'x'.repeat(20_001) },
      { kind: 'uncertain', original: 'maybe seven', lower: Number.NaN },
      { kind: 'uncertain', original: 'maybe seven', upper: Number.POSITIVE_INFINITY },
      { kind: 'uncertain', original: 'maybe seven', lower: '6' },
      { kind: 'range', original: 'six to eight', lower: 8, upper: 6, unit: 'hours' },
      { kind: 'range', original: 'six to eight', lower: 6, upper: 8 },
      { kind: 'range', original: 'six to eight', lower: 6, unit: 'hours' },
      { kind: 'range', original: 'six to eight', upper: 8, unit: 'hours' },
      { kind: 'range', original: 'six to eight', lower: 6, upper: 8, unit: ' ' },
      { kind: 'uncertain', original: 'maybe seven', unit: 7 },
      { kind: 'uncertain', original: 'maybe seven', unit: 'x'.repeat(65) },
    ];
    for (const uncertainty of invalid) {
      assert.throws(() => store.setFact(investigation.id, { topic: 'sleep_duration_hours', scope: 'sleep', value: 'about seven', uncertainty } as FactInput), /INVALID_FACT_UNCERTAINTY/);
    }
    for (const value of [7, true, false]) {
      assert.throws(() => store.setFact(investigation.id, { topic: 'sleep_duration_hours', scope: 'sleep', value, uncertainty: { kind: 'approximate', original: 'about seven' } }), /INVALID_FACT_UNCERTAINTY/);
    }
    assert.equal(store.getInvestigation(investigation.id).revision, investigation.revision);
    assert.deepEqual(store.snapshot(investigation.id).facts, []);
  } finally { cleanup(); }
});

test('bilingual approximate and uncertain answers retain wording without estimating a number or date', () => {
  const { store, cleanup } = fixture();
  try {
    const { id } = store.createInvestigation('Understand my sleep', 'en');
    const examples: Array<[string, FactUncertainty['kind']]> = [
      ['  about 7 hours  ', 'approximate'], ['around seven hours', 'approximate'],
      ['approximately 7 hours', 'approximate'], ['roughly 7 hours', 'approximate'],
      ['maybe 7 hours', 'uncertain'], ["I can't remember the time", 'uncertain'],
      ['大约七小时', 'approximate'], ['7个小时左右', 'approximate'],
      ['记不清，好像睡了七小时', 'uncertain'], ['不确定，可能是晚上十一点', 'uncertain'],
      ['around midnight yesterday', 'approximate'],
    ];
    for (const [value, kind] of examples) {
      ask(store, id, 'sleep_duration_hours');
      const fact = store.answer(id, value);
      assert.equal(fact.value, value);
      assert.equal(fact.status, 'known');
      assert.deepEqual(fact.uncertainty, { kind, original: value });
      assert.equal(store.getInvestigation(id).start, undefined);
      assert.equal(store.getInvestigation(id).end, undefined);
    }
    const report = store.buildReport(id);
    assert.equal(report.metrics.find(metric => metric.key === 'selfReportedSleepMinutes'), undefined);
  } finally { cleanup(); }
});

test('exact numeric answers remain compatible and vague-looking prose never gets parsed as a measurement', () => {
  const { store, cleanup } = fixture();
  try {
    const { id } = store.createInvestigation('Understand my sleep', 'en');
    for (const topic of ['sleep_duration_hours', 'remembered_awakenings']) {
      ask(store, id, topic);
      const exact = store.answer(id, ' 7.5 ');
      assert.equal(exact.value, 7.5);
      assert.equal(exact.uncertainty, undefined);
    }
    for (const value of ['2026-09-21', '23:30', 'I worried about work', '6–8 hours']) {
      ask(store, id, 'sleep_duration_hours');
      const fact = store.answer(id, value);
      assert.equal(fact.value, value);
      assert.equal(fact.uncertainty, undefined, 'do not infer uncertain dates or parse prose ranges');
    }
  } finally { cleanup(); }
});

test('skipped uncertainty keeps original wording but unknown remains null and does not block a report', () => {
  const { store, cleanup } = fixture();
  try {
    const { id } = store.createInvestigation('昨晚醒了多久', 'zh');
    ask(store, id, 'awake_duration');
    const skipped = store.answer(id, '记不清醒了多久', true);
    assert.equal(skipped.status, 'unknown');
    assert.equal(skipped.value, null);
    assert.deepEqual(skipped.uncertainty, { kind: 'uncertain', original: '记不清醒了多久' });
    const beforeReport = guidance(store, id);
    assert.equal(beforeReport.canReport, true);
    assert.ok(beforeReport.ambiguities.some(item => item.topic === 'awake_duration'));
    assert.ok(!beforeReport.nextActions.some(action => action.kind === 'clarify' && action.description.includes('awake_duration')));
    const unknown = store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', status: 'unknown', value: 'maybe seven', uncertainty: { kind: 'uncertain', original: 'maybe seven' } });
    assert.equal(unknown.value, null);
    assert.equal(unknown.uncertainty?.original, 'maybe seven');
    ask(store, id, 'recovery');
    const skippedWithoutKeyword = store.answer(id, 'I would prefer to leave this unanswered.', true);
    assert.equal(skippedWithoutKeyword.value, null);
    assert.deepEqual(skippedWithoutKeyword.uncertainty, { kind: 'uncertain', original: 'I would prefer to leave this unanswered.' });
    const report = store.buildReport(id);
    assert.equal(report.status, 'complete');
    assert.equal(report.metrics.find(metric => metric.key === 'selfReportedSleepMinutes'), undefined);
    assert.deepEqual(guidance(store, id).nextActions.map(action => action.kind), ['report']);
    assert.equal(store.nextQuestion(id), undefined);
  } finally { cleanup(); }
});

test('fact corrections clear obsolete uncertainty and only then enable exact self-report metrics', () => {
  const { store, cleanup } = fixture();
  try {
    const { id } = store.createInvestigation('Understand my sleep', 'en');
    const old = store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', value: 'maybe seven', uncertainty: { kind: 'uncertain', original: 'maybe seven' } });
    const before = store.buildReport(id);
    assert.equal(before.metrics.find(metric => metric.key === 'selfReportedSleepMinutes'), undefined);
    const corrected = store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', value: 7 });
    assert.equal(corrected.id, old.id);
    assert.equal(corrected.revision, old.revision + 1);
    assert.equal(corrected.uncertainty, undefined);
    assert.equal(store.snapshot(id).facts.find(fact => fact.id === old.id)?.uncertainty, undefined);
    assert.equal(store.snapshot(id).reports.find(report => report.id === before.id)?.status, 'stale');
    const after = store.buildReport(id);
    assert.equal(after.metrics.find(metric => metric.key === 'selfReportedSleepMinutes')?.value, 420);
  } finally { cleanup(); }
});

test('plan save and progress changes leave fact revisions and complete reports unchanged', () => {
  const { store, cleanup } = fixture();
  try {
    const { id } = store.createInvestigation('Understand my sleep', 'en');
    const report = store.buildReport(id);
    const before = store.getInvestigation(id);
    const input = plan(before.revision);
    const saved = store.savePlan(id, input);
    assert.equal(saved.revision, before.revision);
    assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
    assert.deepEqual(store.getInvestigation(id).plan, saved);
    input.steps[0].description = 'Caller mutation';
    assert.equal(store.getInvestigation(id).plan?.steps[0].description, 'Report what is known.');
    store.savePlan(id, { ...saved, steps: saved.steps.map(step => ({ ...step, status: 'done' })) });
    assert.equal(store.getInvestigation(id).revision, before.revision);
    assert.equal(store.getInvestigation(id).status, 'reported');
    assert.equal(store.snapshot(id).reports.find(item => item.id === report.id)?.status, 'complete');
    assert.equal(store.buildReport(id).id, report.id);
    assert.equal(guidance(store, id).planStatus, 'current');
  } finally { cleanup(); }
});

test('plan validation enforces bounded steps, unique ids and current revisions without mutations', () => {
  const { store, cleanup } = fixture();
  try {
    const { id, revision } = store.createInvestigation('Understand my sleep', 'en');
    const saved = store.savePlan(id, plan(revision));
    const invalid: unknown[] = [
      null, {}, { ...plan(revision), objective: ' ' }, { ...plan(revision), objective: 'x'.repeat(4_001) },
      { ...plan(revision), revision: 0 }, { ...plan(revision), revision: 1.5 },
      { ...plan(revision), steps: [] },
      { ...plan(revision), steps: Array.from({ length: 7 }, (_, index) => ({ ...saved.steps[0], id: `step-${index}` })) },
      { ...plan(revision), steps: [saved.steps[0], saved.steps[0]] },
      ...[
        null, { ...saved.steps[0], id: 'bad id' }, { ...saved.steps[0], id: '' },
        { ...saved.steps[0], kind: 'diagnose' }, { ...saved.steps[0], status: 'running' },
        { ...saved.steps[0], description: ' ' }, { ...saved.steps[0], description: 'x'.repeat(2_001) },
        { ...saved.steps[0], reason: 12 }, { ...saved.steps[0], reason: 'x'.repeat(2_001) },
      ].map(step => ({ ...plan(revision), steps: [step] })),
    ];
    for (const input of invalid) assert.throws(() => store.savePlan(id, input as InvestigationPlanInput), /INVALID_PLAN/);
    assert.throws(() => store.savePlan(id, plan(revision + 1)), /PLAN_STALE/);
    assert.throws(() => store.savePlan('not-found', plan(revision)), /INVESTIGATION_NOT_FOUND/);
    assert.deepEqual(store.getInvestigation(id).plan, saved);
    assert.equal(store.getInvestigation(id).revision, revision);
    const six = store.savePlan(id, plan(revision, Array.from({ length: 6 }, (_, index) => ({ id: `step-${index}`, kind: 'clarify', description: 'One useful detail.', status: 'pending' }))));
    assert.equal(six.steps.length, 6);
    assert.ok(guidance(store, id).nextActions.length <= 6);
  } finally { cleanup(); }
});

test('facts and targets stale saved plans, and guidance never reuses their pending actions', () => {
  const { store, cleanup } = fixture();
  try {
    const { id, revision } = store.createInvestigation('Understand my sleep', 'en');
    const old = store.savePlan(id, plan(revision, [{ id: 'old', kind: 'clarify', description: 'Old plan instruction.', status: 'pending' }]));
    assert.ok(guidance(store, id).nextActions.some(action => action.description === 'Old plan instruction.'));
    store.setFact(id, { topic: 'noise', scope: 'sleep', value: false });
    assert.equal(store.getInvestigation(id).plan?.revision, old.revision);
    assert.equal(guidance(store, id).planStatus, 'stale');
    assert.ok(!guidance(store, id).nextActions.some(action => action.description === 'Old plan instruction.'));
    assert.throws(() => store.savePlan(id, old), /PLAN_STALE/);
    store.savePlan(id, plan(store.getInvestigation(id).revision));
    assert.equal(guidance(store, id).planStatus, 'current');
    store.setTarget(id, target);
    assert.equal(guidance(store, id).planStatus, 'stale');
    store.savePlan(id, plan(store.getInvestigation(id).revision));
    assert.equal(guidance(store, id).planStatus, 'current');
  } finally { cleanup(); }
});

test('profile and episode facts remain separate and invalidate plans only in their own scope', () => {
  const { store, cleanup } = fixture();
  try {
    const a = store.createInvestigation('First episode', 'en');
    const b = store.createInvestigation('Second episode', 'en');
    store.savePlan(a.id, plan(a.revision));
    store.savePlan(b.id, plan(b.revision));
    const personal = store.setFact(a.id, { topic: 'bedtime', scope: 'sleep', value: 'around midnight', uncertainty: { kind: 'approximate', original: 'around midnight' } });
    assert.equal(guidance(store, a.id).planStatus, 'stale');
    assert.equal(guidance(store, b.id).planStatus, 'current');
    assert.ok(!store.snapshot(b.id).facts.some(fact => fact.id === personal.id));
    const profile = store.setFact(a.id, { topic: 'bedtime', scope: 'profile', value: 'usually around 23:00', uncertainty: { kind: 'approximate', original: 'usually around 23:00' } });
    assert.notEqual(profile.id, personal.id);
    assert.equal(profile.investigationId, undefined);
    assert.equal(guidance(store, b.id).planStatus, 'stale');
    assert.deepEqual(store.snapshot(a.id).facts.filter(fact => fact.topic === 'bedtime').map(fact => fact.scope).sort(), ['profile', 'sleep']);
    const bFacts = store.snapshot(b.id).facts;
    assert.deepEqual(bFacts.filter(fact => fact.topic === 'bedtime').map(fact => fact.scope), ['profile']);
    const safeGuidance = buildInvestigationGuidance(store.getInvestigation(b.id), [...bFacts, personal]);
    assert.ok(safeGuidance.ambiguities.some(item => item.id === profile.id));
    assert.ok(!safeGuidance.ambiguities.some(item => item.id === personal.id));
  } finally { cleanup(); }
});

test('guidance separates time uncertainty and target selection, skips done or blocked steps, and allows early reports', () => {
  const { store, cleanup } = fixture();
  try {
    const { id } = store.createInvestigation('Understand my sleep', 'en');
    assert.equal(guidance(store, id).planStatus, 'missing');
    assert.equal(guidance(store, id).canReport, true);
    assert.ok(guidance(store, id).ambiguities.some(item => item.kind === 'target'));
    ask(store, id, 'bedtime');
    const time = store.answer(id, 'around 23:30');
    assert.ok(guidance(store, id).ambiguities.some(item => item.id === time.id && item.kind === 'time'));
    const steps: InvestigationPlanStep[] = [
      { id: 'query', kind: 'query', description: 'Query selected evidence.', status: 'pending' },
      { id: 'done', kind: 'clarify', description: 'Already asked.', status: 'done' },
      { id: 'blocked', kind: 'clarify', description: 'Unavailable answer.', status: 'blocked', reason: 'User cannot remember.' },
    ];
    store.savePlan(id, plan(store.getInvestigation(id).revision, steps));
    let result = guidance(store, id);
    assert.ok(!result.nextActions.some(action => action.kind === 'query'));
    assert.ok(!result.nextActions.some(action => ['Already asked.', 'Unavailable answer.'].includes(action.description)));
    assert.ok(result.nextActions.some(action => action.kind === 'report'));
    store.setTarget(id, target);
    store.savePlan(id, plan(store.getInvestigation(id).revision, steps));
    result = guidance(store, id);
    assert.ok(!result.ambiguities.some(item => item.kind === 'target'));
    assert.ok(result.nextActions.some(action => action.description === 'Query selected evidence.'));
    assert.equal(result.canReport, true);
    assert.equal(store.buildReport(id).status, 'complete');
    assert.deepEqual(guidance(store, id).nextActions.map(action => action.kind), ['report']);
  } finally { cleanup(); }
});

test('uncertainty and plan revision state persist on reload without a snapshot shape change', () => {
  const { home, store, cleanup } = fixture();
  try {
    const { id } = store.createInvestigation('Understand my sleep', 'en');
    const keys = Object.keys(store.snapshot(id)).sort();
    const fact = store.setFact(id, { topic: 'usual_schedule', scope: 'profile', status: 'unknown', value: null, uncertainty: { kind: 'uncertain', original: 'I cannot remember my usual bedtime' } });
    const saved = store.savePlan(id, plan(store.getInvestigation(id).revision));
    const reopened = new SleepStore(home);
    try {
      assert.deepEqual(Object.keys(reopened.snapshot(id)).sort(), keys);
      assert.deepEqual(reopened.getInvestigation(id).plan, saved);
      assert.deepEqual(reopened.snapshot(id).facts.find(item => item.id === fact.id), store.snapshot(id).facts.find(item => item.id === fact.id));
      assert.equal(guidance(reopened, id).planStatus, 'current');
      reopened.setFact(id, { topic: 'noise', scope: 'sleep', value: false });
      assert.equal(guidance(store, id).planStatus, 'stale');
    } finally { reopened.close(); }
  } finally { cleanup(); }
});

test('deleting a fact or profile also removes plans that may retain deleted information', () => {
  const { store, cleanup } = fixture();
  try {
    const a = store.createInvestigation('First episode', 'en');
    const b = store.createInvestigation('Second episode', 'en');
    const fact = store.setFact(a.id, { topic: 'recovery', scope: 'sleep', value: 'A personal recollection.' });
    const steps: InvestigationPlanStep[] = [{ id: 'follow-up', kind: 'clarify', description: 'Ask about a personal recollection.', status: 'pending' }];
    store.savePlan(a.id, plan(store.getInvestigation(a.id).revision, steps));
    const unrelated = store.savePlan(b.id, plan(store.getInvestigation(b.id).revision));
    store.deleteFact(fact.id);
    assert.equal(store.getInvestigation(a.id).plan, undefined);
    assert.deepEqual(store.getInvestigation(b.id).plan, unrelated);
    store.setFact(a.id, { topic: 'work_pattern', scope: 'profile', value: 'Night shifts.' });
    store.savePlan(a.id, plan(store.getInvestigation(a.id).revision, steps));
    store.savePlan(b.id, plan(store.getInvestigation(b.id).revision, steps));
    store.clearProfile();
    assert.equal(store.getInvestigation(a.id).plan, undefined);
    assert.equal(store.getInvestigation(b.id).plan, undefined);
  } finally { cleanup(); }
});

test('deleting an import clears plans even before a candidate has been selected', async () => {
  const { home, store, cleanup } = fixture();
  try {
    const path = join(home, 'test-export.xml');
    writeFileSync(path, '<HealthData><Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Test Watch" startDate="2026-09-20 23:00:00 +0800" endDate="2026-09-21 06:00:00 +0800" value="HKCategoryValueSleepAnalysisAsleepCore"/></HealthData>');
    const imported = await store.importFile(path);
    const { id, revision } = store.createInvestigation('Check the imported candidate', 'en');
    store.savePlan(id, plan(revision, [{ id: 'candidate', kind: 'clarify', description: 'Confirm the imported sleep candidate.', status: 'pending' }]));
    assert.equal(store.getInvestigation(id).start, undefined);
    store.deleteImport(imported.id);
    assert.equal(store.getInvestigation(id).plan, undefined);
  } finally { cleanup(); }
});
