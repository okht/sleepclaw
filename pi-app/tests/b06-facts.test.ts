import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SleepStore } from '../src/domain/index.js';
import { createSleepTools, sleepContext } from '../src/tools.js';
import { FACT_CONTRACT_GUIDANCE, normalizeFactInput } from '../src/shared/fact-contract.js';
import type { Fact, FactInput, Question, Report } from '../src/shared/types.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-b06-'));
  let store = new SleepStore(home);
  return { home, get store() { return store; }, reopen(change?: (db: DatabaseSync) => void) {
    store.close();
    if (change) { const db = new DatabaseSync(join(home, 'sleepclaw.sqlite')); try { change(db); } finally { db.close(); } }
    store = new SleepStore(home);
  }, cleanup() { store.close(); assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); rmSync(home, { recursive: true, force: true }); } };
}
const metric = (report: Report) => report.metrics.find(item => item.key === 'selfReportedSleepMinutes')?.value;
function legacyFact(id: string, topic: string, value: Fact['value'], updatedAt: string, overrides: Partial<Fact> = {}): Fact {
  return { id: `legacy-${topic}-${updatedAt}`, topic, value, scope: 'sleep', status: value === null ? 'unknown' : 'known', revision: 1, updatedAt, investigationId: id, sleepEpisodeId: id, ...overrides };
}
function insert(db: DatabaseSync, fact: Fact) {
  db.prepare('INSERT OR REPLACE INTO facts(id,owner,topic,data) VALUES(?,?,?,?)').run(fact.id, fact.scope === 'profile' ? 'profile' : fact.sleepEpisodeId ?? fact.investigationId!, fact.topic, JSON.stringify(fact));
}

test('B06 original model aliases retain the duration range and waking feeling in fixed report dimensions', async () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic original B06', 'zh').id;
    const tools = createSleepTools(f.store);
    const save = tools.find(tool => tool.name === 'sleep_fact')!;
    await save.execute({ investigationId: id, scope: 'sleep', topic: 'sleep_duration', value: '大概六到七小时' });
    await save.execute({ investigationId: id, scope: 'sleep', topic: 'waking_feeling', value: '合成记录：醒来累' });
    const report = f.store.buildReport(id);
    assert.match(report.dimensions.find(item => item.key === 'duration')!.text, /6.*7.*小时/);
    assert.match(report.dimensions.find(item => item.key === 'recovery')!.text, /合成记录：醒来累/);
    assert.equal(report.metrics.find(item => item.key === 'selfReportedSleepMinutes'), undefined);
  } finally { f.cleanup(); }
});

const exactExamples: Array<[string, number]> = [
  ['7', 7], [' 6.5 ', 6.5], ['.5', 0.5], ['7小时', 7], ['七个小时', 7], ['六点五小时', 6.5],
  ['七 hours', 7], ['seven hours', 7], ['6.5 h', 6.5], ['420 minutes', 7], ['390分钟', 6.5],
  ['半小时', 0.5], ['12 hrs', 12], ['十一个小时', 11], ['0小时', 0],
];
for (const topic of ['sleep_duration_hours', 'sleep_duration']) test(`B06 ${topic}: explicit quantities use hours and initial answers equal later corrections`, () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic exact quantities', 'en').id;
    for (const [value, hours] of exactExamples) {
      f.store.saveQuestion(id, { id: `question-${value}`, scope: 'sleep', topic, text: 'Synthetic recalled duration?' });
      const answer = f.store.answer(id, value);
      const correction = f.store.setFact(id, { scope: 'sleep', topic, value });
      assert.equal(answer.topic, 'sleep_duration_hours'); assert.equal(correction.topic, answer.topic);
      assert.equal(answer.value, hours, value); assert.equal(correction.value, hours, value);
      assert.equal(answer.uncertainty, undefined); assert.equal(correction.uncertainty, undefined);
      assert.equal(metric(f.store.buildReport(id)), Math.round(hours * 60), value);
    }
  } finally { f.cleanup(); }
});

