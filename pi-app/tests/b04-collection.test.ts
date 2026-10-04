import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SleepApp } from '../src/controller.js';
import { SleepStore } from '../src/domain/index.js';
import { createSleepTools, sleepContext } from '../src/tools.js';
import type { AppEvent, Language, Question } from '../src/shared/types.js';

// All answers, goals and health records in this suite are synthetic. Expected
// order and scope are an independent product contract, not a call to the chooser.
const topics: Array<[Question['scope'], string]> = [
  ['profile', 'age_range'], ['profile', 'usual_schedule'], ['sleep', 'sleep_duration_hours'],
  ['sleep', 'remembered_awakenings'], ['sleep', 'recovery'], ['sleep', 'recent_context'],
  ['profile', 'work_pattern'], ['profile', 'medications'], ['profile', 'usual_caffeine'],
  ['profile', 'usual_alcohol'], ['profile', 'usual_exercise'], ['profile', 'sleep_environment'],
  ['profile', 'daytime_energy'], ['profile', 'sleep_goal'],
];
const first = { start: '2026-09-01T23:00:00.000Z', end: '2026-09-02T07:00:00.000Z', source: 'Synthetic Watch' };
const second = { start: '2026-09-02T23:00:00.000Z', end: '2026-09-03T07:00:00.000Z', source: 'Synthetic Watch' };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-b04-collection-'));
  let store = new SleepStore(home);
  return { home, get store() { return store; },
    reopen(change?: (db: DatabaseSync) => void) {
      store.close();
      if (change) { const db = new DatabaseSync(join(home, 'sleepclaw.sqlite')); try { change(db); } finally { db.close(); } }
      store = new SleepStore(home); return store;
    },
    cleanup() {
      store.close();
      assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep), 'remove only the synthetic fixture directory');
      rmSync(home, { recursive: true, force: true });
    },
  };
}
function pair(question: Question | undefined) { return question && [question.scope, question.topic]; }
function fill(store: SleepStore, id: string, count: number, unknown = false) {
  for (const [scope, topic] of topics.slice(0, count)) store.setFact(id, { scope, topic, value: unknown ? null : 'Synthetic answer', ...(unknown ? { status: 'unknown' as const } : {}) });
  return store.nextQuestion(id);
}
function exported(home: string, id: string) {
  return ['json', 'md'].map(extension => {
    const path = join(home, 'reports', `${id}.${extension}`);
    return { content: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs };
  });
}

test('B04 original failure: reporting after two answers preserves a resumable third question', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic sleep report', 'zh').id;
    f.store.answer(id, 'Synthetic age'); f.store.answer(id, 'Synthetic schedule');
    const before = f.store.snapshot(id).question!;
    assert.deepEqual(pair(before), ['sleep', 'sleep_duration_hours']);
    const report = f.store.buildReport(id);
    assert.equal(report.status, 'complete');
    assert.equal(f.store.snapshot(id).question, undefined, 'report delivery must stop questioning immediately');
    assert.deepEqual(f.store.getInvestigation(id).pausedQuestion, before, 'the unanswered question must survive report delivery');
    assert.equal(f.store.snapshot(id).canResume, true);
    assert.deepEqual(f.store.resumeCollection(id), before);
  } finally { f.cleanup(); }
});

