import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SleepStore } from '../src/domain/index.js';
import type { Fact } from '../src/shared/types.js';
import { createSleepTools } from '../src/tools.js';

// Independent review counterexamples. All statements, owners and timestamps are
// synthetic; raw SQLite rows model the pre-contract persistence format.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-b06-review-'));
  let store = new SleepStore(home);
  return { home, get store() { return store; },
    reopen(change?: (db: DatabaseSync) => void) {
      store.close();
      if (change) { const db = new DatabaseSync(join(home, 'sleepclaw.sqlite')); try { change(db); } finally { db.close(); } }
      store = new SleepStore(home);
    },
    cleanup() { store.close(); assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); rmSync(home, { recursive: true, force: true }); },
  };
}
function legacy(db: DatabaseSync, owner: string, facts: Array<Partial<Fact> & { id: string; topic: string }>) {
  db.prepare('DELETE FROM migrations WHERE id=?').run('fact-contract-v1');
  for (const input of facts) {
    const fact = { scope: 'sleep', status: 'known', value: 'Synthetic legacy statement', investigationId: owner, sleepEpisodeId: owner, revision: 1, updatedAt: '2026-09-01T00:00:00.000Z', ...input };
    db.prepare('INSERT OR REPLACE INTO facts(id,owner,topic,data) VALUES(?,?,?,?)').run(fact.id, owner, fact.topic, JSON.stringify(fact));
  }
}

for (const [topic, value] of [
  ['sleep_duration_hours', 'about thirteen hours'], ['sleep_duration', 'around twenty minutes'],
  ['sleep_duration_hours', 'approximately .5 hours'], ['sleep_duration_hours', 'roughly nineteen hours'],
  ['sleep_duration', 'approx. zero hours'], ['remembered_awakenings', 'about zero times'],
  ['remembered_awakenings', 'approximately fourteen awakenings'], ['remembered_awakenings', 'around .5 times'],
] as const) test(`B06 review approximate phrase remains non-exact: ${value}`, () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic approximation review', 'en').id;
    const saved = f.store.setFact(id, { scope: 'sleep', topic, value });
    assert.equal(saved.value, value, 'recognizing a number must not discard its approximation qualifier');
    assert.equal(saved.uncertainty?.kind, 'approximate');
    assert.equal(saved.uncertainty?.original, value);
    const report = f.store.buildReport(id);
    assert.equal(report.metrics.some(metric => ['selfReportedSleepMinutes', 'rememberedAwakenings'].includes(metric.key)), false);
    assert.ok(report.reportedFacts?.some(fact => fact.value === value));
    f.reopen();
    assert.equal(f.store.snapshot(id).facts[0].value, value);
  } finally { f.cleanup(); }
});

for (const topic of ['constructor', 'toString', 'valueOf']) test(`B06 review custom topic ${topic} cannot resolve through Object.prototype`, async () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic custom topic contract', 'en').id;
    const tool = createSleepTools(f.store).find(tool => tool.name === 'sleep_fact')!;
    await tool.execute({ investigationId: id, scope: 'sleep', topic, value: 'Synthetic custom record' });
    const fact = f.store.snapshot(id).facts.find(item => item.topic === topic);
    assert.ok(fact, 'valid custom topic keys remain unchanged strings');
    const report = f.store.buildReport(id);
    assert.ok(report.reportedFacts?.some(item => item.topic === topic));
    assert.match(report.markdown, new RegExp(topic));
    f.store.deleteFact(fact.id);
    assert.equal(f.store.snapshot(id).facts.length, 0);
  } finally { f.cleanup(); }
});

for (const paused of [false, true]) test(`B06 review migration removes an already-handled default ${paused ? 'paused' : 'pending'} alias question`, () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic legacy default question', 'en').id;
    f.store.answer(id, 'Synthetic age'); f.store.answer(id, 'Synthetic usual schedule');
    assert.equal(f.store.snapshot(id).question?.topic, 'sleep_duration_hours');
    if (paused) f.store.buildReport(id);
    f.reopen(db => legacy(db, id, [{ id: 'legacy-duration', topic: 'sleep_duration', value: '7 hours' }]));
    assert.equal(f.store.snapshot(id).facts.find(fact => fact.topic === 'sleep_duration_hours')?.value, 7);
    assert.notEqual(f.store.snapshot(id).question?.topic, 'sleep_duration_hours');
    assert.equal(f.store.resumeCollection(id)?.topic, 'remembered_awakenings', 'continuation moves to the next unhandled fixed topic');
  } finally { f.cleanup(); }
});

