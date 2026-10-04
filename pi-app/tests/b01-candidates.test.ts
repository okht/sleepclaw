import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeRecords, identifyCandidates } from '../src/health/analysis.js';
import { analyzeHealthEvidence } from '../src/health/evidence.js';
import type { HealthRecord, Metric, SleepCandidate } from '../src/shared/types.js';

/** Synthetic acceptance cases. Expected values describe the recorded episode, not algorithm steps. */
const origin = Date.parse('2026-10-03T22:00:00+08:00');
const at = (minute: number) => new Date(origin + minute * 60_000).toISOString();
const sleep = (id: string, value: string, start: number, end: number, source = 'Watch'): HealthRecord => ({
  id, type: 'sleep', value, source, start: at(start), end: at(end), startOffset: '+08:00', endOffset: '+08:00',
});
const value = (metrics: Metric[], key: string) => metrics.find((entry) => entry.key === key)?.value;
const ratio = (asleep: number, inBed: number) => Math.round(asleep / inBed * 10_000) / 100;
const fullyObserved = (source = 'Watch'): HealthRecord[] => [
  sleep(`${source}-bed`, 'inBed', 0, 540, source),
  sleep(`${source}-sleep`, 'core', 60, 510, source),
  sleep(`${source}-before`, 'awake', 0, 60, source),
  sleep(`${source}-after`, 'awake', 510, 540, source),
];

interface Expected {
  start: number; end: number; asleep: number; awake: number | null; inBed: number | null;
  efficiency: number | null; source?: string; totalSleep?: number | null;
}
interface Case { name: string; records: HealthRecord[]; expected: Expected[] }
const full: Expected = { start: 0, end: 540, asleep: 450, awake: 90, inBed: 540, efficiency: 83.33 };
const bare = (start: number, end: number, asleep = end - start): Expected => ({ start, end, asleep, awake: null, inBed: null, efficiency: null });