for (const language of ['zh', 'en'] as const) for (const count of [0, 1, 2, topics.length]) {
  test(`B04 ${language}: report after ${count} answers resumes the first missing topic without altering evidence`, () => {
    const f = fixture();
    try {
      const id = f.store.createInvestigation('Synthetic optional collection', language).id;
      const question = fill(f.store, id, count);
      const report = f.store.buildReport(id);
      const before = f.store.snapshot(id);
      const files = exported(f.home, report.id);
      assert.equal(before.canResume, count < topics.length);
      assert.equal(before.question, undefined);
      assert.equal(f.store.nextQuestion(id), undefined, 'reporting never automatically reopens questions');
      assert.deepEqual(f.store.resumeCollection(id), question);
      const after = f.store.snapshot(id);
      assert.equal(after.active!.status, count < topics.length ? 'collecting' : 'ready');
      assert.deepEqual(pair(after.question), topics[count]);
      assert.equal(after.active!.pausedQuestion, undefined);
      assert.equal(after.active!.revision, before.active!.revision);
      assert.deepEqual(after.facts, before.facts);
      assert.deepEqual(after.reports, before.reports);
      assert.deepEqual(exported(f.home, report.id), files, 'resuming must not rewrite exported report bytes or timestamps');
      assert.equal(after.canResume, false, 'the resume affordance is only for paused collection');
      if (after.question) assert.match(after.question.text, language === 'zh' ? /[\u4e00-\u9fff]/ : /[A-Za-z]/);
    } finally { f.cleanup(); }
  });
}

test('B04 repeated report and resume are idempotent and keep the original question identity', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic repeated actions', 'en').id;
    const question = fill(f.store, id, 2)!;
    const report = f.store.buildReport(id);
    for (let round = 0; round < 5; round++) {
      assert.equal(f.store.buildReport(id).id, report.id);
      assert.deepEqual(f.store.getInvestigation(id).pausedQuestion, question);
      const files = exported(f.home, report.id);
      assert.deepEqual(f.store.resumeCollection(id), question);
      assert.deepEqual(f.store.resumeCollection(id), question);
      assert.deepEqual(exported(f.home, report.id), files);
      assert.equal(f.store.snapshot(id).reports.length, 1);
    }
  } finally { f.cleanup(); }
});

test('B04 pauses persist across repeated database reopen and resume remains explicit', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic persistence', 'zh').id;
    const question = fill(f.store, id, 1)!;
    f.store.buildReport(id);
    for (let i = 0; i < 3; i++) {
      f.reopen();
      assert.equal(f.store.snapshot(id).canResume, true);
      assert.equal(f.store.snapshot(id).question, undefined);
      assert.equal(f.store.nextQuestion(id), undefined);
      assert.deepEqual(f.store.getInvestigation(id).pausedQuestion, question);
    }
    assert.deepEqual(f.store.resumeCollection(id), question);
    f.reopen();
    assert.deepEqual(f.store.snapshot(id).question, question);
    assert.equal(f.store.snapshot(id).canResume, false);
  } finally { f.cleanup(); }
});

for (const status of ['known', 'unknown'] as const) test(`B04 ${status} answers count as handled after resume and are never asked again`, () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic complete collection', 'en').id;
    for (let index = 0; index < topics.length; index++) {
      const question = f.store.snapshot(id).question;
      assert.deepEqual(pair(question), topics[index]);
      f.store.buildReport(id);
      assert.deepEqual(f.store.resumeCollection(id), question);
      f.store.answer(id, status === 'unknown' ? null : 'Synthetic answer', status === 'unknown');
      const facts = f.store.snapshot(id).facts;
      assert.equal(facts.length, index + 1);
      assert.equal(facts.at(-1)!.status, status);
      assert.equal(facts.at(-1)!.value, status === 'unknown' ? null : 'Synthetic answer');
    }
    const report = f.store.buildReport(id);
    assert.equal(f.store.snapshot(id).canResume, false);
    assert.equal(f.store.resumeCollection(id), undefined);
    assert.equal(f.store.nextQuestion(id), undefined);
    assert.equal(f.store.snapshot(id).reports.find(item => item.id === report.id)!.status, 'complete');
  } finally { f.cleanup(); }
});

