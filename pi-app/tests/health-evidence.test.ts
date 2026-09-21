import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeHealthEvidence, HEALTH_EVIDENCE_METHOD_VERSION } from '../src/health/evidence.js';
import type { HealthRecord } from '../src/shared/types.js';

const origin = Date.parse('2026-09-20T23:00:00+08:00');
const at = (minute: number) => new Date(origin + minute * 60_000).toISOString();
const options = { start: at(0), end: at(60), source: 'Watch', language: 'en' as const };
const sleep = (id: string, value: string, start: number, end: number, extra: Partial<HealthRecord> = {}): HealthRecord => ({
  id, type: 'sleep', value, source: 'Watch', start: at(start), end: at(end), startOffset: '+08:00', endOffset: '+08:00', ...extra,
});
const sample = (id: string, value: number, time: number, extra: Partial<HealthRecord> = {}): HealthRecord => ({
  ...sleep(id, '', time, time), type: 'heartRate', value, unit: 'count/min', ...extra,
});
const metric = (result: ReturnType<typeof analyzeHealthEvidence>, key: string) => result.sleep.metrics.find((entry) => entry.key === key)?.value;
const physiology = (result: ReturnType<typeof analyzeHealthEvidence>, type: HealthRecord['type']) => result.physiology.find((entry) => entry.type === type)!;

test('reuses interval union and detailed stages without double-counting inBed or generic asleep', () => {
  const result = analyzeHealthEvidence([
    sleep('bed', 'inBed', -10, 70), sleep('generic', 'unspecified', 0, 60),
    sleep('core', 'core', 0, 40), sleep('rem', 'rem', 40, 60),
  ], options);
  assert.equal(result.methodVersion, HEALTH_EVIDENCE_METHOD_VERSION);
  assert.equal(metric(result, 'totalSleepMinutes'), 60);
  assert.equal(metric(result, 'inBedMinutes'), 60);
  assert.equal(metric(result, 'sleepEfficiencyPercent'), 100);
  assert.equal(metric(result, 'awakeMinutes'), null);
  assert.deepEqual(result.sleep.stages, { core: 40, rem: 20 });
  assert.equal(result.sleep.observedMinutes, 60);
  assert.equal(result.sleep.observedAwakeMinutes, null);
  assert.equal(result.sleep.coveragePercent, 100);
  assert.equal(result.sleep.stageChangeCount, 1);
  assert.deepEqual(result.sleep.gaps, []);
});

test('selects only one source and deduplicates IDs before sample statistics', () => {
  const original = sample('a', 60, 10);
  const result = analyzeHealthEvidence([
    { ...original, source: 'Other watch', value: 200 }, original, { ...original, value: 100 },
    sample('b', 80, 20, { source: 'Phone' }), sample('c', 70, 30),
  ], options);
  const hr = physiology(result, 'heartRate');
  assert.equal(hr.source, 'Watch');
  assert.equal(hr.count, 2);
  assert.equal(hr.median, 65);
  assert.equal(result.counts.otherSource, 2);
  assert.equal(result.counts.selected, 3);
  assert.equal(result.counts.duplicates, 1);
  assert.deepEqual(result.inputRecordIds, ['a', 'c']);
});

test('reports unobserved gaps without treating them as awake and flags incomplete inBed coverage', () => {
  const result = analyzeHealthEvidence([
    sleep('bed', 'inBed', 0, 60), sleep('core', 'core', 0, 20), sleep('awake', 'awake', 40, 50),
  ], options);
  assert.equal(result.sleep.observedSleepMinutes, 20);
  assert.equal(result.sleep.observedAwakeMinutes, 10);
  assert.equal(result.sleep.observedMinutes, 30);
  assert.equal(result.sleep.coveragePercent, 50);
  assert.equal(result.sleep.unobservedMinutes, 30);
  assert.equal(result.sleep.inBedUnobservedMinutes, 30);
  assert.equal(metric(result, 'sleepEfficiencyPercent'), null);
  assert.equal(result.sleep.stageChangeCount, 0);
  assert.deepEqual(result.sleep.gaps, [
    { start: at(20), end: at(40), minutes: 20 }, { start: at(50), end: at(60), minutes: 10 },
  ]);
  assert.ok(result.warnings.some((entry) => entry.code === 'in_bed_coverage_incomplete'));
});

