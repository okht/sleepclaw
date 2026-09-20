import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { analyzeRecords, identifyCandidates, importAppleHealth } from '../src/health/index.js';
import type { HealthRecord } from '../src/shared/types.js';

const sleepType = 'HKCategoryTypeIdentifierSleepAnalysis';
const stage = (name: string) => `HKCategoryValueSleepAnalysis${name}`;
const record = (value: string, start = '2026-09-20 23:00:00 +0800', end = '2026-09-21 07:00:00 +0800', source = 'Watch') => `<Record type="${sleepType}" value="${stage(value)}" sourceName="${source}" startDate="${start}" endDate="${end}"/>`;
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE HealthData [<!ELEMENT HealthData (Record*)><!ATTLIST HealthData locale CDATA #IMPLIED><!ELEMENT Record EMPTY>]><HealthData locale="zh_CN">${body}</HealthData>`;

async function withFile(content: string | Buffer, extension: string, run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'sleepclaw-health-test-'));
  try { const path = join(directory, `导出.${extension}`); await writeFile(path, content); await run(path); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Tiny synthetic ZIP builder; no real health exports and no extra test dependency. */
function zip(entries: Array<[string, string]>): Buffer {
  const files: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of entries) {
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    files.push(local, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(data), 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + compressed.length;
  }
  const end = Buffer.alloc(22);
  const directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}

const metric = (records: HealthRecord[], key: string, options = {}) => analyzeRecords(records, options).metrics.find((m) => m.key === key)?.value;

test('XML import preserves Chinese sources and offsets, skips unrelated data, and deduplicates', async () => {
  const body = record('AsleepCore', undefined, undefined, '我的手表') + record('AsleepCore', undefined, undefined, '我的手表') + '<Record type="HKQuantityTypeIdentifierStepCount" value="bad"/>';
  await withFile(xml(body), 'xml', async (path) => {
    const result = await importAppleHealth(path);
    assert.equal(result.records.length, 1);
    assert.equal(result.summary.duplicateCount, 1);
    assert.equal(result.records[0].start, '2026-09-20T23:00:00.000+08:00');
    assert.equal(result.records[0].startOffset, '+08:00');
    assert.deepEqual(result.summary.sources, ['我的手表']);
    assert.equal(metric(result.records, 'totalSleepMinutes'), 480);
    assert.equal((await importAppleHealth(path)).records[0].id, result.records[0].id);
  });
});

test('ZIP reads only export.xml; callback mode avoids accumulated records', async () => {
  const body = xml(record('AsleepREM'));
  await withFile(zip([['apple_health_export/export.xml', body], ['apple_health_export/export_cda.xml', '<private/>']]), 'zip', async (path) => {
    const seen: HealthRecord[] = [];
    const progress: number[] = [];
    const result = await importAppleHealth(path, { onRecord: (r) => seen.push(r), onProgress: (n) => progress.push(n) });
    assert.equal(seen.length, 1);
    assert.deepEqual(result.records, []);
    assert.equal(result.summary.recordCount, 1);
    assert.deepEqual(progress, [1]);
  });
});

test('multi-chunk import streams records and emits bounded progress updates', async () => {
  const body = Array.from({ length: 1005 }, (_, index) => {
    const time = new Date(Date.parse('2026-09-20T23:00:00+08:00') + index * 1000).toISOString();
    return `<Record type="HKQuantityTypeIdentifierHeartRate" value="60" unit="count/min" sourceName="我的手表" startDate="${time}" endDate="${time}"/>`;
  }).join('');
  await withFile(xml(body), 'xml', async (path) => {
    let count = 0;
    const progress: number[] = [];
    const result = await importAppleHealth(path, { onRecord: () => { count++; }, onProgress: (n) => progress.push(n) });
    assert.equal(count, 1005);
    assert.equal(result.summary.recordCount, 1005);
    assert.deepEqual(result.records, []);
    assert.deepEqual(progress, [1000, 1005]);
  });
});

test('ZIP rejects missing, duplicate or path-escaping export entries', async () => {
  const cases: Array<[Array<[string, string]>, RegExp]> = [
    [[['other.xml', xml('')]], /没有找到/],
    [[['export.xml', xml('')], ['other/export.xml', xml('')]], /多个 export/],
    [[['../export.xml', xml('')]], /invalid relative path/],
  ];
  for (const [entries, error] of cases) await withFile(zip(entries), 'zip', async (path) => { await assert.rejects(importAppleHealth(path), error); });
});

test('ZIP CRC mismatch rejects damaged archives', async () => {
  const content = zip([['export.xml', xml(record('AsleepCore'))]]);
  const central = content.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  content.writeUInt32LE(123, central + 16);
  await withFile(content, 'zip', async (path) => { await assert.rejects(importAppleHealth(path), /校验失败/); });
});

test('unknown sleep stages, invalid dates, malformed XML, wrong root and external entities fail closed', async () => {
  const cases = [
    xml(record('FutureStage')),
    xml(record('AsleepCore', '2026-02-30 23:00:00 +0800')),
    '<HealthData><Record></HealthData>',
    '<Other/>',
    '<!DOCTYPE HealthData SYSTEM "https://example.invalid/external"><HealthData/>',
    '<!DOCTYPE HealthData [<!ENTITY leak SYSTEM "file:///private">]><HealthData/>',
  ];
  for (const content of cases) await withFile(content, 'xml', async (path) => { await assert.rejects(importAppleHealth(path)); });
});

test('cancellation works before import and during a callback', async () => {
  await withFile(xml(record('AsleepCore') + record('AsleepREM')), 'xml', async (path) => {
    const before = new AbortController(); before.abort();
    await assert.rejects(importAppleHealth(path, { signal: before.signal }), { name: 'AbortError' });
    const during = new AbortController(); let count = 0;
    await assert.rejects(importAppleHealth(path, { signal: during.signal, onRecord: () => { count++; during.abort(); } }), { name: 'AbortError' });
    assert.equal(count, 1);
  });
});

test('resource bounds reject excess bytes, records, ZIP entries and compression ratio', async () => {
  await withFile(xml(record('AsleepCore') + record('AsleepREM')), 'xml', async (path) => {
    await assert.rejects(importAppleHealth(path, { limits: { maxXmlBytes: 10 } }), /大小上限/);
    await assert.rejects(importAppleHealth(path, { limits: { maxRecords: 1 } }), /数量/);
  });
  await withFile(zip([['export.xml', xml(record('AsleepCore'))], ['other.txt', 'x']]), 'zip', async (path) => {
    await assert.rejects(importAppleHealth(path, { limits: { maxZipEntries: 1 } }), /条目过多/);
    await assert.rejects(importAppleHealth(path, { limits: { maxCompressionRatio: 1 } }), /压缩比例/);
  });
});

test('union prevents inBed/general asleep/staged records from triple counting', async () => {
  const body = record('InBed') + record('Asleep') + record('AsleepCore', '2026-09-20 23:00:00 +0800', '2026-09-21 03:00:00 +0800') + record('AsleepREM', '2026-09-21 03:00:00 +0800', '2026-09-21 07:00:00 +0800');
  await withFile(xml(body), 'xml', async (path) => {
    const { records } = await importAppleHealth(path);
    assert.equal(metric(records, 'totalSleepMinutes'), 480);
    assert.equal(metric(records, 'inBedMinutes'), 480);
    assert.equal(metric(records, 'sleepEfficiencyPercent'), 100);
    assert.equal(metric(records, 'awakeMinutes'), null);
    assert.deepEqual(analyzeRecords(records).stages, { core: 240, rem: 240 });
  });
});

test('missing stages or bedtime remain unknown, and overlapping stages are not double counted', async () => {
  await withFile(xml(record('AsleepCore') + record('AsleepDeep')), 'xml', async (path) => {
    const { records } = await importAppleHealth(path);
    const analysis = analyzeRecords(records);
    assert.equal(metric(records, 'totalSleepMinutes'), 480);
    assert.equal(metric(records, 'awakeMinutes'), null);
    assert.equal(metric(records, 'inBedMinutes'), null);
    assert.equal(metric(records, 'sleepEfficiencyPercent'), null);
    assert.deepEqual(analysis.stages, { unknown: 480 });
    assert.ok(analysis.warnings.some((warning) => warning.includes('阶段互相冲突')));
  });
});

test('mixed sleep sources require selection and selected range clips intervals', async () => {
  await withFile(xml(record('AsleepCore', undefined, undefined, 'A') + record('AsleepCore', undefined, undefined, 'B')), 'xml', async (path) => {
    const { records } = await importAppleHealth(path);
    assert.equal(metric(records, 'totalSleepMinutes'), null);
    assert.equal(metric(records, 'totalSleepMinutes', { source: 'A', start: '2026-09-21T00:00:00+08:00', end: '2026-09-21T01:00:00+08:00' }), 60);
    assert.equal(identifyCandidates(records).length, 2);
  });
});

test('candidates retain short interruptions and split a later nap; DST uses elapsed time', async () => {
  const body = record('AsleepCore', '2026-11-01 00:00:00 -0400', '2026-11-01 04:00:00 -0500') + record('AsleepCore', '2026-11-01 04:30:00 -0500', '2026-11-01 06:00:00 -0500') + record('AsleepCore', '2026-11-01 14:00:00 -0500', '2026-11-01 14:30:00 -0500');
  await withFile(xml(body), 'xml', async (path) => {
    const { records } = await importAppleHealth(path);
    const candidates = identifyCandidates(records);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].asleepMinutes, 30);
    assert.equal(candidates[1].asleepMinutes, 390);
    assert.equal(candidates[1].start, '2026-11-01T04:00:00.000Z');
  });
});

