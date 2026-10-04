import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SleepStore } from '../src/domain/index.js';
import { questionDefinitions } from '../src/domain/questions.js';
import type { Fact } from '../src/shared/types.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-questionnaire-progress-'));
  let store = new SleepStore(home);
  return { home, get store() { return store; }, reopen(edit?: (db: DatabaseSync) => void) {
    store.close();
    if (edit) { const db = new DatabaseSync(join(home, 'sleepclaw.sqlite')); try { edit(db); } finally { db.close(); } }
    store = new SleepStore(home);
  }, cleanup() { store.close(); assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); rmSync(home, { recursive: true, force: true }); } };
}
const target = (day: number) => ({ start: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`, end: `2026-09-${String(day).padStart(2, '0')}T08:00:00Z`, source: 'Synthetic Watch' });
const expected = (known: number, skipped: number, phase = 'basics') => ({ total: 14, completed: known + skipped, known, skipped, remaining: 14 - known - skipped, phase });
function fillBasics(store: SleepStore, id: string) {
  for (const definition of questionDefinitions(store.getInvestigation(id).language)) store.setFact(id, { topic: definition.topic, scope: definition.scope, value: 'Synthetic answer' });
  store.nextQuestion(id);
}

for (const language of ['zh', 'en'] as const) test(`Questionnaire progress ${language}: fixed answers and skips advance 0 through 14 without requiring a report`, () => {
  const f = fixture();
  try {
    assert.equal(f.store.snapshot().collectionProgress, undefined);
    const id = f.store.createInvestigation('Synthetic progress', language).id;
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(0, 0));
    let known = 0, skipped = 0;
    for (let step = 0; step < 14; step++) {
      const skip = step % 3 === 1;
      f.store.answer(id, skip ? null : 'Synthetic answer', skip);
      skip ? skipped++ : known++;
      assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(known, skipped, step === 13 ? 'ready' : 'basics'));
    }
    assert.equal(f.store.snapshot(id).reports.length, 0, '14/14 only describes basic collection, not completed AI analysis');
    assert.equal(f.store.snapshot(id).question, undefined);
  } finally { f.cleanup(); }
});

test('Questionnaire progress dynamic questions and clarifications do not grow the fixed denominator', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic adaptive questions', 'en').id;
    f.store.answer(id, 'Synthetic age range');
    f.store.saveQuestion(id, { id: 'synthetic-custom', topic: 'custom_noise', scope: 'sleep', text: 'Synthetic follow-up?', reason: 'Synthetic detail needed about the timing of this interruption.' });
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(1, 0, 'followup'));
    f.store.answer(id, 'Synthetic fan noise');
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(1, 0));
    fillBasics(f.store, id);
    f.store.saveQuestion(id, { id: 'synthetic-clarification', topic: 'wake_feeling', scope: 'sleep', text: 'Synthetic clarification?', reason: 'Distinguish immediate waking recovery from later daytime tiredness.' });
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(14, 0, 'followup'));
    f.store.answer(id, 'Synthetic clarified recovery');
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(14, 0, 'ready'));
  } finally { f.cleanup(); }
});

test('Questionnaire progress early reports pause collection and reopen/resume preserves the count and original question', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic report pause', 'zh').id;
    f.store.answer(id, 'Synthetic age range');
    const question = f.store.snapshot(id).question;
    const report = f.store.buildReport(id);
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(1, 0, 'paused'));
    assert.equal(f.store.buildReport(id).id, report.id);
    f.reopen();
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(1, 0, 'paused'));
    assert.deepEqual(f.store.resumeCollection(id), question);
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(1, 0));
    fillBasics(f.store, id); f.store.buildReport(id);
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(14, 0, 'reported'));
    f.store.resumeCollection(id);
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(14, 0, 'ready'));
  } finally { f.cleanup(); }
});

test('Questionnaire progress collection pause alone cannot claim a report exists, and full-basics follow-up can pause', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic pre-analysis pause', 'en').id;
    fillBasics(f.store, id);
    f.store.pauseCollection(id);
    assert.equal(f.store.snapshot(id).reports.length, 0);
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(14, 0, 'ready'));
    f.store.saveQuestion(id, { id: 'synthetic-more', topic: 'custom_detail', scope: 'sleep', text: 'Synthetic extra detail?' });
    f.store.buildReport(id);
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(14, 0, 'paused'));
    f.store.resumeCollection(id);
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(14, 0, 'followup'));
  } finally { f.cleanup(); }
});

test('Questionnaire progress inherits ten profile items while sleep answers remain episode and investigation specific', () => {
  const f = fixture();
  try {
    const first = f.store.createInvestigation('Synthetic first night', 'en').id;
    f.store.setTarget(first, target(1)); fillBasics(f.store, first);
    const firstEpisode = f.store.getInvestigation(first).sleepEpisodeId;
    f.store.setFact(first, { topic: 'medications', scope: 'profile', value: null, status: 'unknown' });
    assert.deepEqual(f.store.snapshot(first).collectionProgress, expected(13, 1, 'ready'));
    f.store.setTarget(first, { ...target(1), source: 'Synthetic Other Watch' });
    assert.equal(f.store.getInvestigation(first).sleepEpisodeId, firstEpisode);
    assert.deepEqual(f.store.snapshot(first).collectionProgress, expected(13, 1, 'ready'));
    f.store.setTarget(first, target(2));
    assert.deepEqual(f.store.snapshot(first).collectionProgress, expected(9, 1));
    f.store.answer(first, '7 hours');
    assert.deepEqual(f.store.snapshot(first).collectionProgress, expected(10, 1));
    const second = f.store.createInvestigation('Synthetic separate investigation', 'zh').id;
    f.store.setTarget(second, target(1));
    assert.deepEqual(f.store.snapshot(second).collectionProgress, expected(9, 1));
    f.store.setTarget(first, target(1));
    assert.deepEqual(f.store.snapshot(first).collectionProgress, expected(13, 1, 'ready'));
    f.reopen();
    assert.deepEqual(f.store.snapshot(second).collectionProgress, expected(9, 1));
  } finally { f.cleanup(); }
});

test('Questionnaire progress canonical aliases count once, wrong scopes and custom facts do not fill basic slots', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic field identity', 'zh').id;
    f.store.setFact(id, { topic: 'sleep_duration', scope: 'sleep', value: '六到七小时' });
    f.store.setFact(id, { topic: 'wake_feeling', scope: 'sleep', value: 'Synthetic tired feeling' });
    f.store.setFact(id, { topic: 'waking_feeling', scope: 'sleep', value: null, status: 'unknown' });
    for (const fact of [{ topic: 'sleep_duration_hours', scope: 'profile' }, { topic: 'usual_schedule', scope: 'sleep' }, { topic: 'sleep_complaint', scope: 'sleep' }] as const) f.store.setFact(id, { ...fact, value: 'Synthetic custom context' });
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(1, 1));
    f.store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', value: '6.5' });
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(1, 1));
    f.store.setFact(id, { topic: 'recovery', scope: 'sleep', value: 'Synthetic corrected feeling' });
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(2, 0));
  } finally { f.cleanup(); }
});

test('Questionnaire progress legacy alias conflicts use the projected current winner including an unknown correction', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic legacy duplicates', 'en').id;
    const episodeId = f.store.getInvestigation(id).sleepEpisodeId!;
    f.reopen(db => {
      for (const [index, topic] of ['sleep_duration', 'sleep_duration_hours', 'wake_feeling', 'recovery'].entries()) {
        const unknown = topic === 'sleep_duration_hours';
        const fact: Fact = { id: `synthetic-legacy-${index}`, topic, scope: 'sleep', status: unknown ? 'unknown' : 'known', value: unknown ? null : 'Synthetic old answer', investigationId: id, sleepEpisodeId: episodeId, revision: index + 1, updatedAt: `2026-09-0${index + 1}T00:00:00Z` };
        db.prepare('INSERT INTO facts (id,owner,topic,data) VALUES (?,?,?,?)').run(fact.id, episodeId, topic, JSON.stringify(fact));
      }
    });
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(1, 1));
    f.store.deleteFact(f.store.snapshot(id).facts.find(fact => fact.topic === 'sleep_duration_hours')!.id);
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(1, 0));
    f.reopen(); assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(1, 0));
  } finally { f.cleanup(); }
});

test('Questionnaire progress deletions retreat while corrections change only known/skipped and language leaves counts unchanged', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic corrections', 'zh').id;
    fillBasics(f.store, id); f.store.buildReport(id);
    f.store.setFact(id, { topic: 'recovery', scope: 'sleep', value: null, status: 'unknown' });
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(13, 1, 'ready'));
    f.store.deleteFact(f.store.snapshot(id).facts.find(fact => fact.topic === 'recovery')!.id);
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(13, 0));
    assert.equal(f.store.nextQuestion(id)?.topic, 'recovery');
    f.store.setLanguage(id, 'en');
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(13, 0));
    f.store.answer(id, 'Synthetic corrected feeling');
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(14, 0, 'ready'));
    f.store.clearProfile();
    assert.deepEqual(f.store.snapshot(id).collectionProgress, expected(4, 0));
  } finally { f.cleanup(); }
});

test('Questionnaire progress snapshots are read-only and unchanged after reopening a reported investigation', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic immutable progress', 'en').id;
    f.store.answer(id, null, true);
    const report = f.store.buildReport(id), before = f.store.snapshot(id), investigation = f.store.getInvestigation(id);
    const modified = f.store.snapshot(id).collectionProgress!;
    modified.completed = 999; modified.phase = 'reported';
    const reportFile = join(f.home, 'reports', `${report.id}.json`), timestamp = statSync(reportFile).mtimeMs;
    for (let read = 0; read < 5; read++) assert.deepEqual(f.store.snapshot(id), before);
    assert.deepEqual(f.store.getInvestigation(id), investigation);
    assert.equal(statSync(reportFile).mtimeMs, timestamp);
    f.reopen(); assert.deepEqual(f.store.snapshot(id).collectionProgress, before.collectionProgress);
  } finally { f.cleanup(); }
});

test('Questionnaire progress seeded corrections, deletions, cross-night resumes and reports preserve count invariants', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic progress combinations', 'en').id;
    const definitions = questionDefinitions('en'), profile = new Map<string, boolean>(), nights = [new Map<string, boolean>(), new Map<string, boolean>(), new Map<string, boolean>()];
    let night = 0, seed = 60931;
    const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    f.store.setTarget(id, target(1));
    for (let step = 0; step < 90; step++) {
      const definition = definitions[random(14)], ledger = definition.scope === 'profile' ? profile : nights[night];
      switch (random(6)) {
        case 0: case 1: {
          const known = random(3) !== 0;
          f.store.setFact(id, { topic: definition.topic, scope: definition.scope, value: known ? 'Synthetic revision' : null, status: known ? 'known' : 'unknown' }); ledger.set(definition.topic, known); break;
        }
        case 2: {
          const fact = f.store.snapshot(id).facts.find(item => item.scope === definition.scope && item.topic === definition.topic);
          if (fact) { f.store.deleteFact(fact.id); ledger.delete(definition.topic); } break;
        }
        case 3: night = random(3); f.store.setTarget(id, target(night + 1)); break;
        case 4: f.store.buildReport(id); if (random(2)) f.store.resumeCollection(id); break;
        case 5: f.reopen(); break;
      }
      const values = [...profile.values(), ...nights[night].values()], known = values.filter(Boolean).length;
      const progress = f.store.snapshot(id).collectionProgress!;
      assert.deepEqual({ ...progress, phase: 'basics' }, expected(known, values.length - known), `seeded step ${step}`);
    }
  } finally { f.cleanup(); }
});