const ranges: Array<[string, number, number]> = [
  ['六到七小时', 6, 7], ['大概六到七小时', 6, 7], ['六至七个小时', 6, 7], ['约6～7小时', 6, 7],
  ['6–7 hours', 6, 7], ['6-7 h', 6, 7], ['six to seven hours', 6, 7], ['between six and seven hours', 6, 7],
  ['about 6 to 7 hours', 6, 7], ['6~7', 6, 7], ['六点五到七点五小时', 6.5, 7.5], ['360-420 minutes', 6, 7],
];
for (const language of ['zh', 'en'] as const) test(`B06 ${language}: whole-answer ranges stay ranges in facts, dimensions, JSON and Markdown`, () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic range grammar', language).id;
    for (const [value, lower, upper] of ranges) {
      const fact = f.store.setFact(id, { topic: 'sleep_duration', scope: 'sleep', value });
      assert.equal(fact.value, value);
      assert.deepEqual(fact.uncertainty, { kind: 'range', original: value, lower, upper, unit: 'hours' }, value);
      const report = f.store.buildReport(id);
      assert.equal(metric(report), undefined, value);
      assert.match(report.dimensions.find(item => item.key === 'duration')!.text, new RegExp(`${lower}.*${upper}`));
      assert.equal(report.reportedFacts!.find(item => item.topic === 'sleep_duration_hours')?.value, value);
      assert.ok(report.markdown.includes(value));
      assert.ok(readFileSync(join(f.home, 'reports', `${report.id}.json`), 'utf8').includes(value));
      assert.equal(report.score, null);
    }
  } finally { f.cleanup(); }
});

test('B06 approximate and uncertain quantities retain original wording with no fabricated exact duration', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic approximation', 'zh').id;
    for (const value of ['约7小时', '约 七小时', '大约7小时', '7小时左右', 'roughly seven hours', 'about 6.5 hours', 'around 420 minutes', 'maybe seven hours', '可能七小时', '不确定，可能睡了七小时']) {
      const fact = f.store.setFact(id, { topic: 'sleep_duration', scope: 'sleep', value });
      assert.equal(fact.value, value);
      assert.ok(fact.uncertainty, value);
      assert.equal(fact.uncertainty.original, value);
      const report = f.store.buildReport(id);
      assert.equal(metric(report), undefined, value);
      assert.ok(report.dimensions.find(item => item.key === 'duration')!.text.includes(value));
      assert.ok(report.markdown.includes(value));
    }
  } finally { f.cleanup(); }
});

test('B06 only whole quantities are parsed: narratives, clocks, reversed ranges and unsupported units remain visible prose', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic parser counterexamples', 'en').id;
    for (const value of ['2026-09-21', '23:30', '6:30-7:30', 'I worried about work for 7 hours', 'I slept 6 hours and was in bed 7 hours',
      '7-6 hours', '6 days', '6 hours 30 minutes', '6 hours to 420 minutes', '-7', 'Infinity', 'NaN', '0x7', '7e2',
      '三百到四百分钟', '9999999999'.repeat(40), '6–8 apples', '6 7 hours']) {
      const fact = f.store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', value });
      assert.equal(fact.value, value, value);
      assert.equal(fact.uncertainty?.kind, undefined, value);
      assert.equal(metric(f.store.buildReport(id)), undefined, value);
    }
  } finally { f.cleanup(); }
});

test('B06 unknown and skipped answers override prior exact and range values while preserving the user wording', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic unknown corrections', 'en').id;
    for (const value of ['不知道', '记不清', '不确定', 'unknown', 'not sure', "I don't know", 'I cannot recall']) {
      f.store.setFact(id, { topic: 'sleep_duration', scope: 'sleep', value: 7 });
      const fact = f.store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', value });
      assert.equal(fact.value, null); assert.equal(fact.status, 'unknown');
      assert.equal(fact.uncertainty?.original, value);
      const report = f.store.buildReport(id); assert.equal(metric(report), undefined);
      assert.ok(report.markdown.includes(value));
    }
    f.store.saveQuestion(id, { id: 'skip-duration', topic: 'sleep_duration', scope: 'sleep', text: 'Synthetic duration?' });
    const skipped = f.store.answer(id, 'I prefer not to answer', true);
    assert.equal(skipped.value, null); assert.equal(skipped.status, 'unknown');
    assert.equal(skipped.uncertainty?.original, 'I prefer not to answer');
  } finally { f.cleanup(); }
});

