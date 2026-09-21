import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SleepStore } from '../src/domain/index.js';
import { reportContent } from '../src/domain/report.js';
import { analyzeRecords } from '../src/health/index.js';
import type { Fact, FactUncertainty, Language, Metric, Report } from '../src/shared/types.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-report-uncertainty-'));
  const store = new SleepStore(home);
  return { home, store, cleanup: () => { store.close(); rmSync(home, { recursive: true, force: true }); } };
}

const target = { start: '2026-09-20T15:00:00.000Z', end: '2026-09-20T22:30:00.000Z', source: 'Test Watch' };
const range: FactUncertainty = { kind: 'range', original: 'Between six and seven hours', lower: 6, upper: 7, unit: 'hours' };
const rangePattern = (language: Language) => language === 'zh' ? /自述估计睡眠时长为 6～7 小时/ : /Estimated sleep duration: 6–7 hours \(self-reported range\)/;
const stripNotes = (metrics: Metric[]) => metrics.map(({ note: _note, ...metric }) => metric);

async function importRecords(home: string, store: SleepStore) {
  const path = join(home, 'test-export.xml');
  const sleep = (value: string, start: string, end: string) => `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Test Watch" startDate="${start}" endDate="${end}" value="HKCategoryValueSleepAnalysis${value}"/>`;
  const sample = (type: string, unit: string, value: number) => `<Record type="HKQuantityTypeIdentifier${type}" sourceName="Test Watch" startDate="2026-09-21 02:00:00 +0800" endDate="2026-09-21 02:00:00 +0800" value="${value}" unit="${unit}"/>`;
  writeFileSync(path, `<HealthData>${[
    sleep('InBed', '2026-09-20 23:00:00 +0800', '2026-09-21 06:30:00 +0800'),
    sleep('AsleepCore', '2026-09-20 23:00:00 +0800', '2026-09-21 06:00:00 +0800'),
    sleep('Awake', '2026-09-21 06:00:00 +0800', '2026-09-21 06:30:00 +0800'),
    sample('HeartRate', 'count/min', 64), sample('HeartRate', 'count/min', 68),
    sample('HeartRateVariabilitySDNN', 'ms', 40), sample('RespiratoryRate', 'count/min', 14),
    sample('OxygenSaturation', '%', 0.98),
  ].join('')}</HealthData>`);
  await store.importFile(path);
}

test('English report JSON localizes every current metric note while device numbers and Chinese notes stay unchanged', async () => {
  const { home, store, cleanup } = fixture();
  try {
    await importRecords(home, store);
    const baseline = analyzeRecords(store.getRecords(target), target);
    for (const language of ['en', 'zh'] as const) {
      const { id } = store.createInvestigation('Review this sleep', language);
      store.setTarget(id, target);
      const report = store.buildReport(id);
      const originalMetrics = report.metrics.filter(metric => !metric.key.startsWith('stage_'));
      assert.deepEqual(stripNotes(originalMetrics), stripNotes(baseline.metrics));
      assert.equal(report.metrics.find(metric => metric.key === 'totalSleepMinutes')?.value, 420);
      assert.equal(report.metrics.find(metric => metric.key === 'awakeMinutes')?.value, 30);
      assert.equal(report.metrics.find(metric => metric.key === 'inBedMinutes')?.value, 450);
      assert.equal(report.metrics.find(metric => metric.key === 'sleepEfficiencyPercent')?.value, 93.33);
      assert.equal(report.metrics.find(metric => metric.key === 'heartRateMean')?.value, 66);
      assert.equal(report.metrics.find(metric => metric.key === 'stage_core_minutes')?.value, 420);
      assert.equal(report.score, null);
      const exported = JSON.parse(readFileSync(join(home, 'reports', `${report.id}.json`), 'utf8')) as Report;
      assert.deepEqual(exported.metrics, report.metrics);
      if (language === 'en') {
        for (const metric of exported.metrics) assert.doesNotMatch(metric.note ?? '', /[\u4e00-\u9fff]/);
        assert.match(exported.metrics.find(metric => metric.key === 'totalSleepMinutes')!.note!, /Union of intervals/);
        assert.match(exported.metrics.find(metric => metric.key === 'heartRateMean')!.note!, /Arithmetic mean of recorded samples/);
      } else assert.deepEqual(originalMetrics, baseline.metrics);
    }
    assert.match(baseline.metrics[0].note!, /设备标记/, 'report localization must not mutate the analysis');
  } finally { cleanup(); }
});

test('known self-reported hour ranges are visible in both languages without adding a midpoint metric or score', () => {
  const { home, store, cleanup } = fixture();
  try {
    for (const language of ['en', 'zh'] as const) {
      const { id } = store.createInvestigation('Review this sleep', language);
      store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', value: range.original, uncertainty: range });
      const report = store.buildReport(id);
      assert.match(report.summary, rangePattern(language));
      assert.match(report.dimensions.find(dimension => dimension.key === 'duration')!.text, rangePattern(language));
      assert.match(report.markdown, rangePattern(language));
      assert.equal(report.metrics.find(metric => metric.key === 'selfReportedSleepMinutes'), undefined);
      assert.ok(report.metrics.every(metric => metric.value !== 390));
      assert.equal(report.score, null);
      assert.ok(report.dimensions.every(dimension => dimension.score === null));
      const exported = JSON.parse(readFileSync(join(home, 'reports', `${report.id}.json`), 'utf8')) as Report;
      assert.equal(exported.summary, report.summary);
      assert.deepEqual(exported.metrics, report.metrics);
    }
  } finally { cleanup(); }
});

