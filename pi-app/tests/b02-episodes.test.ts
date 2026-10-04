import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SleepStore } from '../src/domain/index.js';
import { createSleepTools, sleepContext } from '../src/tools.js';
import { buildInvestigationGuidance } from '../src/domain/investigation.js';
import type { Fact, FactInput, Investigation, Report, SleepScope } from '../src/shared/types.js';

// All data is synthetic. Expected ownership comes from named episodes in this
// acceptance set, never from importing the production episode matching helper.
const origin = Date.parse('2026-10-01T22:00:00+08:00');
const at = (minute: number) => new Date(origin + minute * 60_000).toISOString();
const target = (start = 0, end = 480, source = 'Synthetic Watch', scope: SleepScope = 'main') => ({ start: at(start), end: at(end), source, scope });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-b02-episodes-'));
  let current = new SleepStore(home);
  return {
    home,
    get store() { return current; },
    reopen() { current.close(); current = new SleepStore(home); return current; },
    cleanup() { current.close(); rmSync(home, { recursive: true, force: true }); },
  };
}
const sleepFacts = (store: SleepStore, id: string) => store.snapshot(id).facts.filter(fact => fact.scope === 'sleep');
const persisted = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const factValues = (store: SleepStore, id: string) => Object.fromEntries(sleepFacts(store, id).map(fact => [fact.topic, { value: fact.value, status: fact.status, uncertainty: fact.uncertainty }]).sort(([a], [b]) => String(a).localeCompare(String(b))));
const metric = (report: Report, key: string) => report.metrics.find(item => item.key === key)?.value;
function save(store: SleepStore, id: string, value = 'Synthetic A recovery', topic = 'recovery') {
  return store.setFact(id, { topic, value, scope: 'sleep' });
}

const boundaries: Array<{ name: string; start: number; end: number; keep: boolean; source?: string; scope?: SleepScope }> = [
  { name: 'exact target retry', start: 0, end: 480, keep: true },
  { name: 'only source changes', start: 0, end: 480, source: 'Synthetic Phone', keep: true },
  { name: 'earlier start correction', start: -30, end: 480, keep: true },
  { name: 'later end correction', start: 0, end: 510, keep: true },
  { name: 'small correction at both ends', start: 15, end: 465, keep: true },
  { name: '239 minute equal-length shift retains majority', start: 239, end: 719, keep: true },
  { name: '240 minute equal-length shift has only half overlap', start: 240, end: 720, keep: false },
  { name: '241 minute equal-length shift has less than half overlap', start: 241, end: 721, keep: false },
  { name: 'adjacent episodes share no duration', start: 480, end: 960, keep: false },
  { name: 'one minute overlap cannot carry recollections', start: 479, end: 959, keep: false },
  { name: 'next night', start: 1440, end: 1920, keep: false },
  { name: 'previous night', start: -1440, end: -960, keep: false },
  { name: 'next month', start: 43_200, end: 43_680, keep: false },
  { name: 'expansion below twice original duration', start: 0, end: 959, keep: true },
  { name: 'expansion to twice duration cannot inherit', start: 0, end: 960, keep: false },
  { name: 'earlier expansion below twice duration', start: -479, end: 480, keep: true },
  { name: 'earlier expansion to twice duration cannot inherit', start: -480, end: 480, keep: false },
  { name: 'narrowed window above half duration', start: 0, end: 241, keep: true },
  { name: 'narrowed window at half duration', start: 0, end: 240, keep: false },
  { name: 'very short contained segment without scope flag', start: 120, end: 150, keep: false },
  { name: 'large containing range', start: -1440, end: 2880, keep: false },
  { name: 'same interval changes to nap', start: 0, end: 480, scope: 'nap', keep: false },
  { name: 'same interval changes to segment', start: 0, end: 480, scope: 'segment', keep: false },
  { name: 'different source and different night', start: 1440, end: 1920, source: 'Synthetic Phone', keep: false },
];