for (const language of ['zh', 'en'] as const) test(`B04 ${language}: custom clarification of an already known topic survives pause verbatim`, () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic contextual clarification', language).id;
    fill(f.store, id, topics.length);
    const custom: Question = { id: 'custom-known-topic', scope: 'sleep', topic: 'recovery',
      text: language === 'zh' ? '合成澄清：恢复感变化持续了多久？' : 'Synthetic clarification: how long did that change last?',
      reason: 'Synthetic reason specific to the user answer.' };
    f.store.saveQuestion(id, custom);
    f.store.buildReport(id);
    assert.equal(f.store.snapshot(id).canResume, true, 'an explicit custom clarification is still pending even when all fixed topics have facts');
    f.reopen();
    assert.deepEqual(f.store.resumeCollection(id), custom);
    assert.deepEqual(f.store.snapshot(id).question, custom);
    f.store.answer(id, 'Synthetic clarified value');
    assert.equal(f.store.snapshot(id).facts.filter(item => item.topic === 'recovery' && item.scope === 'sleep').length, 1);
    assert.equal(f.store.nextQuestion(id), undefined);
  } finally { f.cleanup(); }
});

test('B04 fixed paused question changes language but retains identity and custom wording survives language changes', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic translation', 'zh').id;
    const original = f.store.snapshot(id).question!;
    f.store.buildReport(id);
    f.store.setLanguage(id, 'en');
    const english = f.store.getInvestigation(id).pausedQuestion!;
    assert.equal(english.id, original.id);
    assert.deepEqual(pair(english), pair(original));
    assert.equal(english.text, 'What is your approximate age range?');
    assert.match(english.reason!, /^This helps/);
    assert.equal(f.store.snapshot(id).question, undefined);
    assert.deepEqual(f.store.resumeCollection(id), english);
    f.store.buildReport(id);
    f.store.setLanguage(id, 'zh');
    assert.deepEqual(f.store.resumeCollection(id), original);
    const custom: Question = { id: 'custom-fixed-topic', topic: 'recovery', scope: 'sleep', text: 'Synthetic specific recovery clarification?', reason: 'Keep this unique reason.' };
    f.store.saveQuestion(id, custom); f.store.buildReport(id);
    f.store.setLanguage(id, 'en');
    assert.deepEqual(f.store.resumeCollection(id), custom, 'a custom question sharing a fixed topic must not turn into the default question');
  } finally { f.cleanup(); }
});

test('B04 a matching fact correction consumes a paused question and resumes the next missing topic', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic post-report correction', 'en').id;
    fill(f.store, id, 2);
    const report = f.store.buildReport(id);
    f.store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', value: 7 });
    assert.equal(f.store.getInvestigation(id).pausedQuestion, undefined);
    assert.equal(f.store.snapshot(id).reports.find(item => item.id === report.id)!.status, 'stale');
    assert.deepEqual(pair(f.store.resumeCollection(id)), topics[3]);
    const updated = f.store.buildReport(id);
    assert.equal(updated.metrics.find(metric => metric.key === 'selfReportedSleepMinutes')?.value, 420);
  } finally { f.cleanup(); }
});

test('B04 same topic in a different fact scope cannot consume the paused question', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic scope collision', 'en').id;
    const question = fill(f.store, id, 2)!;
    f.store.buildReport(id);
    f.store.setFact(id, { topic: question.topic, scope: 'profile', value: 'Synthetic usual duration' });
    assert.deepEqual(f.store.getInvestigation(id).pausedQuestion, question);
    assert.equal(f.store.nextQuestion(id), undefined, 'an unrelated correction must not unexpectedly resume collection');
    assert.deepEqual(f.store.resumeCollection(id), question);
  } finally { f.cleanup(); }
});

test('B04 matching shared profile corrections consume paused questions in every affected investigation', () => {
  const f = fixture();
  try {
    const a = f.store.createInvestigation('Synthetic profile A', 'en').id;
    const b = f.store.createInvestigation('Synthetic profile B', 'zh').id;
    f.store.buildReport(a); f.store.buildReport(b);
    f.store.setFact(a, { topic: 'age_range', scope: 'profile', value: null, status: 'unknown' });
    for (const id of [a, b]) {
      assert.equal(f.store.getInvestigation(id).pausedQuestion, undefined);
      assert.deepEqual(pair(f.store.resumeCollection(id)), topics[1]);
    }
  } finally { f.cleanup(); }
});