test('measures sleep-awake overlap once while shared totals remain null', () => {
  const result = analyzeHealthEvidence([
    sleep('bed', 'inBed', 0, 60), sleep('asleep', 'core', 0, 60), sleep('awake', 'awake', 10, 25),
    sleep('awake-again', 'awake', 20, 30),
  ], options);
  assert.equal(result.sleep.sleepAwakeConflictMinutes, 20);
  assert.equal(result.sleep.observedMinutes, 60);
  assert.equal(result.sleep.observedSleepMinutes, 60);
  assert.equal(result.sleep.observedAwakeMinutes, 20);
  assert.equal(metric(result, 'totalSleepMinutes'), null);
  assert.equal(metric(result, 'awakeMinutes'), null);
  assert.equal(metric(result, 'sleepEfficiencyPercent'), null);
  assert.ok(result.warnings.some((entry) => entry.code === 'sleep_awake_conflict'));
});

test('detailed stage conflicts are distinct from generic asleep overlays', () => {
  const result = analyzeHealthEvidence([
    sleep('generic', 'unspecified', 0, 40), sleep('core', 'core', 0, 30), sleep('deep', 'deep', 10, 20),
  ], options);
  assert.equal(result.sleep.stageConflictMinutes, 10);
  assert.equal(result.sleep.sleepAwakeConflictMinutes, 0);
  assert.deepEqual(result.sleep.stages, { core: 20, unknown: 10, unspecified: 10 });
  assert.equal(metric(result, 'totalSleepMinutes'), 40);
  assert.equal(result.sleep.stageChangeCount, 0);
});

test('counts contiguous unambiguous label changes without bridging unspecified sleep or missing intervals', () => {
  const result = analyzeHealthEvidence([
    sleep('core', 'core', 0, 10), sleep('rem', 'rem', 10, 20), sleep('generic', 'unspecified', 20, 30),
    sleep('deep', 'deep', 30, 40), sleep('awake', 'awake', 50, 60),
  ], options);
  assert.equal(result.sleep.stageChangeCount, 1);
  assert.match(result.sleep.stageChangeNote, /not a clinical arousal count/);
});

test('simple-statistics 7.12.0 produces explicitly versioned linear-r7 quantiles', () => {
  const result = analyzeHealthEvidence([54, 56, 58, 60, 62].map((value, index) => sample(String(index), value, index * 10)), options);
  const hr = physiology(result, 'heartRate');
  assert.equal(hr.quantileMethod, 'linear-r7');
  assert.equal(hr.count, 5);
  assert.equal(hr.min, 54); assert.equal(hr.max, 62); assert.equal(hr.median, 58);
  assert.equal(hr.p25, 56); assert.equal(hr.p75, 60);
  const two = physiology(analyzeHealthEvidence([sample('a', 1, 0), sample('b', 3, 10)], options), 'heartRate');
  assert.equal(two.p25, 1.5); assert.equal(two.p75, 2.5); assert.equal(two.median, 2);
});

test('sample spacing is chronological and a singleton has no observed inter-sample gap', () => {
  const result = analyzeHealthEvidence([sample('last', 80, 50), sample('first', 60, 5), sample('middle', 70, 15),
    sample('hrv', 35, 25, { type: 'hrv', unit: 'ms' })], options);
  const hr = physiology(result, 'heartRate');
  assert.equal(hr.firstSample, at(5)); assert.equal(hr.lastSample, at(50)); assert.equal(hr.largestGapMinutes, 35);
  const hrv = physiology(result, 'hrv');
  assert.equal(hrv.count, 1); assert.equal(hrv.median, 35); assert.equal(hrv.p25, 35); assert.equal(hrv.p75, 35);
  assert.equal(hrv.largestGapMinutes, null);
  assert.equal(hrv.firstSample, at(25)); assert.equal(hrv.lastSample, at(25));
});