test('B06 explicit metadata remains authoritative and minute ranges convert units without a midpoint', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic supplied metadata', 'en').id;
    const input: FactInput = { topic: 'sleep_duration', scope: 'sleep', value: 'Synthetic original range in minutes', uncertainty: { kind: 'range', original: 'Synthetic original range in minutes', lower: 360, upper: 420, unit: 'minutes' } };
    const fact = f.store.setFact(id, input);
    assert.deepEqual(fact.uncertainty, { ...input.uncertainty, lower: 6, upper: 7, unit: 'hours' });
    assert.equal(input.uncertainty!.lower, 360, 'caller metadata must remain untouched');
    const report = f.store.buildReport(id); assert.equal(metric(report), undefined);
    assert.match(report.dimensions[0].text, /6–7 hours/);
    const before = f.store.snapshot(id);
    for (const uncertainty of [{ kind: 'range', original: 'x', lower: 420, upper: 360, unit: 'minutes' }, { kind: 'range', original: 'x', lower: 360, upper: Infinity, unit: 'minutes' }]) {
      assert.throws(() => f.store.setFact(id, { ...input, uncertainty } as FactInput), /INVALID_FACT_UNCERTAINTY/);
    }
    assert.throws(() => f.store.setFact(id, { ...input, value: 6.5 }), /INVALID_FACT_UNCERTAINTY/);
    assert.deepEqual(f.store.snapshot(id), before);
  } finally { f.cleanup(); }
});

test('B06 explicit hour-unit spellings normalize without changing bounds or inventing exact values', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic explicit units', 'en').id;
    for (const unit of ['hour', 'Hours', 'hr', 'hrs', 'h', '小时', '个小时', ' hours ']) {
      const fact = f.store.setFact(id, { topic: 'sleep_duration', scope: 'sleep', value: 'Synthetic range', uncertainty: { kind: 'range', original: 'Synthetic range', lower: 6, upper: 7, unit } });
      assert.deepEqual(fact.uncertainty, { kind: 'range', original: 'Synthetic range', lower: 6, upper: 7, unit: 'hours' });
      const report = f.store.buildReport(id);
      assert.equal(metric(report), undefined);
      assert.match(report.dimensions[0].text, /6–7 hours/);
    }
  } finally { f.cleanup(); }
});

test('B06 only explicit waking-feeling aliases map to recovery and profile habits never become this sleep', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic scoped aliases', 'en').id;
    for (const topic of ['recovery', 'wake_feeling', 'waking_feeling']) {
      const fact = f.store.setFact(id, { topic, scope: 'sleep', value: `Synthetic ${topic} tired` });
      assert.equal(fact.topic, 'recovery');
      assert.match(f.store.buildReport(id).dimensions.find(item => item.key === 'recovery')!.text, new RegExp(topic));
      assert.equal(f.store.snapshot(id).facts.filter(item => item.topic === 'recovery' && item.scope === 'sleep').length, 1);
    }
    const other = f.store.createInvestigation('Synthetic profile scope', 'en').id;
    f.store.setFact(other, { topic: 'wake_feeling', scope: 'profile', value: 'Synthetic habitual tiredness' });
    f.store.setFact(other, { topic: 'sleep_duration', scope: 'profile', value: '7 hours' });
    const report = f.store.buildReport(other);
    assert.equal(metric(report), undefined);
    assert.doesNotMatch(report.dimensions.find(item => item.key === 'recovery')!.text, /habitual/);
    assert.ok(report.markdown.includes('Synthetic habitual tiredness'));
  } finally { f.cleanup(); }
});