for (const row of boundaries) test(`B02 ownership boundary: ${row.name}`, () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic ownership check', 'en');
    const a = f.store.setTarget(id, target());
    const original = save(f.store, id);
    const profile = f.store.setFact(id, { topic: 'usual_schedule', value: 'Synthetic rotating shifts', scope: 'profile' });
    const next = f.store.setTarget(id, target(row.start, row.end, row.source, row.scope));
    assert.equal(next.sleepEpisodeId === a.sleepEpisodeId, row.keep);
    assert.deepEqual(sleepFacts(f.store, id), row.keep ? [original] : []);
    assert.deepEqual(f.store.snapshot(id).facts.find(item => item.id === profile.id), persisted(profile));
    const report = f.store.buildReport(id);
    assert.equal(report.dimensions.find(item => item.key === 'recovery')!.text.includes('Synthetic A recovery'), row.keep);
    f.store.setTarget(id, target());
    assert.deepEqual(sleepFacts(f.store, id), [original], 'returning to A recovers its unchanged fact');
  } finally { f.cleanup(); }
});

const values: Array<{ name: string; input: FactInput }> = [
  { name: 'positive number', input: { topic: 'custom.numeric', scope: 'sleep', value: 7.5 } },
  { name: 'zero', input: { topic: 'remembered_awakenings', scope: 'sleep', value: 0 } },
  { name: 'false', input: { topic: 'custom_boolean', scope: 'sleep', value: false } },
  { name: 'true', input: { topic: 'custom_boolean', scope: 'sleep', value: true } },
  { name: 'empty string', input: { topic: 'custom_empty', scope: 'sleep', value: '' } },
  { name: 'Unicode narrative', input: { topic: 'recovery', scope: 'sleep', value: '合成记录：醒后头痛，后来缓解。' } },
  { name: 'null unknown', input: { topic: 'sleep_duration_hours', scope: 'sleep', value: null } },
  { name: 'explicit unknown text', input: { topic: 'recovery', scope: 'sleep', value: 'Synthetic answer unavailable', status: 'unknown' } },
  { name: 'approximate', input: { topic: 'sleep_duration_hours', scope: 'sleep', value: 'about seven hours', uncertainty: { kind: 'approximate', original: 'about seven hours' } } },
  { name: 'range', input: { topic: 'sleep_duration_hours', scope: 'sleep', value: 'six to eight hours', uncertainty: { kind: 'range', original: 'six to eight hours', lower: 6, upper: 8, unit: 'hours' } } },
  { name: 'uncertain', input: { topic: 'custom-time', scope: 'sleep', value: 'maybe midnight', uncertainty: { kind: 'uncertain', original: 'maybe midnight' } } },
];
for (const row of values) test(`B02 value preservation: ${row.name}`, () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic values', 'zh');
    f.store.setTarget(id, target());
    const a = f.store.setFact(id, row.input);
    f.store.setTarget(id, target(1440, 1920));
    assert.deepEqual(sleepFacts(f.store, id), []);
    const b = f.store.setFact(id, { ...row.input, value: 'Synthetic B literal', status: 'known', uncertainty: undefined });
    assert.notEqual(a.id, b.id);
    f.reopen();
    f.store.setTarget(id, target());
    assert.deepEqual(sleepFacts(f.store, id), [a]);
    f.store.setTarget(id, target(1440, 1920));
    assert.deepEqual(sleepFacts(f.store, id), [b]);
  } finally { f.cleanup(); }
});

test('B02 first binding retains unbound same-scope answers without changing their identity', () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic initial self-report', 'en');
    const duration = f.store.setFact(id, { topic: 'sleep_duration_hours', value: 7, scope: 'sleep' });
    assert.equal(duration.sleepEpisodeId, id);
    f.store.setTarget(id, target());
    assert.deepEqual(sleepFacts(f.store, id), [duration]);
    assert.equal(metric(f.store.buildReport(id), 'selfReportedSleepMinutes'), 420);
  } finally { f.cleanup(); }
});

test('B02 scope change before first binding preserves the original unbound context for later binding', () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic unbound main sleep', 'en');
    const main = save(f.store, id, 'Synthetic main recovery');
    f.store.setTarget(id, target(900, 960, 'Synthetic Watch', 'nap'));
    assert.deepEqual(sleepFacts(f.store, id), []);
    const nap = save(f.store, id, 'Synthetic nap recovery');
    f.store.setTarget(id, target());
    assert.deepEqual(sleepFacts(f.store, id), [main]);
    f.store.setTarget(id, target(900, 960, 'Synthetic Phone', 'nap'));
    assert.deepEqual(sleepFacts(f.store, id), [nap]);
  } finally { f.cleanup(); }
});