test('B04 a newly saved question supersedes a paused clarification permanently', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic new clarification', 'en').id;
    f.store.buildReport(id);
    const replacement: Question = { id: 'replacement', scope: 'sleep', topic: 'noise', text: 'Synthetic new noise question?', reason: 'New evidence only.' };
    f.store.saveQuestion(id, replacement);
    assert.equal(f.store.getInvestigation(id).pausedQuestion, undefined);
    assert.deepEqual(f.store.resumeCollection(id), replacement);
    f.store.buildReport(id); f.reopen();
    assert.deepEqual(f.store.resumeCollection(id), replacement);
  } finally { f.cleanup(); }
});

for (const complete of [false, true]) test(`B04 legacy B03 SQLite without pausedQuestion falls back safely (${complete ? 'complete' : 'partial'} facts)`, () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic pre-B04 persisted report', 'en').id;
    fill(f.store, id, complete ? topics.length : 2, true);
    const report = f.store.buildReport(id);
    f.reopen(db => {
      const row = db.prepare('SELECT data FROM investigations WHERE id=?').get(id)!;
      const legacy = JSON.parse(String(row.data));
      delete legacy.pausedQuestion; delete legacy.pendingQuestion;
      legacy.status = 'reported';
      db.prepare('UPDATE investigations SET data=? WHERE id=?').run(JSON.stringify(legacy), id);
    });
    const before = f.store.snapshot(id);
    assert.equal(before.canResume, !complete);
    const files = exported(f.home, report.id);
    assert.deepEqual(pair(f.store.resumeCollection(id)), complete ? undefined : topics[2]);
    assert.equal(f.store.getInvestigation(id).revision, before.active!.revision);
    assert.deepEqual(f.store.snapshot(id).reports, before.reports);
    assert.deepEqual(exported(f.home, report.id), files);
  } finally { f.cleanup(); }
});

test('B04 exact target reselection preserves a pause; real target/source/scope changes discard it', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic target handling', 'en').id;
    f.store.setTarget(id, first);
    const marker: Question = { id: 'old-target', topic: 'noise', scope: 'sleep', text: 'OLD_TARGET_ONLY', reason: 'OLD_TARGET_REASON' };
    f.store.saveQuestion(id, marker); f.store.buildReport(id);
    const revision = f.store.getInvestigation(id).revision;
    f.store.setTarget(id, first);
    assert.deepEqual(f.store.getInvestigation(id).pausedQuestion, marker);
    assert.equal(f.store.getInvestigation(id).revision, revision);
    for (const target of [{ ...first, source: 'Synthetic Phone' }, { ...first, scope: 'nap' as const }, second, first]) {
      f.store.saveQuestion(id, marker); f.store.buildReport(id);
      f.store.setTarget(id, target);
      assert.equal(f.store.getInvestigation(id).pausedQuestion, undefined);
      assert.doesNotMatch(JSON.stringify(f.store.resumeCollection(id)), /OLD_TARGET/);
    }
  } finally { f.cleanup(); }
});

for (const deletion of ['fact', 'profile'] as const) test(`B04 ${deletion} deletion cannot restore deleted information from paused text`, () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic deletion', 'en').id;
    const fact = f.store.setFact(id, { topic: 'medications', scope: 'profile', value: 'SYNTHETIC_PRIVATE_MARKER' });
    f.store.saveQuestion(id, { id: 'delete-marker', topic: 'medication_timing', scope: 'sleep', text: 'SYNTHETIC_PRIVATE_MARKER follow-up?' });
    f.store.buildReport(id);
    if (deletion === 'fact') f.store.deleteFact(fact.id); else f.store.clearProfile();
    assert.equal(f.store.getInvestigation(id).pausedQuestion, undefined);
    assert.doesNotMatch(JSON.stringify(f.store.resumeCollection(id)), /SYNTHETIC_PRIVATE_MARKER/);
    assert.doesNotMatch(JSON.stringify(sleepContext(f.store, id)), /SYNTHETIC_PRIVATE_MARKER/);
  } finally { f.cleanup(); }
});