test('B06 sleep complaints and custom facts remain visible without asserting a recovery value', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic non-recovery concerns', 'zh').id;
    for (const [topic, value] of [['sleep_complaint', '合成困扰：半夜楼下很吵'], ['custom.blanket', false], ['custom.noise', 'Synthetic | pipe\nnew line'], ['custom.unknown', null]] as const) f.store.setFact(id, { topic, value, scope: 'sleep' });
    const report = f.store.buildReport(id);
    assert.match(report.dimensions.find(item => item.key === 'recovery')!.text, /资料不足/);
    assert.equal(report.reportedFacts!.length, 4);
    assert.ok(report.markdown.includes('合成困扰：半夜楼下很吵'));
    assert.ok(report.markdown.includes('false'));
    assert.ok(report.markdown.includes('Synthetic \\| pipe new line'));
    assert.ok(report.markdown.includes('未知／已跳过'));
    const original = report.reportedFacts!.map(fact => ({ ...fact }));
    f.store.setFact(id, { topic: 'sleep_complaint', scope: 'sleep', value: 'New synthetic concern' });
    assert.deepEqual(f.store.snapshot(id).reports.find(item => item.id === report.id)!.reportedFacts, original);
  } finally { f.cleanup(); }
});

test('B06 questionnaire alias normalization and matching fact writes clear one saved question consistently', async () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic field contract', 'en').id;
    const tools = createSleepTools(f.store, { investigationId: () => id });
    const call = (name: string, params: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute(params);
    const question = await call('sleep_question', { scope: 'sleep', topic: 'sleep_duration', text: 'Synthetic duration?' }) as Question;
    assert.equal(question.topic, 'sleep_duration_hours');
    await call('sleep_fact', { scope: 'sleep', topic: 'sleep_duration_hours', value: '7小时' });
    assert.equal(f.store.snapshot(id).question, undefined);
    const context = await call('sleep_context', {}) as { facts: Fact[]; factContract: string };
    assert.equal(context.facts.find(item => item.topic === 'sleep_duration_hours')?.value, 7);
    assert.equal(context.factContract, FACT_CONTRACT_GUIDANCE);
    assert.match(tools.find(tool => tool.name === 'sleep_fact')!.description, /sleep_duration_hours.*hours/);
  } finally { f.cleanup(); }
});

test('B06 legacy alias projection preserves raw rows, stales affected reports once and excludes obsolete conflicting values', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic legacy migration', 'en').id;
    const report = f.store.buildReport(id);
    const other = f.store.createInvestigation('Synthetic unaffected report', 'en').id;
    const untouched = f.store.buildReport(other);
    const old = legacyFact(id, 'sleep_duration', '6-7 hours', '2026-09-02T00:00:00Z');
    const canonical = legacyFact(id, 'sleep_duration_hours', 8, '2026-09-01T00:00:00Z');
    const recovery = legacyFact(id, 'wake_feeling', 'SYNTHETIC_RECOVERY', '2026-09-02T00:00:00Z');
    f.reopen(db => { for (const fact of [old, canonical, recovery]) insert(db, fact); db.prepare('DELETE FROM migrations WHERE id=?').run('fact-contract-v1'); });
    const current = f.store.snapshot(id);
    assert.equal(current.facts.length, 2);
    assert.equal(current.facts.find(item => item.topic === 'sleep_duration_hours')!.value, '6-7 hours');
    assert.equal(current.facts.find(item => item.topic === 'recovery')!.value, 'SYNTHETIC_RECOVERY');
    assert.equal(current.reports.find(item => item.id === report.id)!.status, 'stale');
    assert.equal(current.reports.find(item => item.id === untouched.id)!.status, 'complete');
    assert.deepEqual(current.reports.find(item => item.id === report.id)!.metrics, report.metrics, 'historical metrics must not be recomputed during migration');
    const db = new DatabaseSync(join(f.home, 'sleepclaw.sqlite'));
    try { for (const fact of [old, canonical, recovery]) assert.equal(db.prepare('SELECT data FROM facts WHERE id=?').get(fact.id)!.data, JSON.stringify(fact)); } finally { db.close(); }
    const fresh = f.store.buildReport(id);
    assert.equal(metric(fresh), undefined); assert.match(fresh.dimensions[0].text, /6–7/);
    const revision = f.store.getInvestigation(id).revision;
    f.reopen();
    assert.equal(f.store.getInvestigation(id).revision, revision);
    assert.equal(f.store.snapshot(id).reports.find(item => item.id === fresh.id)!.status, 'complete');
  } finally { f.cleanup(); }
});