test('B02 equivalent UTC instants and explicit target retry keep episode, plan and report revisions', () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic equivalent zones', 'en');
    f.store.setTarget(id, { start: '2026-10-01T22:00:00+08:00', end: '2026-10-02T06:00:00+08:00', source: 'Synthetic Watch' });
    save(f.store, id);
    const report = f.store.buildReport(id);
    const before = f.store.getInvestigation(id);
    f.store.savePlan(id, { objective: 'Synthetic stable plan', revision: before.revision, steps: [{ id: 'report', kind: 'report', description: 'Keep the completed synthetic report.', status: 'done' }] });
    const withPlan = f.store.getInvestigation(id);
    f.store.setTarget(id, target());
    assert.deepEqual(f.store.getInvestigation(id), withPlan);
    assert.equal(f.store.buildReport(id).id, report.id);
  } finally { f.cleanup(); }
});

test('B02 overlapping ambiguous bridge inherits neither side and exact anchors take priority', () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic bridge', 'en');
    const aTarget = target(0, 600), bTarget = target(360, 960), bridgeTarget = target(180, 780);
    const aEpisode = f.store.setTarget(id, aTarget).sleepEpisodeId;
    const a = save(f.store, id, 'Synthetic A');
    const bEpisode = f.store.setTarget(id, bTarget).sleepEpisodeId;
    const b = save(f.store, id, 'Synthetic B');
    assert.notEqual(aEpisode, bEpisode);
    const bridgeEpisode = f.store.setTarget(id, bridgeTarget).sleepEpisodeId;
    assert.ok(![aEpisode, bEpisode].includes(bridgeEpisode));
    assert.deepEqual(sleepFacts(f.store, id), []);
    const bridge = save(f.store, id, 'Synthetic ambiguous bridge');
    for (const [selection, expected, episode] of [[aTarget, a, aEpisode], [bTarget, b, bEpisode], [bridgeTarget, bridge, bridgeEpisode]] as const) {
      assert.equal(f.store.setTarget(id, selection).sleepEpisodeId, episode);
      assert.deepEqual(sleepFacts(f.store, id), [expected]);
    }
  } finally { f.cleanup(); }
});

test('B02 a two-night containing bridge never transports A facts to B', () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic containing bridge', 'en');
    f.store.setTarget(id, target());
    const a = save(f.store, id);
    f.store.setTarget(id, target(0, 1920));
    assert.deepEqual(sleepFacts(f.store, id), []);
    const bridge = save(f.store, id, 'Synthetic broad interval');
    f.store.setTarget(id, target(1440, 1920));
    assert.deepEqual(sleepFacts(f.store, id), []);
    f.store.setTarget(id, target());
    assert.deepEqual(sleepFacts(f.store, id), [a]);
    f.store.setTarget(id, target(0, 1920));
    assert.deepEqual(sleepFacts(f.store, id), [bridge]);
  } finally { f.cleanup(); }
});

test('B02 serial small shifts use the immutable anchor instead of moving the fact to another night', () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic sliding window', 'en');
    const initialEpisode = f.store.setTarget(id, target()).sleepEpisodeId;
    const a = save(f.store, id);
    for (let start = 30; start <= 1440; start += 30) {
      const selected = f.store.setTarget(id, target(start, start + 480));
      const shouldContainA = start < 240;
      assert.equal(sleepFacts(f.store, id).some(item => item.id === a.id), shouldContainA, `shift ${start} minutes`);
      assert.equal(selected.sleepEpisodeId === initialEpisode, shouldContainA);
    }
    f.reopen();
    assert.deepEqual(sleepFacts(f.store, id), []);
    f.store.setTarget(id, target());
    assert.deepEqual(sleepFacts(f.store, id), [a]);
  } finally { f.cleanup(); }
});