test('B04 deleting the selected health import clears a paused question about that deleted evidence', async () => {
  const f = fixture();
  try {
    const path = join(f.home, 'synthetic.xml');
    writeFileSync(path, '<?xml version="1.0"?><HealthData><Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Synthetic Watch" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-09-01 23:00:00 +0000" endDate="2026-09-02 07:00:00 +0000"/></HealthData>');
    const imported = await f.store.importFile(path);
    const id = f.store.createInvestigation('Synthetic removed import', 'en').id;
    f.store.setTarget(id, first);
    f.store.saveQuestion(id, { id: 'deleted-import', topic: 'device_gap', scope: 'sleep', text: 'SYNTHETIC_DELETED_DEVICE_GAP?' });
    f.store.buildReport(id); f.store.deleteImport(imported.id);
    assert.equal(f.store.getInvestigation(id).pausedQuestion, undefined);
    assert.doesNotMatch(JSON.stringify(f.store.resumeCollection(id)), /SYNTHETIC_DELETED_DEVICE_GAP/);
    assert.doesNotMatch(JSON.stringify(sleepContext(f.store, id)), /SYNTHETIC_DELETED_DEVICE_GAP/);
  } finally { f.cleanup(); }
});

test('B04 invalid resumption leaves persisted facts, questions and reports unchanged', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic invalid ID', 'en').id;
    f.store.buildReport(id);
    const before = f.store.snapshot(id);
    assert.throws(() => f.store.resumeCollection('missing-investigation'), /INVESTIGATION_NOT_FOUND/);
    assert.deepEqual(f.store.snapshot(id), before);
    f.store.deleteInvestigation(id);
    assert.throws(() => f.store.resumeCollection(id), /INVESTIGATION_NOT_FOUND/);
    assert.deepEqual(f.store.snapshot().investigations, []);
  } finally { f.cleanup(); }
});

for (const bound of [false, true]) test(`B04 ${bound ? 'desktop-bound' : 'explicit-ID'} resume tool returns a saved question and reports context availability`, async () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic resume tool', 'en').id;
    const question = fill(f.store, id, 2)!;
    f.store.buildReport(id);
    let changes = 0;
    const tools = createSleepTools(f.store, { ...(bound ? { investigationId: () => id } : {}), onChange: () => { changes++; } });
    const tool = tools.find(item => item.name === 'sleep_resume');
    assert.ok(tool, 'shared tool surface must expose resumption');
    assert.equal(tool.readOnly, false);
    assert.equal((sleepContext(f.store, id) as { canResume: boolean }).canResume, true);
    const params = bound ? {} : { investigationId: id };
    const result = await tool.execute(params) as { pendingQuestion?: Question; canResume: boolean };
    assert.deepEqual(result.pendingQuestion, question);
    assert.equal(result.canResume, false);
    assert.equal(changes, 1);
    assert.equal((sleepContext(f.store, id) as { canResume: boolean }).canResume, false);
    assert.deepEqual((await tool.execute(params) as { pendingQuestion?: Question }).pendingQuestion, question);
    const before = f.store.snapshot(id);
    await assert.rejects(tool.execute({ ...params, unexpected: true }), /INVALID_TOOL_ARGUMENTS/);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(tool.execute(params, cancelled.signal), /CANCELLED/);
    assert.deepEqual(f.store.snapshot(id), before);
    if (!bound) await assert.rejects(tool.execute({}), /INVALID_TOOL_ARGUMENTS/);
  } finally { f.cleanup(); }
});