for (const newest of ['alias', 'canonical'] as const) test(`B06 latest ${newest} unknown supersedes older known synonymous facts and explicit corrections remain authoritative`, () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic legacy unknown', 'en').id;
    const alias = legacyFact(id, 'sleep_duration', newest === 'alias' ? null : 7, newest === 'alias' ? '2099-09-02T00:00:00Z' : '2099-09-01T00:00:00Z');
    const canonical = legacyFact(id, 'sleep_duration_hours', newest === 'canonical' ? null : 8, newest === 'canonical' ? '2099-09-02T00:00:00Z' : '2099-09-01T00:00:00Z');
    f.reopen(db => { insert(db, alias); insert(db, canonical); });
    assert.equal(f.store.snapshot(id).facts[0].status, 'unknown');
    assert.equal(metric(f.store.buildReport(id)), undefined);
    const correction = f.store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', value: '6.5' });
    assert.equal(f.store.snapshot(id).facts[0].value, 6.5, 'a future legacy timestamp cannot defeat an explicit current correction');
    assert.equal(metric(f.store.buildReport(id)), 390);
    f.store.deleteFact(correction.id);
    assert.deepEqual(f.store.snapshot(id).facts, []);
    f.reopen();
    assert.deepEqual(f.store.snapshot(id).facts, [], 'deleted earlier synonyms must never reappear');
    assert.equal(metric(f.store.buildReport(id)), undefined);
  } finally { f.cleanup(); }
});

test('B06 legacy projection tie-breaking is stable across row ordering, scopes and database reopen', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic deterministic aliases', 'en').id;
    const at = '2026-09-02T00:00:00Z';
    const canonical = legacyFact(id, 'recovery', 'LATEST_CANONICAL', at, { revision: 2 });
    const alias = legacyFact(id, 'waking_feeling', 'OLDER_ALIAS', at, { revision: 1 });
    const profile = legacyFact(id, 'recovery', 'PROFILE_RECOVERY', at, { id: 'profile-recovery', scope: 'profile', investigationId: undefined, sleepEpisodeId: undefined });
    f.reopen(db => { insert(db, alias); insert(db, profile); insert(db, canonical); });
    for (let i = 0; i < 3; i++) {
      const context = sleepContext(f.store, id);
      assert.doesNotMatch(JSON.stringify(context), /OLDER_ALIAS/);
      const facts = f.store.snapshot(id).facts;
      assert.equal(facts.length, 2);
      assert.equal(facts.find(item => item.scope === 'sleep')!.value, 'LATEST_CANONICAL');
      assert.equal(facts.find(item => item.scope === 'profile')!.value, 'PROFILE_RECOVERY');
      f.reopen();
    }
  } finally { f.cleanup(); }
});

test('B06 shared parser is deterministic, does not mutate callers and never assigns custom units by resemblance', () => {
  const inputs: FactInput[] = [
    { topic: 'sleep_duration', scope: 'sleep', value: '六到七小时' },
    { topic: 'sleep_duration', scope: 'profile', value: '六到七小时' },
    { topic: 'sleep_complaint', scope: 'sleep', value: '七小时' },
    { topic: 'custom.sleep_duration', scope: 'sleep', value: '7' },
    { topic: 'remembered_awakenings', scope: 'sleep', value: 'two times' },
    { topic: 'remembered_awakenings', scope: 'sleep', value: '2-3次' },
  ];
  for (const input of inputs) {
    const before = JSON.stringify(input);
    const normalized = normalizeFactInput(input);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(normalizeFactInput(normalized), normalized);
    if (input.scope === 'profile' || input.topic.startsWith('custom.') || input.topic === 'sleep_complaint') assert.equal(normalized.value, input.value);
  }
  assert.equal(normalizeFactInput(inputs[4]).value, 2);
  assert.deepEqual(normalizeFactInput(inputs[5]).uncertainty, { kind: 'range', original: '2-3次', lower: 2, upper: 3, unit: 'count' });
});