test('B02 new episode reopens sleep questions, preserves profile answers and removes previous plan content', () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic questionnaires', 'en');
    f.store.setFact(id, { topic: 'age_range', value: 'Synthetic adult', scope: 'profile' });
    f.store.setFact(id, { topic: 'usual_schedule', value: 'Synthetic usual schedule', scope: 'profile' });
    f.store.setTarget(id, target());
    f.store.setFact(id, { topic: 'sleep_duration_hours', value: 7, scope: 'sleep' });
    const oldReport = f.store.buildReport(id);
    f.store.saveQuestion(id, { id: 'synthetic-old-question', topic: 'old_observation', scope: 'sleep', text: 'Synthetic A-only observation?' });
    f.store.savePlan(id, { objective: 'Synthetic A-only plan', revision: f.store.getInvestigation(id).revision, steps: [{ id: 'old', kind: 'clarify', description: 'Synthetic A-only observation?', status: 'pending' }] });
    f.store.setTarget(id, target(1440, 1920));
    assert.equal(f.store.nextQuestion(id)?.topic, 'sleep_duration_hours');
    assert.equal(f.store.getInvestigation(id).plan, undefined);
    const context = JSON.stringify(sleepContext(f.store, id));
    assert.doesNotMatch(context, /Synthetic A-only/);
    assert.equal(f.store.snapshot(id).reports.find(item => item.id === oldReport.id)?.status, 'stale');
    const b = f.store.buildReport(id);
    assert.equal(metric(b, 'selfReportedSleepMinutes'), undefined);
    const exported = JSON.parse(readFileSync(join(f.home, 'reports', `${oldReport.id}.json`), 'utf8')) as Report;
    assert.equal(metric(exported, 'selfReportedSleepMinutes'), 420);
    assert.equal(exported.status, 'stale');
  } finally { f.cleanup(); }
});

test('B02 source change keeps recollection while invalidating device-specific question and plan guidance', () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic source correction', 'en');
    f.store.setTarget(id, target());
    const a = save(f.store, id);
    f.store.saveQuestion(id, { id: 'device-follow-up', topic: 'old_device', scope: 'sleep', text: 'Synthetic old-device anomaly?' });
    f.store.savePlan(id, { objective: 'Synthetic old-device objective', revision: f.store.getInvestigation(id).revision, steps: [{ id: 'old', kind: 'query', description: 'Synthetic old-device observation', status: 'pending' }] });
    f.store.setTarget(id, target(0, 480, 'Synthetic Phone'));
    assert.deepEqual(sleepFacts(f.store, id), [a]);
    assert.notEqual(f.store.nextQuestion(id)?.id, 'device-follow-up');
    const state = f.store.snapshot(id);
    const guidance = buildInvestigationGuidance(state.active!, state.facts);
    assert.equal(guidance.planStatus, 'stale');
    assert.ok(!guidance.nextActions.some(action => action.description === 'Synthetic old-device observation'));
  } finally { f.cleanup(); }
});

test('B02 same-topic profile facts and another investigation stay independent across corrections', () => {
  const f = fixture();
  try {
    const a = f.store.createInvestigation('Synthetic investigation A', 'en');
    const b = f.store.createInvestigation('Synthetic investigation B', 'en');
    const profile = f.store.setFact(a.id, { topic: 'recovery', value: 'Synthetic usual recovery', scope: 'profile' });
    f.store.setTarget(a.id, target());
    const aNight = save(f.store, a.id, 'Synthetic A episode');
    f.store.setTarget(b.id, target());
    const otherInvestigation = save(f.store, b.id, 'Synthetic B investigation episode');
    f.store.setTarget(a.id, target(1440, 1920));
    const anotherNight = save(f.store, a.id, 'Synthetic A second episode');
    const corrected = save(f.store, a.id, 'Synthetic corrected second episode');
    assert.equal(corrected.id, anotherNight.id);
    assert.equal(corrected.revision, anotherNight.revision + 1);
    f.store.setTarget(a.id, target());
    assert.deepEqual(sleepFacts(f.store, a.id), [aNight]);
    assert.deepEqual(sleepFacts(f.store, b.id), [otherInvestigation]);
    for (const id of [a.id, b.id]) assert.deepEqual(f.store.snapshot(id).facts.find(item => item.scope === 'profile'), persisted(profile));
  } finally { f.cleanup(); }
});

