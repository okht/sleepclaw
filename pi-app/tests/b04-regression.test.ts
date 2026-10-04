import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SleepApp } from '../src/controller';

test('B04 offline early report survives reopen and resumes the unanswered question without invalidating the report', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-b04-original-'));
  let app = new SleepApp(home);
  try {
    await app.request('new', { goal: '合成案例：先看简报，再继续补充' });
    const before = await app.request('answer', { value: '30–39' });
    assert.equal(before.question?.topic, 'usual_schedule');
    const reported = await app.request('report');
    const report = reported.reports[0];
    const path = join(home, 'reports', `${report.id}.json`);
    const exported = readFileSync(path, 'utf8');
    assert.equal(reported.question, undefined, 'a direct report request stops active questioning');
    await app.close();
    app = new SleepApp(home);
    const resumed = await app.request('resume');
    assert.deepEqual(resumed.question, before.question, 'resume retains the actual unanswered question');
    assert.equal(resumed.active?.revision, before.active?.revision);
    assert.deepEqual(resumed.reports, reported.reports);
    assert.equal(readFileSync(path, 'utf8'), exported);
    const continued = await app.request('answer', { value: '23:00–07:00' });
    assert.equal(continued.question?.topic, 'sleep_duration_hours');
    assert.equal(continued.reports[0].status, 'stale');
    await app.request('answer', { value: '7' });
    const updated = await app.request('report');
    assert.equal(updated.reports[0].metrics.find(metric => metric.key === 'selfReportedSleepMinutes')?.value, 420);
  } finally { await app.close(); rmSync(home, { recursive: true, force: true }); }
});