test('empty imports and unsupported physiological units do not generate zeros', async () => {
  await withFile(xml(''), 'xml', async (path) => {
    const { records, summary } = await importAppleHealth(path);
    assert.equal(summary.recordCount, 0);
    assert.ok(summary.warnings.length > 0);
    assert.ok(analyzeRecords(records).metrics.every((metric) => metric.value === null));
  });
  const body = '<Record type="HKQuantityTypeIdentifierHeartRate" value="60" unit="count/min" sourceName="Watch" startDate="2026-09-20 23:00:00 +0800" endDate="2026-09-20 23:00:00 +0800"/>';
  await withFile(xml(body), 'xml', async (path) => {
    const { records } = await importAppleHealth(path);
    assert.equal(metric(records, 'heartRateMean'), 60);
    assert.equal(metric(records, 'hrvMean'), null);
    assert.equal(metric([{ ...records[0], unit: 'unknown' }], 'heartRateMean'), null);
  });
});

test('oxygen saturation converts HealthKit fractions, and excludes incompatible values', async () => {
  const body = '<Record type="HKQuantityTypeIdentifierOxygenSaturation" value="0.97" unit="%" sourceName="Watch" startDate="2026-09-20 23:00:00 +0800" endDate="2026-09-20 23:00:00 +0800"/>';
  await withFile(xml(body), 'xml', async (path) => {
    const { records } = await importAppleHealth(path);
    assert.equal(records[0].value, 0.97);
    assert.equal(metric(records, 'oxygenSaturationMean'), 97);
    assert.equal(metric([{ ...records[0], value: 97 }], 'oxygenSaturationMean'), null);
  });
});

test('sleep touching a window boundary does not create a false source conflict', async () => {
  const body = record('AsleepCore', '2026-09-20 22:00:00 +0800', '2026-09-20 23:00:00 +0800', 'A') + record('AsleepCore', undefined, undefined, 'B');
  await withFile(xml(body), 'xml', async (path) => {
    const { records } = await importAppleHealth(path);
    assert.equal(metric(records, 'totalSleepMinutes', { start: '2026-09-20T23:00:00+08:00', end: '2026-09-21T07:00:00+08:00' }), 480);
  });
});