for (const bound of [false, true]) test(`B02 tool contract ${bound ? 'desktop bound' : 'host explicit ID'} isolates switched facts and reports`, async () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic tool investigation', 'en');
    const tools = createSleepTools(f.store, bound ? { investigationId: () => id } : {});
    const call = async <T>(name: string, params: Record<string, unknown>) => await tools.find(tool => tool.name === name)!.execute({ ...params, ...(!bound ? { investigationId: id } : {}) }) as T;
    await call('sleep_target', target());
    const a = await call<Fact>('sleep_fact', { topic: 'sleep_duration_hours', scope: 'sleep', value: 7 });
    await call('sleep_target', target(1440, 1920));
    const context = await call<{ facts: Fact[] }>('sleep_context', {});
    assert.ok(!context.facts.some(fact => fact.id === a.id));
    const b = await call<Report>('sleep_report', { interpretation: '', action: '' });
    assert.equal(metric(b, 'selfReportedSleepMinutes'), undefined);
    await call('sleep_target', target());
    assert.deepEqual(sleepFacts(f.store, id), [a]);
  } finally { f.cleanup(); }
});

test('B02 a stale model tool collection cannot write facts or reports into the newly selected episode', async () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic stale tools', 'en');
    const first = f.store.setTarget(id, target());
    const stale = createSleepTools(f.store, { investigationId: () => id, episodeId: first.sleepEpisodeId });
    f.store.setTarget(id, target(1440, 1920));
    const before = f.store.snapshot(id);
    await assert.rejects(stale.find(tool => tool.name === 'sleep_fact')!.execute({ topic: 'recovery', value: 'Synthetic old session fact', scope: 'sleep' }), /EPISODE_CHANGED/);
    await assert.rejects(stale.find(tool => tool.name === 'sleep_report')!.execute({ interpretation: 'Synthetic old explanation', action: '' }), /EPISODE_CHANGED/);
    assert.deepEqual(f.store.snapshot(id), before);
  } finally { f.cleanup(); }
});

test('B02 invalid targets leave episode facts, reports, plans, and persistent rows unchanged', () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic invalid input', 'en');
    f.store.setTarget(id, target());
    save(f.store, id);
    f.store.buildReport(id);
    f.store.savePlan(id, { objective: 'Synthetic retained plan', revision: f.store.getInvestigation(id).revision, steps: [{ id: 'report', kind: 'report', description: 'Synthetic retained report', status: 'done' }] });
    const before = f.store.snapshot(id);
    const invalid = [
      { ...target(), start: 'invalid date' }, { ...target(), end: 'invalid date' },
      target(480, 480), target(480, 0), { ...target(), source: '  ' },
      { ...target(), scope: 'week' as SleepScope },
    ];
    for (const selection of invalid) {
      assert.throws(() => f.store.setTarget(id, selection), /INVALID_TARGET|INVALID_SCOPE/);
      assert.deepEqual(f.store.snapshot(id), before);
    }
    assert.throws(() => f.store.setTarget('missing-investigation', target(1440, 1920)), /INVESTIGATION_NOT_FOUND/);
    f.reopen();
    assert.deepEqual(f.store.snapshot(id), before);
  } finally { f.cleanup(); }
});

test('B02 a database failure during target persistence rolls back the newly created episode and allows retry', () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic transaction rollback', 'en');
    f.store.setTarget(id, target());
    save(f.store, id);
    const report = f.store.buildReport(id);
    const before = f.store.snapshot(id);
    const exportedBefore = readFileSync(join(f.home, 'reports', `${report.id}.json`), 'utf8');
    const db = new DatabaseSync(join(f.home, 'sleepclaw.sqlite'));
    try {
      const count = () => db.prepare('SELECT COUNT(*) AS count FROM sleep_episodes WHERE investigation_id=?').get(id)!.count;
      const originalCount = count();
      db.exec("CREATE TRIGGER synthetic_target_failure BEFORE UPDATE ON investigations WHEN json_extract(NEW.data, '$.source') = 'Synthetic Reject Source' BEGIN SELECT RAISE(ABORT, 'synthetic target persistence failure'); END;");
      assert.throws(() => f.store.setTarget(id, target(1440, 1920, 'Synthetic Reject Source')), /synthetic target persistence failure/);
      assert.equal(count(), originalCount, 'an episode created before the failed investigation write must be rolled back');
      assert.deepEqual(f.store.snapshot(id), before);
      assert.equal(readFileSync(join(f.home, 'reports', `${report.id}.json`), 'utf8'), exportedBefore);
      db.exec('DROP TRIGGER synthetic_target_failure');
    } finally { db.close(); }
    f.reopen();
    assert.deepEqual(f.store.snapshot(id), before);
    f.store.setTarget(id, target(1440, 1920));
    assert.deepEqual(sleepFacts(f.store, id), []);
    f.store.setTarget(id, target());
    assert.equal(sleepFacts(f.store, id)[0].value, 'Synthetic A recovery');
  } finally { f.cleanup(); }
});

