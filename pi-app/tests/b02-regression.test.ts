import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SleepStore } from '../src/domain/index.js';

test('B02: switching nights isolates recollections, retains profile and restores original facts on return', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-b02-'));
  const store = new SleepStore(home);
  try {
    const first = { start: '2026-09-20T23:00:00+08:00', end: '2026-09-21T07:00:00+08:00', source: 'Synthetic Watch' };
    const second = { ...first, start: '2026-09-21T23:00:00+08:00', end: '2026-09-22T07:00:00+08:00' };
    const path = join(home, 'synthetic.xml');
    writeFileSync(path, `<HealthData>${[first, second].map(t => `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Synthetic Watch" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="${t.start}" endDate="${t.end}"/>`).join('')}</HealthData>`);
    await store.importFile(path);
    const inv = store.createInvestigation('合成案例：更换分析夜晚', 'zh');
    const profile = store.setFact(inv.id, { scope: 'profile', topic: 'usual_schedule', value: '23:00–07:00' });
    store.setTarget(inv.id, first);
    const duration = store.setFact(inv.id, { scope: 'sleep', topic: 'sleep_duration_hours', value: 7 });
    const recovery = store.setFact(inv.id, { scope: 'sleep', topic: 'recovery', value: '9月21日醒来头痛 B02_OLD_NIGHT' });
    const original = store.buildReport(inv.id);
    store.setTarget(inv.id, second);
    const report = store.buildReport(inv.id);
    assert.equal(report.metrics.find(m => m.key === 'totalSleepMinutes')?.value, 480);
    assert.equal(report.metrics.find(m => m.key === 'selfReportedSleepMinutes'), undefined);
    assert.ok(!report.markdown.includes('B02_OLD_NIGHT'));
    assert.deepEqual(store.snapshot(inv.id).facts, [JSON.parse(JSON.stringify(profile))]);
    assert.equal(store.snapshot(inv.id).reports.find(r => r.id === original.id)?.status, 'stale');
    const exported = JSON.parse(readFileSync(join(home, 'reports', `${report.id}.json`), 'utf8'));
    assert.ok(!JSON.stringify(exported).includes('B02_OLD_NIGHT'));
    store.setFact(inv.id, { scope: 'sleep', topic: 'sleep_duration_hours', value: 8 });
    store.setTarget(inv.id, first);
    assert.deepEqual(store.snapshot(inv.id).facts.filter(f => f.scope === 'sleep'), [duration, recovery]);
    assert.equal(store.buildReport(inv.id).metrics.find(m => m.key === 'selfReportedSleepMinutes')?.value, 420);
    store.setTarget(inv.id, second);
    assert.equal(store.snapshot(inv.id).facts.find(f => f.topic === 'sleep_duration_hours')?.value, 8);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});