test('missing sleep and physiology remain unknown, including inBed-only records', () => {
  const result = analyzeHealthEvidence([sleep('bed', 'inBed', 0, 60)], options);
  assert.equal(result.sleep.observedSleepMinutes, null);
  assert.equal(result.sleep.observedAwakeMinutes, null);
  assert.equal(result.sleep.observedMinutes, null);
  assert.equal(result.sleep.coveragePercent, null);
  assert.equal(result.sleep.stageChangeCount, null);
  assert.equal(result.sleep.unobservedMinutes, 60);
  for (const item of result.physiology) {
    assert.equal(item.count, 0);
    for (const key of ['min', 'max', 'median', 'p25', 'p75', 'firstSample', 'lastSample', 'largestGapMinutes'] as const) assert.equal(item[key], null);
  }
});

test('clips interval quantities and sleep to a half-open window and excludes end-boundary points', () => {
  const result = analyzeHealthEvidence([
    sleep('touch-start', 'deep', -10, 0), sleep('touch-end', 'deep', 60, 70), sleep('crossing', 'core', -10, 10),
    sample('start', 50, 0), sample('end', 100, 60), sample('interval', 70, -5, { end: at(5) }),
  ], options);
  assert.equal(result.window.intervalConvention, '[start,end)');
  assert.equal(result.counts.outsideWindow, 3);
  assert.equal(result.sleep.observedSleepMinutes, 10);
  const hr = physiology(result, 'heartRate');
  assert.equal(hr.count, 2); assert.equal(hr.median, 60); assert.equal(hr.firstSample, at(0));
  assert.equal(hr.largestGapMinutes, 0);
});

test('HealthKit oxygen fractions become percentages without accepting already-scaled values', () => {
  const oxygen = (id: string, value: number, extra: Partial<HealthRecord> = {}) => sample(id, value, 10, { type: 'oxygenSaturation', unit: '%', ...extra });
  const result = analyzeHealthEvidence([oxygen('a', 0.95), oxygen('b', 1), oxygen('scaled', 97), oxygen('negative', -0.1), oxygen('unit', 0.98, { unit: 'fraction' })], options);
  const spo2 = physiology(result, 'oxygenSaturation');
  assert.equal(spo2.count, 2); assert.equal(spo2.unit, '%'); assert.deepEqual(spo2.inputUnits, ['%']);
  assert.equal(spo2.min, 95); assert.equal(spo2.max, 100); assert.equal(spo2.median, 97.5);
  assert.equal(result.counts.rejected.outOfRangeValue, 1);
  assert.equal(result.counts.rejected.negativeValue, 1);
  assert.equal(result.counts.rejected.unsupportedUnit, 1);
});

test('rejects invalid dates, reversed intervals, nonfinite values and incompatible units by reason', () => {
  const result = analyzeHealthEvidence([
    sample('date', 60, 0, { start: '2026-02-30T00:00:00Z' }),
    sample('local', 60, 0, { start: '2026-09-20T23:00:00' }),
    sleep('reversed', 'core', 20, 10), sleep('zero', 'core', 10, 10),
    sample('nan', NaN, 10), sample('infinite', Infinity, 10), sample('string', 60, 10, { value: '60' }),
    sample('negative', -1, 10), sample('wrong-unit', 60, 10, { unit: 'ms' }),
    sample('wrong-hrv', 30, 10, { type: 'hrv', unit: 'bpm' }),
    sample('wrong-respiration', 15, 10, { type: 'respiratoryRate', unit: 'ms' }),
    sleep('sleep-unit', 'core', 0, 60, { unit: 'min' }), sleep('unknown-stage', 'N2', 0, 60),
    { ...sample('unknown-type', 60, 10), type: 'rrIntervals' } as unknown as HealthRecord,
  ], options);
  assert.deepEqual(result.counts.rejected, { invalidDate: 2, invalidInterval: 2, invalidValue: 3, negativeValue: 1, outOfRangeValue: 0, unsupportedUnit: 4, unsupportedType: 1, unsupportedStage: 1 });
  assert.equal(result.counts.accepted, 0);
});