test('a recalled range stays separately labeled alongside a device estimate', async () => {
  const { home, store, cleanup } = fixture();
  try {
    await importRecords(home, store);
    for (const language of ['en', 'zh'] as const) {
      const { id } = store.createInvestigation('Review this sleep', language);
      store.setTarget(id, target);
      store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', value: range.original, uncertainty: range });
      const report = store.buildReport(id);
      const duration = report.dimensions.find(dimension => dimension.key === 'duration')!.text;
      assert.match(duration, language === 'zh' ? /420 分钟，来源：设备估计/ : /420 minutes \(device estimate\)/);
      assert.match(duration, rangePattern(language));
      assert.equal(report.metrics.find(metric => metric.key === 'totalSleepMinutes')?.value, 420);
      assert.equal(report.metrics.find(metric => metric.key === 'selfReportedSleepMinutes'), undefined);
      assert.ok(report.metrics.every(metric => metric.value !== 390));
    }
  } finally { cleanup(); }
});

test('unknown range metadata remains unknown and is not presented as an affirmed sleep-duration range', () => {
  const { store, cleanup } = fixture();
  try {
    for (const language of ['en', 'zh'] as const) {
      const { id } = store.createInvestigation('Review this sleep', language);
      store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', status: 'unknown', value: null, uncertainty: range });
      const report = store.buildReport(id);
      assert.doesNotMatch(report.summary, rangePattern(language));
      assert.doesNotMatch(report.dimensions.find(dimension => dimension.key === 'duration')!.text, rangePattern(language));
      assert.ok(report.limitations.some(item => language === 'zh' ? item.includes('未知') : item.includes('unknown')));
      assert.equal(report.metrics.find(metric => metric.key === 'selfReportedSleepMinutes'), undefined);
    }
  } finally { cleanup(); }
});

test('range presentation requires explicit valid hour bounds and does not infer them from prose or other scopes', () => {
  const { store, cleanup } = fixture();
  try {
    const investigation = store.createInvestigation('Review this sleep', 'en');
    const fact = store.setFact(investigation.id, { topic: 'sleep_duration_hours', scope: 'sleep', value: '6–7 hours' });
    const invalid: Fact[] = [
      fact,
      { ...fact, uncertainty: { ...range, kind: 'approximate' } },
      { ...fact, uncertainty: { ...range, unit: 'minutes' } },
      { ...fact, uncertainty: { ...range, upper: undefined } },
      { ...fact, uncertainty: { ...range, lower: -1 } },
      { ...fact, uncertainty: { ...range, lower: Number.NaN } },
      { ...fact, uncertainty: { ...range, upper: Number.POSITIVE_INFINITY } },
      { ...fact, uncertainty: { ...range, lower: 7, upper: 6 } },
      { ...fact, scope: 'profile', uncertainty: range },
    ];
    for (const input of invalid) {
      const report = reportContent(investigation, [input], analyzeRecords([]), []);
      assert.doesNotMatch(report.summary, rangePattern('en'));
      assert.doesNotMatch(report.dimensions.find(dimension => dimension.key === 'duration')!.text, rangePattern('en'));
      assert.equal(report.metrics.find(metric => metric.key === 'selfReportedSleepMinutes'), undefined);
    }
    const uncertainNumeric = reportContent(investigation, [{ ...fact, value: 6.5, uncertainty: range }], analyzeRecords([]), []);
    assert.match(uncertainNumeric.summary, rangePattern('en'));
    assert.equal(uncertainNumeric.metrics.find(metric => metric.key === 'selfReportedSleepMinutes'), undefined);
  } finally { cleanup(); }
});

test('exact numeric self-reports preserve the existing summary, duration text, and metric values', () => {
  const { store, cleanup } = fixture();
  try {
    for (const language of ['en', 'zh'] as const) {
      const { id } = store.createInvestigation('Review this sleep', language);
      store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', value: 7 });
      const report = store.buildReport(id);
      assert.equal(report.summary, language === 'zh'
        ? '本次睡眠有 420 分钟的时长记录。先结合你的恢复感和记录覆盖情况理解，暂不根据单一数字判断睡得好坏。'
        : 'This sleep has 420 recorded sleep minutes. Consider your recovery and data coverage before judging overall sleep quality.');
      assert.equal(report.dimensions.find(dimension => dimension.key === 'duration')!.text, language === 'zh'
        ? '记录的睡眠时长为 420 分钟，来源：本人自述。'
        : 'Recorded sleep duration: 420 minutes (self-report).');
      assert.deepEqual(report.metrics.find(metric => metric.key === 'selfReportedSleepMinutes'), { key: 'selfReportedSleepMinutes', value: 420, unit: 'min', source: 'self-report' });
      assert.equal(report.score, null);
    }
  } finally { cleanup(); }
});