test('B06 migration failures roll back report state, fact revision and marker before a successful retry', () => {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-b06-rollback-'));
  let store: SleepStore | undefined = new SleepStore(home);
  try {
    const id = store.createInvestigation('Synthetic migration rollback', 'en').id;
    const report = store.buildReport(id);
    const before = store.getInvestigation(id);
    const files = ['json', 'md'].map(extension => readFileSync(join(home, 'reports', `${report.id}.${extension}`), 'utf8'));
    store.close(); store = undefined;
    let db = new DatabaseSync(join(home, 'sleepclaw.sqlite'));
    try {
      insert(db, legacyFact(id, 'sleep_duration', '7 hours', '2026-09-02T00:00:00Z'));
      db.prepare('DELETE FROM migrations WHERE id=?').run('fact-contract-v1');
      db.exec("CREATE TRIGGER synthetic_fail_report BEFORE UPDATE ON reports BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END;");
    } finally { db.close(); }
    assert.throws(() => new SleepStore(home), /synthetic migration failure/);
    db = new DatabaseSync(join(home, 'sleepclaw.sqlite'));
    try {
      assert.deepEqual(JSON.parse(String(db.prepare('SELECT data FROM investigations WHERE id=?').get(id)!.data)), before);
      assert.equal(JSON.parse(String(db.prepare('SELECT data FROM reports WHERE id=?').get(report.id)!.data)).status, 'complete');
      assert.equal(db.prepare('SELECT id FROM migrations WHERE id=?').get('fact-contract-v1'), undefined);
      db.exec('DROP TRIGGER synthetic_fail_report');
    } finally { db.close(); }
    assert.deepEqual(['json', 'md'].map(extension => readFileSync(join(home, 'reports', `${report.id}.${extension}`), 'utf8')), files);
    store = new SleepStore(home);
    assert.equal(store.getInvestigation(id).revision, before.revision + 1);
    assert.equal(store.snapshot(id).reports.find(item => item.id === report.id)!.status, 'stale');
    assert.equal(metric(store.buildReport(id)), 420);
  } finally {
    store?.close(); assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); rmSync(home, { recursive: true, force: true });
  }
});

test('B06 fixed-seed mixed aliases and corrections preserve current-episode values through targets and reloads', () => {
  const examples: Array<{ value: string; minutes?: number; kind?: string; status?: string }> = [
    { value: '七小时', minutes: 420 }, { value: '390 minutes', minutes: 390 },
    { value: '六到七小时', kind: 'range' }, { value: 'about thirteen hours', kind: 'approximate' },
    { value: 'not sure', kind: 'uncertain', status: 'unknown' }, { value: '23:30' },
  ];
  for (let seed = 1; seed <= 12; seed++) {
    const f = fixture();
    try {
      const id = f.store.createInvestigation('Synthetic combined sequence', seed % 2 ? 'zh' : 'en').id;
      const expected = new Map<number, typeof examples[number]>();
      let random = seed;
      for (let step = 0; step < 16; step++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const episode = random % 3;
        const example = examples[(random >>> 8) % examples.length];
        const start = Date.UTC(2026, 8, 1 + episode, 23), end = start + 8 * 3600000;
        f.store.setTarget(id, { start: new Date(start).toISOString(), end: new Date(end).toISOString(), source: 'Synthetic Watch' });
        const previous = expected.get(episode);
        assert.equal(metric(f.store.buildReport(id)), previous?.minutes);
        const topic = step % 2 ? 'sleep_duration' : 'sleep_duration_hours';
        f.store.setFact(id, { topic, scope: 'sleep', value: example.value });
        expected.set(episode, example);
        const facts = f.store.snapshot(id).facts.filter(fact => fact.scope === 'sleep');
        assert.equal(facts.length, 1);
        assert.equal(facts[0].topic, 'sleep_duration_hours');
        assert.equal(facts[0].uncertainty?.kind, example.kind);
        assert.equal(facts[0].status, example.status ?? 'known');
        assert.equal(metric(f.store.buildReport(id)), example.minutes);
        if (step % 4 === 3) f.reopen();
      }
    } finally { f.cleanup(); }
  }
});