test('normalizes offset and DST windows to elapsed UTC time', () => {
  const start = '2026-11-01T00:00:00-04:00', end = '2026-11-01T04:00:00-05:00';
  const result = analyzeHealthEvidence([sleep('dst', 'core', 0, 1, { start, end })], { ...options, start, end });
  assert.equal(result.window.start, '2026-11-01T04:00:00.000Z');
  assert.equal(result.window.end, '2026-11-01T09:00:00.000Z');
  assert.equal(result.window.durationMinutes, 300);
  assert.equal(result.sleep.observedSleepMinutes, 300);
  const offset = analyzeHealthEvidence([sample('same-instant', 70, 0, { start: '2026-09-20T23:00:00+08:00', end: '2026-09-20T15:00:00Z' })], options);
  assert.equal(physiology(offset, 'heartRate').count, 1);
});

test('bounds IDs and gap segments while calculating all accepted observations', () => {
  const records = Array.from({ length: 201 }, (_, index) => sleep(String(index), 'core', index * 2, index * 2 + 1));
  const result = analyzeHealthEvidence(records, { ...options, end: at(402) });
  assert.equal(result.inputRecordIds.length, 200); assert.equal(result.inputRecordIdsTruncated, true);
  assert.equal(result.counts.accepted, 201); assert.equal(result.sleep.observedSleepMinutes, 201);
  assert.equal(result.sleep.unobservedMinutes, 201);
  assert.equal(result.sleep.gaps.length, 200); assert.equal(result.sleep.gapCount, 201); assert.equal(result.sleep.gapsTruncated, true);
});

test('never reconstructs RR intervals or HRV from discrete heart-rate samples', () => {
  const result = analyzeHealthEvidence([sample('a', 60, 1), sample('b', 62, 2), sample('c', 58, 3)], options);
  assert.equal(physiology(result, 'hrv').count, 0);
  assert.equal(physiology(result, 'hrv').median, null);
  assert.match(result.limitations.find((item) => item.code === 'rr_intervals_unavailable')!.text, /not reconstructed/);
});

test('generic asleep and entirely conflicted labels cannot establish a stage-change count', () => {
  const generic = analyzeHealthEvidence([sleep('generic', 'unspecified', 0, 60)], options);
  assert.equal(generic.sleep.observedSleepMinutes, 60);
  assert.equal(generic.sleep.stageChangeCount, null);
  const conflict = analyzeHealthEvidence([sleep('core', 'core', 0, 60), sleep('deep', 'deep', 0, 60)], options);
  assert.equal(conflict.sleep.stageConflictMinutes, 60);
  assert.equal(conflict.sleep.stageChangeCount, null);
});

test('accepts compatible source units explicitly without inferring unsupported conversions', () => {
  const result = analyzeHealthEvidence([
    sample('bpm', 60, 1, { unit: 'bpm' }), sample('count', 62, 2),
    sample('resp', 16, 3, { type: 'respiratoryRate' }), sample('hrv', 0, 4, { type: 'hrv', unit: 'ms' }),
  ], options);
  assert.deepEqual(physiology(result, 'heartRate').inputUnits, ['bpm', 'count/min']);
  assert.equal(physiology(result, 'respiratoryRate').median, 16);
  assert.equal(physiology(result, 'hrv').median, 0);
});

test('localizes result prose and rejects invalid source/window options', () => {
  const english = analyzeHealthEvidence([], options);
  assert.doesNotMatch(JSON.stringify(english), /[\u3400-\u9fff]/);
  const chinese = analyzeHealthEvidence([], { ...options, language: 'zh' });
  assert.match(chinese.limitations[0].text, /不提供诊断/);
  assert.throws(() => analyzeHealthEvidence([], { ...options, start: 'invalid' }), /Invalid analysis window/);
  assert.throws(() => analyzeHealthEvidence([], { ...options, end: options.start }), /Invalid analysis window/);
  assert.throws(() => analyzeHealthEvidence([], { ...options, source: ' ' }), /Select one data source/);
});

test('is pure and serializable, and does not alter input values or record order', () => {
  const records = [sample('z', 65, 20), sleep('a', 'core', 0, 10), sample('a-rate', 60, 10)];
  const before = structuredClone(records);
  records.forEach(Object.freeze); Object.freeze(records);
  const first = analyzeHealthEvidence(records, options);
  assert.deepEqual(records, before);
  assert.deepEqual(first, analyzeHealthEvidence([...records].reverse(), options));
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});