const cases: Case[] = [
  { name: 'B01 full night preserves both awake edges: 450 / 540 = 83.33%', records: fullyObserved(), expected: [full] },
  { name: 'only sleep-onset awake time remains in the episode', records: [sleep('bed', 'inBed', 0, 480), sleep('sleep', 'core', 30, 480), sleep('awake', 'awake', 0, 30)], expected: [{ start: 0, end: 480, asleep: 450, awake: 30, inBed: 480, efficiency: 93.75 }] },
  { name: 'only wake-up awake time remains in the episode', records: [sleep('bed', 'inBed', 0, 480), sleep('sleep', 'rem', 0, 450), sleep('awake', 'awake', 450, 480)], expected: [{ start: 0, end: 480, asleep: 450, awake: 30, inBed: 480, efficiency: 93.75 }] },
  { name: 'a fully observed all-asleep bed episode may still have 100% efficiency', records: [sleep('bed', 'inBed', 0, 60), sleep('sleep', 'unspecified', 0, 60)], expected: [{ start: 0, end: 60, asleep: 60, awake: null, inBed: 60, efficiency: 100 }] },
  { name: 'unobserved bed edges remain unknown rather than becoming awake', records: [sleep('bed', 'inBed', 0, 540), sleep('sleep', 'core', 60, 510)], expected: [{ ...full, awake: null, efficiency: null }] },
  { name: 'awake edges survive even when there is no bed record', records: fullyObserved().filter((record) => record.value !== 'inBed'), expected: [{ ...full, inBed: null, efficiency: null }] },
  { name: 'a sleep-only record keeps its original duration and unknown efficiency', records: [sleep('sleep', 'deep', 60, 510)], expected: [bare(60, 510)] },
  { name: 'another source cannot supply missing bed or awake boundaries', records: [sleep('sleep', 'core', 60, 510), ...fullyObserved('Phone').filter((record) => record.value !== 'core')], expected: [bare(60, 510)] },
  { name: 'overlapping sources retain independent episodes and efficiencies', records: [...fullyObserved(), sleep('phone-bed', 'inBed', -60, 600, 'Phone'), sleep('phone-sleep', 'unspecified', -30, 570, 'Phone'), sleep('phone-before', 'awake', -60, -30, 'Phone'), sleep('phone-after', 'awake', 570, 600, 'Phone')], expected: [full, { source: 'Phone', start: -60, end: 600, asleep: 600, awake: 60, inBed: 660, efficiency: 90.91 }] },
  { name: 'duplicate IDs and duplicate intervals do not increase sleep or awake totals', records: [...fullyObserved(), ...fullyObserved(), ...fullyObserved().map((record) => ({ ...record, id: `copy-${record.id}` }))], expected: [full] },
  { name: 'generic sleep over detailed stages is counted once', records: [sleep('bed', 'inBed', 0, 540), sleep('generic', 'unspecified', 60, 510), sleep('core', 'core', 60, 300), sleep('rem', 'rem', 300, 510), sleep('before', 'awake', 0, 60), sleep('after', 'awake', 510, 540)], expected: [full] },
  { name: 'adjacent partial bed records preserve the full night', records: [...fullyObserved().filter((record) => record.value !== 'inBed'), sleep('bed-1', 'inBed', 0, 270), sleep('bed-2', 'inBed', 270, 540)], expected: [full] },
  { name: 'separate bed intervals do not fill a recorded out-of-bed gap', records: [sleep('bed-1', 'inBed', 0, 250), sleep('bed-2', 'inBed', 280, 540), sleep('sleep-1', 'core', 60, 250), sleep('sleep-2', 'rem', 280, 510), sleep('before', 'awake', 0, 60), sleep('after', 'awake', 510, 540)], expected: [{ start: 0, end: 540, asleep: 420, awake: 90, inBed: 510, efficiency: 82.35 }] },
  { name: 'a 90-minute interruption remains inside one candidate', records: [sleep('bed', 'inBed', 0, 150), sleep('sleep-1', 'core', 0, 30), sleep('awake', 'awake', 30, 120), sleep('sleep-2', 'rem', 120, 150)], expected: [{ start: 0, end: 150, asleep: 60, awake: 90, inBed: 150, efficiency: 40 }] },
  { name: 'a shared bed spanning a 91-minute split cannot fabricate two 100% nights', records: [sleep('bed', 'inBed', 0, 151), sleep('sleep-1', 'core', 0, 30), sleep('awake', 'awake', 30, 121), sleep('sleep-2', 'rem', 121, 151)], expected: [{ ...bare(121, 151), inBed: 30 }, { ...bare(0, 30), inBed: 30 }] },
  { name: 'one awake record touching two separated sleeps does not merge them', records: [sleep('sleep-1', 'core', 0, 30), sleep('awake', 'awake', 30, 180), sleep('sleep-2', 'rem', 180, 210)], expected: [bare(180, 210), bare(0, 30)] },
  { name: 'a multi-day bed record cannot absorb a later nap into the night', records: [sleep('bed', 'inBed', -3000, 3000), sleep('night', 'core', 0, 480), sleep('nap', 'core', 900, 930)], expected: [{ ...bare(900, 930), inBed: 30 }, { ...bare(0, 480), inBed: 480 }] },
  { name: 'a separate nap retains its own bed boundary and efficiency', records: [...fullyObserved(), sleep('nap-bed', 'inBed', 900, 945), sleep('nap-sleep', 'core', 910, 940), sleep('nap-before', 'awake', 900, 910), sleep('nap-after', 'awake', 940, 945)], expected: [{ start: 900, end: 945, asleep: 30, awake: 15, inBed: 45, efficiency: 66.67 }, full] },
  { name: 'bed-only and awake-only observations do not invent sleep candidates', records: [sleep('bed', 'inBed', 0, 540), sleep('awake', 'awake', 600, 700)], expected: [] },
  { name: 'disconnected and merely touching bed records do not widen an unrelated sleep', records: [sleep('sleep', 'core', 60, 510), sleep('before-bed', 'inBed', 0, 60), sleep('after-bed', 'inBed', 510, 540), sleep('unrelated-awake', 'awake', -120, -90)], expected: [bare(60, 510)] },
  { name: 'conflicting padding cannot make distinct candidates overlap', records: [sleep('sleep-1', 'core', 0, 30), sleep('sleep-2', 'rem', 180, 210), sleep('bed', 'inBed', -30, 120), sleep('awake', 'awake', 90, 180)], expected: [bare(180, 210), { ...bare(0, 30), inBed: 30 }] },
  { name: 'partial observed awake edges do not hide the remaining gaps', records: [sleep('bed', 'inBed', 0, 540), sleep('sleep', 'core', 60, 510), sleep('before', 'awake', 0, 30), sleep('after', 'awake', 525, 540)], expected: [{ ...full, awake: 45, efficiency: null }] },
  { name: 'sleep-awake conflicts keep metrics unavailable after boundary expansion', records: [sleep('bed', 'inBed', 0, 540), sleep('sleep', 'core', 60, 510), sleep('before', 'awake', 0, 70), sleep('after', 'awake', 510, 540)], expected: [{ ...full, awake: null, totalSleep: null, efficiency: null }] },
  { name: 'stage conflicts do not double-count otherwise fully observed sleep', records: [...fullyObserved(), sleep('conflicting-stage', 'deep', 300, 400)], expected: [full] },
  { name: 'a long single bed interval preserves unknown coverage without a guessed duration cap', records: [sleep('bed', 'inBed', 0, 1500), sleep('sleep', 'core', 300, 780)], expected: [{ start: 0, end: 1500, asleep: 480, awake: null, inBed: 1500, efficiency: null }] },
  { name: 'overlapping bed fragments and awake fragments are not double-counted', records: [sleep('bed-1', 'inBed', 0, 300), sleep('bed-2', 'inBed', 240, 540), sleep('sleep', 'core', 60, 510), sleep('before-1', 'awake', 0, 40), sleep('before-2', 'awake', 20, 60), sleep('after', 'awake', 510, 540)], expected: [full] },
];