test('B04 stale episode-bound resume cannot reopen collection in another sleep', async () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic stale resume', 'en').id;
    f.store.setTarget(id, first); f.store.buildReport(id);
    const episodeId = f.store.getInvestigation(id).sleepEpisodeId;
    const oldTool = createSleepTools(f.store, { investigationId: () => id, episodeId }).find(item => item.name === 'sleep_resume')!;
    f.store.setTarget(id, second); f.store.buildReport(id);
    const before = f.store.snapshot(id);
    await assert.rejects(oldTool.execute({}), /EPISODE_CHANGED/);
    assert.deepEqual(f.store.snapshot(id), before);
  } finally { f.cleanup(); }
});

test('B04 desktop resume stays local even when a model is configured and creates no chat session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-b04-controller-'));
  const events: AppEvent[] = [];
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ language: 'en', model: { provider: 'synthetic', model: 'synthetic-model', baseUrl: 'http://127.0.0.1:1/v1', protocol: 'openai-completions' } }));
  const app = new SleepApp(home, event => events.push(event));
  try {
    const id = (await app.request('new', { goal: 'Synthetic local resume' })).active!.id;
    const question = fill(app.store, id, 2)!;
    const report = app.store.buildReport(id);
    const files = exported(home, report.id);
    app.setCredential('synthetic-only-never-a-real-key');
    assert.equal(app.snapshot().configured, true);
    const resumed = await app.request('resume');
    assert.deepEqual(resumed.question, question);
    assert.equal(resumed.busy, false);
    assert.deepEqual(resumed.messages, []);
    assert.equal(existsSync(join(home, 'sessions')), false, 'resuming must not initialize or invoke Pi');
    assert.deepEqual(exported(home, report.id), files);
    assert.ok(events.some(event => event.type === 'state' && event.state.question?.id === question.id));
    assert.ok(!events.some(event => event.type === 'delta' || event.type === 'error'));
  } finally {
    await app.close();
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
    rmSync(home, { recursive: true, force: true });
  }
});

test('B04 fixed-seed operation sequences preserve answered topics through report, resume and reopen', () => {
  // Exercise 24 independent schedules, each 32 actions. The oracle stores only
  // answered topic count and a pause flag, independent of implementation state.
  for (let seed = 1; seed <= 24; seed++) {
    const f = fixture();
    try {
      const language: Language = seed % 2 ? 'zh' : 'en';
      const id = f.store.createInvestigation('Synthetic sequence', language).id;
      let state = seed, handled = 0, paused = false;
      for (let step = 0; step < 32; step++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const operation = state % 5;
        if (operation === 0) {
          f.store.buildReport(id); paused = true;
        } else if (operation === 1) {
          f.store.resumeCollection(id); paused = false;
        } else if (operation === 2) {
          f.reopen();
        } else if (!paused && handled < topics.length) {
          const unknown = (state & 0x100) !== 0;
          f.store.answer(id, unknown ? null : 'Synthetic sequential answer', unknown); handled++;
        }
        const snapshot = f.store.snapshot(id);
        assert.equal(snapshot.facts.length, handled, `seed ${seed}, step ${step}: facts are neither lost nor duplicated`);
        assert.equal(snapshot.canResume, paused && handled < topics.length, `seed ${seed}, step ${step}: resume affordance`);
        assert.deepEqual(pair(snapshot.question), paused ? undefined : topics[handled], `seed ${seed}, step ${step}: next unanswered topic`);
        assert.deepEqual(snapshot.facts.map(fact => [fact.scope, fact.topic]), topics.slice(0, handled));
      }
      f.store.resumeCollection(id);
      for (; handled < topics.length; handled++) {
        assert.deepEqual(pair(f.store.snapshot(id).question), topics[handled]);
        f.store.answer(id, null, true);
      }
      f.store.buildReport(id);
      assert.equal(f.store.resumeCollection(id), undefined);
      assert.equal(f.store.snapshot(id).canResume, false);
    } finally { f.cleanup(); }
  }
});