test('B06 review migration preserves a custom clarification even when its canonical topic is already known', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic legacy clarification', 'en').id;
    const question = { id: 'synthetic-clarification', topic: 'sleep_duration_hours', scope: 'sleep' as const, text: 'Synthetic clarification: does your estimate exclude the awake interval?', reason: 'Synthetic user clarification request.' };
    f.store.saveQuestion(id, question); f.store.buildReport(id);
    f.reopen(db => legacy(db, id, [{ id: 'legacy-duration', topic: 'sleep_duration', value: '7 hours' }]));
    assert.deepEqual(f.store.resumeCollection(id), question, 'migration must not delete a deliberate follow-up merely because its topic has a value');
  } finally { f.cleanup(); }
});

test('B06 review a future-dated legacy alias cannot resurrect after an unknown correction and deletion', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic future legacy timestamps', 'en').id;
    f.reopen(db => legacy(db, id, [
      { id: 'canonical-old', topic: 'sleep_duration_hours', value: 6, revision: 2, updatedAt: '2026-09-02T00:00:00Z' },
      { id: 'alias-future', topic: 'sleep_duration', value: '8 hours', revision: 1, updatedAt: '2100-01-01T00:00:00Z' },
    ]));
    assert.equal(f.store.snapshot(id).facts[0].value, 8);
    const corrected = f.store.setFact(id, { scope: 'sleep', topic: 'sleep_duration', value: 'I cannot remember', status: 'unknown' });
    assert.equal(corrected.status, 'unknown');
    f.reopen();
    const facts = f.store.snapshot(id).facts;
    assert.equal(facts.length, 1);
    assert.equal(facts[0].value, null);
    assert.equal(f.store.buildReport(id).metrics.some(metric => metric.key === 'selfReportedSleepMinutes'), false);
    f.store.deleteFact(facts[0].id); f.reopen();
    assert.deepEqual(f.store.snapshot(id).facts, []);
    assert.equal(f.store.buildReport(id).metrics.some(metric => metric.key === 'selfReportedSleepMinutes'), false);
  } finally { f.cleanup(); }
});

test('B06 review a newer unknown legacy alias suppresses an older known canonical recovery', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic unknown recovery precedence', 'en').id;
    f.reopen(db => legacy(db, id, [
      { id: 'old-recovery', topic: 'recovery', value: 'SYNTHETIC_OLD_RECOVERY', updatedAt: '2026-09-01T00:00:00Z' },
      { id: 'new-recovery', topic: 'wake_feeling', value: null, status: 'unknown', updatedAt: '2026-09-02T00:00:00Z' },
    ]));
    const report = f.store.buildReport(id);
    assert.doesNotMatch(report.dimensions.find(dimension => dimension.key === 'recovery')!.text, /SYNTHETIC_OLD_RECOVERY/);
    assert.equal(report.reportedFacts?.filter(fact => fact.topic === 'recovery').length, 1);
    assert.equal(report.reportedFacts?.find(fact => fact.topic === 'recovery')?.status, 'unknown');
    f.store.deleteFact(f.store.snapshot(id).facts[0].id); f.reopen();
    assert.deepEqual(f.store.snapshot(id).facts, []);
  } finally { f.cleanup(); }
});

test('B06 review legacy minute ranges are normalized once and never become an exact metric across reopen', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic minute-range migration', 'en').id;
    const original = 'Synthetic recalled range of 360 to 420 minutes';
    f.reopen(db => legacy(db, id, [{ id: 'legacy-range', topic: 'sleep_duration', value: original,
      uncertainty: { kind: 'range', original, lower: 360, upper: 420, unit: 'minutes' } }]));
    const revision = f.store.getInvestigation(id).revision;
    for (let restart = 0; restart < 3; restart++) {
      const fact = f.store.snapshot(id).facts[0];
      assert.equal(fact.value, original);
      assert.deepEqual(fact.uncertainty, { kind: 'range', original, lower: 6, upper: 7, unit: 'hours' });
      const report = f.store.buildReport(id);
      assert.match(report.dimensions.find(dimension => dimension.key === 'duration')!.text, /6–7 hours/);
      assert.equal(report.metrics.some(metric => metric.key === 'selfReportedSleepMinutes'), false);
      f.reopen();
      assert.equal(f.store.getInvestigation(id).revision, revision, 'the one-time migration must not re-invalidate reports on every app launch');
    }
  } finally { f.cleanup(); }
});

for (const value of ['seven hours and thirty minutes', '6 hours to 420 minutes', '23:00–07:00', '2026-09-01', 'at least seven hours', 'no more than 7 hours']) test(`B06 review conservative grammar keeps ambiguous duration verbatim: ${value}`, () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic whole-answer grammar boundary', 'en').id;
    const fact = f.store.setFact(id, { scope: 'sleep', topic: 'sleep_duration', value });
    assert.equal(fact.value, value);
    const report = f.store.buildReport(id);
    assert.equal(report.metrics.some(metric => metric.key === 'selfReportedSleepMinutes'), false);
    assert.ok(report.reportedFacts?.some(item => item.value === value));
  } finally { f.cleanup(); }
});