function verify(records: HealthRecord[], expected: Expected[]): SleepCandidate[] {
  const before = structuredClone(records);
  const candidates = identifyCandidates(records);
  assert.equal(candidates.length, expected.length, 'candidate count');
  for (const [index, candidate] of candidates.entries()) {
    const wanted = expected[index];
    assert.deepEqual({ source: candidate.source, start: candidate.start, end: candidate.end, asleep: candidate.asleepMinutes }, {
      source: wanted.source ?? 'Watch', start: at(wanted.start), end: at(wanted.end), asleep: wanted.asleep,
    }, `candidate ${index} selected episode`);
    const analysis = analyzeRecords(records, candidate);
    const evidence = analyzeHealthEvidence(records, { ...candidate, language: 'en' });
    const totals = { totalSleepMinutes: wanted.totalSleep === undefined ? wanted.asleep : wanted.totalSleep, awakeMinutes: wanted.awake, inBedMinutes: wanted.inBed, sleepEfficiencyPercent: wanted.efficiency };
    for (const [key, expectedValue] of Object.entries(totals)) {
      assert.equal(value(analysis.metrics, key), expectedValue, `candidate ${index}: ${key}`);
      assert.equal(value(evidence.sleep.metrics, key), expectedValue, `evidence ${index}: ${key}`);
    }
    assert.ok(Date.parse(candidate.start) < Date.parse(candidate.end));
    if (analysis.inBedBoundaryClipped) assert.ok(evidence.warnings.some((warning) => warning.code === 'in_bed_boundary_clipped'));
  }
  for (const source of new Set(candidates.map((candidate) => candidate.source))) {
    const ordered = candidates.filter((candidate) => candidate.source === source).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    for (let index = 1; index < ordered.length; index++) assert.ok(Date.parse(ordered[index - 1].end) <= Date.parse(ordered[index].start), 'distinct same-source episodes do not overlap');
  }
  assert.deepEqual(records, before, 'candidate and metric analysis must not mutate inputs');
  return candidates;
}

for (const scenario of cases) test(`B01 acceptance: ${scenario.name}`, () => {
  scenario.records.forEach(Object.freeze);
  Object.freeze(scenario.records);
  const candidates = verify(scenario.records, scenario.expected);
  assert.deepEqual(identifyCandidates([...scenario.records].reverse()), candidates, 'record order does not affect candidate IDs or boundaries');
});

test('B01 manually cropped windows suppress full-episode efficiency and explain the boundary in both APIs', () => {
  for (const window of [{ start: at(60), end: at(510) }, { start: at(30), end: at(540) }, { start: at(0), end: at(525) }]) {
    const options = { ...window, source: 'Watch' };
    const analysis = analyzeRecords(fullyObserved(), options);
    const evidence = analyzeHealthEvidence(fullyObserved(), { ...options, language: 'en' });
    assert.equal(value(analysis.metrics, 'sleepEfficiencyPercent'), null);
    assert.equal(value(evidence.sleep.metrics, 'sleepEfficiencyPercent'), null);
    assert.equal(analysis.inBedBoundaryClipped, true);
    assert.ok(analysis.warnings.some((warning) => warning.includes('截断')));
    assert.ok(evidence.warnings.some((warning) => warning.code === 'in_bed_boundary_clipped' && warning.text.includes('clips')));
  }
  const inferred = analyzeRecords(fullyObserved(), { source: 'Watch' });
  assert.equal(value(inferred.metrics, 'sleepEfficiencyPercent'), 83.33, 'an unbounded whole-episode analysis remains valid');
});

test('B01 source ambiguity and unrelated physiology preserve the original contracts', () => {
  const records = [...fullyObserved(), ...fullyObserved('另一只手表')];
  assert.equal(value(analyzeRecords(records).metrics, 'totalSleepMinutes'), null);
  const noisy = [...fullyObserved(), { ...sleep('rate', '', -10000, 10000, 'Phone'), type: 'heartRate' as const, value: 60, unit: 'count/min' }];
  assert.deepEqual(identifyCandidates(noisy), identifyCandidates(fullyObserved()));
});