test('B02 deletion removes every episode-owned fact without removing another investigation or profile', () => {
  const f = fixture();
  try {
    const { id } = f.store.createInvestigation('Synthetic deleted investigation', 'en');
    const other = f.store.createInvestigation('Synthetic retained investigation', 'en');
    const profile = f.store.setFact(id, { topic: 'usual_schedule', value: 'Synthetic retained profile', scope: 'profile' });
    const unrelated = save(f.store, other.id, 'Synthetic retained separate fact');
    const retainedReport = f.store.buildReport(other.id);
    const deletedFacts: Fact[] = [], deletedReports: Report[] = [];
    for (let day = 0; day < 4; day++) {
      f.store.setTarget(id, target(day * 1440, day * 1440 + 480));
      deletedFacts.push(save(f.store, id, `Synthetic removed day ${day}`));
      const report = f.store.buildReport(id);
      f.store.recordFeedback(report.id, 'later', 'Synthetic removable feedback');
      deletedReports.push(report);
    }
    f.store.deleteFact(deletedFacts[0].id);
    f.store.setTarget(id, target());
    assert.deepEqual(sleepFacts(f.store, id), []);
    f.store.setTarget(id, target(1440, 1920));
    assert.deepEqual(sleepFacts(f.store, id), [deletedFacts[1]]);
    f.store.deleteInvestigation(id);
    f.reopen();
    assert.deepEqual(f.store.snapshot(other.id).facts, persisted([profile, unrelated]));
    assert.deepEqual(f.store.snapshot(other.id).reports.map(item => item.id), [retainedReport.id]);
    assert.deepEqual(f.store.snapshot(other.id).feedback, []);
    for (const report of deletedReports) assert.equal(existsSync(join(f.home, 'reports', `${report.id}.json`)), false);
    const db = new DatabaseSync(join(f.home, 'sleepclaw.sqlite'));
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sleep_episodes WHERE investigation_id=?').get(id)!.count, 0);
      for (const fact of deletedFacts) assert.equal(db.prepare('SELECT COUNT(*) AS count FROM facts WHERE id=?').get(fact.id)!.count, 0);
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

for (const selected of [false, true]) test(`B02 v1 database migration preserves ${selected ? 'selected' : 'unbound'} facts and isolates subsequent changes`, () => {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-b02-v1-'));
  const db = new DatabaseSync(join(home, 'sleepclaw.sqlite'));
  const id = 'synthetic-v1-investigation';
  const old: Investigation = { id, goal: 'Synthetic legacy investigation', language: 'en', scope: 'main', revision: 12, status: 'collecting', createdAt: at(-1440), ...(selected ? target() : {}) };
  const fact: Fact = { id: 'synthetic-v1-fact', topic: 'sleep_duration_hours', value: 7, scope: 'sleep', status: 'known', investigationId: id, revision: 4, updatedAt: at(480) };
  const profile: Fact = { id: 'synthetic-v1-profile', topic: 'age_range', value: 'Synthetic adult', scope: 'profile', status: 'known', revision: 2, updatedAt: at(480) };
  db.exec('CREATE TABLE investigations (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE facts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, topic TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner,topic)); PRAGMA user_version=1;');
  db.prepare('INSERT INTO investigations VALUES (?,?)').run(id, JSON.stringify(old));
  for (const item of [fact, profile]) db.prepare('INSERT INTO facts VALUES (?,?,?,?)').run(item.id, item.scope === 'profile' ? 'profile' : id, item.topic, JSON.stringify(item));
  db.close();
  let store = new SleepStore(home);
  try {
    assert.equal(store.getInvestigation(id).sleepEpisodeId, id);
    assert.equal(store.getInvestigation(id).revision, old.revision);
    assert.deepEqual(sleepFacts(store, id), [fact], 'migration must not fabricate timestamps, revisions or historical attribution');
    if (!selected) store.setTarget(id, target());
    store.setTarget(id, target(1440, 1920));
    assert.deepEqual(sleepFacts(store, id), []);
    const b = save(store, id, 'Synthetic post-upgrade recovery');
    store.close(); store = new SleepStore(home);
    assert.deepEqual(sleepFacts(store, id), [b]);
    store.setTarget(id, target());
    assert.deepEqual(sleepFacts(store, id), [fact]);
    assert.deepEqual(store.snapshot(id).facts.find(item => item.scope === 'profile'), profile);
    assert.equal(metric(store.buildReport(id), 'selfReportedSleepMinutes'), 420);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

function random(seed: number) {
  let state = seed >>> 0;
  return (maximum: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor(state / 0x1_0000_0000 * maximum); };
}
for (let seed = 1; seed <= 32; seed++) test(`B02 seeded ownership sequence ${seed.toString().padStart(2, '0')}`, () => {
  const f = fixture();
  try {
    const choose = random(0xb02_2026 + seed * 7919);
    const { id } = f.store.createInvestigation(`Synthetic sequence ${seed}`, seed % 2 ? 'en' : 'zh');
    const profile = f.store.setFact(id, { topic: 'usual_schedule', scope: 'profile', value: `Synthetic profile ${seed}` });
    // Eight independent, widely spaced named sleeps, with varied length/scope.
    // The oracle uses their labels. Source and small boundary jitter never alter
    // a label; no production interval matcher is reproduced in this oracle.
    const episodes = Array.from({ length: 8 }, (_, day) => {
      const scope: SleepScope = day % 3 === 0 ? 'nap' : day % 3 === 1 ? 'main' : 'segment';
      const minutes = scope === 'nap' ? 60 + choose(60) : scope === 'segment' ? 120 + choose(120) : 360 + choose(180);
      return { label: `day-${day}`, start: day * 2880 + choose(120), minutes, scope };
    });
    const oracle = new Map<string, Record<string, { value: Fact['value']; status: Fact['status']; uncertainty: Fact['uncertainty'] }>>();
    const ids = new Map<string, string>();
    for (const episode of episodes) {
      const selected = f.store.setTarget(id, target(episode.start, episode.start + episode.minutes, 'Synthetic Anchor Watch', episode.scope));
      ids.set(episode.label, selected.sleepEpisodeId!);
      oracle.set(episode.label, {});
    }
    for (let step = 0; step < 48; step++) {
      const episode = episodes[step < episodes.length ? step : choose(episodes.length)];
      const jitterStart = choose(11) - 5, jitterEnd = choose(11) - 5;
      const selected = f.store.setTarget(id, target(episode.start + jitterStart, episode.start + episode.minutes + jitterEnd, `Synthetic Source ${choose(4)}`, episode.scope));
      assert.equal(selected.sleepEpisodeId, ids.get(episode.label), `seed ${seed}, step ${step}: source/boundary change retains named episode`);
      assert.deepEqual(factValues(f.store, id), oracle.get(episode.label));
      if (step % 3 !== 2) {
        const topic = ['recovery', 'sleep_duration_hours', 'custom.noise', 'remembered_awakenings'][choose(4)];
        const value: Fact['value'] = topic === 'sleep_duration_hours' ? (episode.minutes / 60) : topic === 'remembered_awakenings' ? choose(5) : topic === 'custom.noise' ? choose(2) === 1 : `Synthetic ${episode.label} recovery ${step}`;
        const fact = f.store.setFact(id, { topic, value, scope: 'sleep' });
        assert.equal(fact.sleepEpisodeId, ids.get(episode.label));
        oracle.get(episode.label)![topic] = { value, status: 'known', uncertainty: undefined };
      }
      assert.deepEqual(factValues(f.store, id), oracle.get(episode.label));
      assert.deepEqual(f.store.snapshot(id).facts.find(fact => fact.scope === 'profile'), persisted(profile));
      if (step % 8 === 7) {
        const report = f.store.buildReport(id);
        const expectedHours = oracle.get(episode.label)!.sleep_duration_hours?.value;
        assert.equal(metric(report, 'selfReportedSleepMinutes'), typeof expectedHours === 'number' ? Math.round(expectedHours * 60) : undefined);
        f.reopen();
        assert.deepEqual(factValues(f.store, id), oracle.get(episode.label));
      }
    }
    for (const episode of [...episodes].reverse()) {
      f.store.setTarget(id, target(episode.start, episode.start + episode.minutes, 'Synthetic Final Source', episode.scope));
      assert.deepEqual(factValues(f.store, id), oracle.get(episode.label));
    }
  } finally { f.cleanup(); }
});
