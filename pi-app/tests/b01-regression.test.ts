import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SleepApp } from '../src/controller.js';

test('B01: import -> choose candidate -> report retains both awake edges and full time in bed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-b01-regression-'));
  const app = new SleepApp(home);
  try {
    const path = join(home, 'synthetic.xml');
    const record = (stage: string, start: string, end: string) => `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Synthetic Watch" value="HKCategoryValueSleepAnalysis${stage}" startDate="${start} +0800" endDate="${end} +0800"/>`;
    writeFileSync(path, `<HealthData>${[
      record('InBed', '2026-09-20 22:00:00', '2026-09-21 07:00:00'),
      record('Awake', '2026-09-20 22:00:00', '2026-09-20 23:00:00'),
      record('AsleepCore', '2026-09-20 23:00:00', '2026-09-21 06:30:00'),
      record('Awake', '2026-09-21 06:30:00', '2026-09-21 07:00:00'),
    ].join('')}</HealthData>`);
    await app.request('new', { goal: '合成 B01：分析完整的一晚' });
    const imported = await app.request('import', { path });
    assert.equal(imported.candidates.length, 1);
    const candidate = imported.candidates[0];
    await app.request('target', { start: candidate.start, end: candidate.end, source: candidate.source, scope: 'main' });
    const state = await app.request('report');
    const report = state.reports.find(r => r.investigationId === state.active?.id)!;
    assert.deepEqual(Object.fromEntries(report.metrics.filter(m => ['totalSleepMinutes', 'inBedMinutes', 'awakeMinutes', 'sleepEfficiencyPercent'].includes(m.key)).map(m => [m.key, m.value])), {
      totalSleepMinutes: 450, awakeMinutes: 90, inBedMinutes: 540, sleepEfficiencyPercent: 83.33,
    });
    assert.equal(Date.parse(candidate.start), Date.parse('2026-09-20T22:00:00+08:00'));
    assert.equal(Date.parse(candidate.end), Date.parse('2026-09-21T07:00:00+08:00'));
    assert.equal(candidate.asleepMinutes, 450);
    assert.equal(Date.parse(report.basis!.start!), Date.parse(candidate.start));
    assert.equal(Date.parse(report.basis!.end!), Date.parse(candidate.end));
  } finally { await app.close(); rmSync(home, { recursive: true, force: true }); }
});