test('B01 DST and equivalent offset strings measure elapsed time, including awake edges', () => {
  const record = (id: string, stage: string, start: string, end: string): HealthRecord => ({ ...sleep(id, stage, 0, 1), start, end });
  const records = [
    record('bed', 'inBed', '2026-11-01T00:00:00-04:00', '2026-11-01T06:00:00-05:00'),
    record('before', 'awake', '2026-11-01T00:00:00-04:00', '2026-11-01T00:30:00-04:00'),
    record('sleep', 'core', '2026-11-01T00:30:00-04:00', '2026-11-01T05:30:00-05:00'),
    record('after', 'awake', '2026-11-01T05:30:00-05:00', '2026-11-01T06:00:00-05:00'),
  ];
  const candidate = identifyCandidates(records)[0];
  assert.equal(candidate.start, '2026-11-01T04:00:00.000Z');
  assert.equal(candidate.end, '2026-11-01T11:00:00.000Z');
  assert.equal(candidate.asleepMinutes, 360);
  const analysis = analyzeRecords(records, candidate);
  assert.equal(value(analysis.metrics, 'inBedMinutes'), 420);
  assert.equal(value(analysis.metrics, 'awakeMinutes'), 60);
  assert.equal(value(analysis.metrics, 'sleepEfficiencyPercent'), 85.71);
  const utc = records.map((entry) => ({ ...entry, start: new Date(entry.start).toISOString(), end: new Date(entry.end).toISOString() }));
  assert.deepEqual(identifyCandidates(utc), [candidate]);
});

test('B01 malformed and non-positive sleep intervals do not create candidates', () => {
  const invalid = [sleep('zero', 'core', 10, 10), sleep('reversed', 'core', 30, 20), { ...sleep('bad-date', 'core', 0, 60), start: 'invalid' }, sleep('unsupported', 'future-stage', -100, 100)];
  assert.deepEqual(identifyCandidates(invalid), []);
  assert.deepEqual(identifyCandidates([...fullyObserved(), ...invalid]), identifyCandidates(fullyObserved()));
});

/** Fixed seed makes broader combinations reproducible without a property-testing dependency. */
function rng(seed: number) {
  let state = seed >>> 0;
  return (max: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % max; };
}
function shuffle<T>(items: T[], random: (max: number) => number): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = random(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  return shuffled;
}
function asOffset(iso: string, offsetMinutes: number): string {
  const local = new Date(Date.parse(iso) + offsetMinutes * 60_000).toISOString().slice(0, -1);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const amount = Math.abs(offsetMinutes);
  return `${local}${sign}${String(Math.floor(amount / 60)).padStart(2, '0')}:${String(amount % 60).padStart(2, '0')}`;
}

for (let seed = 1; seed <= 64; seed++) test(`B01 seeded generalization ${seed}: independent duration oracle and reversible transformations`, () => {
  const random = rng(0xb0100000 + seed);
  const start = random(20000) - 10000;
  const before = 1 + random(90), firstSleep = 1 + random(300), interruption = 1 + random(90), secondSleep = 1 + random(300), after = 1 + random(90);
  const middle = start + before + firstSleep, resumed = middle + interruption, wake = resumed + secondSleep, end = wake + after;
  const source = ['Watch', '手表⌚', 'Phone / Health'][random(3)];
  const records = [sleep('bed', 'inBed', start, end, source), sleep('before', 'awake', start, start + before, source), sleep('s1', 'core', start + before, middle, source), sleep('between', 'awake', middle, resumed, source), sleep('s2', 'rem', resumed, wake, source), sleep('after', 'awake', wake, end, source)];
  const totalSleep = firstSleep + secondSleep, totalAwake = before + interruption + after, totalBed = totalSleep + totalAwake;
  const expected: Expected = { source, start, end, asleep: totalSleep, awake: totalAwake, inBed: totalBed, efficiency: ratio(totalSleep, totalBed) };
  const original = verify(records, [expected]);
  const repeated = records.flatMap((entry) => [entry, { ...entry, id: `replica-${entry.id}` }, entry]);
  assert.deepEqual(verify(shuffle(repeated, random), [expected]), original, 'duplicates and random order preserve ID, boundary and totals');
  const offset = [-420, 0, 330, 345, 480][random(5)];
  const equivalent = records.map((entry) => ({ ...entry, start: asOffset(entry.start, offset), end: asOffset(entry.end, offset) }));
  assert.deepEqual(verify(equivalent, [expected]), original, 'equivalent offset representations preserve candidates');
  const shift = (1 + random(20)) * 1440;
  const shifted = records.map((entry) => ({ ...entry, start: new Date(Date.parse(entry.start) + shift * 60_000).toISOString(), end: new Date(Date.parse(entry.end) + shift * 60_000).toISOString() }));
  verify(shifted, [{ ...expected, start: start + shift, end: end + shift }]);
  const foreign = records.map((entry) => ({ ...entry, id: `foreign-${entry.id}`, source: `${source}-foreign` }));
  const selected = identifyCandidates([...records, ...foreign]).find((candidate) => candidate.source === source);
  assert.deepEqual(selected, original[0], 'adding another source cannot alter the selected source candidate');
});
