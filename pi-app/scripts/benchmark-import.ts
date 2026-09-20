import assert from 'node:assert/strict';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { SleepStore } from '../src/domain/index.js';

// All generated data stays in this app's ignored smoke directory. No cleanup is automatic.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smokeRoot = resolve(appRoot, '.smoke');
function insideSmoke(path: string): string {
  const absolute = resolve(path);
  const child = relative(smokeRoot, absolute);
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'Benchmark path must be inside pi-app/.smoke');
  return absolute;
}
mkdirSync(smokeRoot, { recursive: true });
const runDirectory = insideSmoke(mkdtempSync(join(smokeRoot, 'import-benchmark-')));
const sourcePath = insideSmoke(join(runDirectory, 'synthetic-export.xml'));
const home = insideSmoke(join(runDirectory, 'synthetic-home'));
const databasePath = insideSmoke(join(home, 'sleepclaw.sqlite'));
const resultPath = insideSmoke(join(runDirectory, 'result.json'));
const recordCount = 50_000;
const sourceName = 'SleepClaw Synthetic Benchmark';
const initialTime = Date.parse('2026-01-01T00:00:00Z');
const recordDefinitions = [
  { type: 'HKCategoryTypeIdentifierSleepAnalysis', value: 'HKCategoryValueSleepAnalysisAsleepCore', unit: undefined },
  { type: 'HKQuantityTypeIdentifierHeartRate', value: '62', unit: 'count/min' },
  { type: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', value: '42', unit: 'ms' },
  { type: 'HKQuantityTypeIdentifierRespiratoryRate', value: '15', unit: 'count/min' },
  { type: 'HKQuantityTypeIdentifierOxygenSaturation', value: '0.97', unit: '%' },
];

function* syntheticXml(): Generator<string> {
  yield '<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n';
  for (let index = 0; index < recordCount; index += 1) {
    const definition = recordDefinitions[index % recordDefinitions.length];
    const start = initialTime + index * 60_000;
    const end = start + (index % recordDefinitions.length === 0 ? 5 * 60_000 : 0);
    const unit = definition.unit ? ` unit="${definition.unit}"` : '';
    yield `<Record type="${definition.type}" sourceName="${sourceName}"${unit} startDate="${new Date(start).toISOString()}" endDate="${new Date(end).toISOString()}" value="${definition.value}"/>\n`;
  }
  yield '</HealthData>\n';
}

function databaseSizes() {
  const size = (path: string) => existsSync(path) ? statSync(path).size : 0;
  const mainBytes = size(databasePath);
  const walBytes = size(`${databasePath}-wal`);
  const sharedMemoryBytes = size(`${databasePath}-shm`);
  return { mainBytes, walBytes, sharedMemoryBytes, totalBytes: mainBytes + walBytes + sharedMemoryBytes };
}

function databaseCounts() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = (table: 'health_records' | 'imports' | 'import_records') => Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
    return { healthRecords: count('health_records'), imports: count('imports'), provenanceLinks: count('import_records') };
  } finally { database.close(); }
}

const generationStart = performance.now();
await pipeline(Readable.from(syntheticXml()), createWriteStream(sourcePath, { flags: 'wx' }));
const generationMilliseconds = performance.now() - generationStart;
const store = new SleepStore(home);

async function measureImport(pass: number) {
  const baselineRssBytes = process.memoryUsage().rss;
  let sampledPeakRssBytes = baselineRssBytes;
  const sample = () => { sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss); };
  const interval = setInterval(sample, 20);
  const started = performance.now();
  try {
    const summary = await store.importFile(sourcePath, { onProgress: sample });
    const elapsedMilliseconds = performance.now() - started;
    sample();
    assert.equal(summary.recordCount, recordCount);
    assert.equal(summary.duplicateCount, pass === 1 ? 0 : recordCount);
    const counts = databaseCounts();
    assert.equal(counts.healthRecords, recordCount);
    assert.equal(counts.imports, pass);
    assert.equal(counts.provenanceLinks, recordCount * pass);
    return {
      pass,
      elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(2)),
      baselineRssBytes,
      sampledPeakRssBytes,
      processLifetimePeakRssBytes: process.resourceUsage().maxRSS * 1024,
      endRssBytes: process.memoryUsage().rss,
      parsedRecordCount: summary.recordCount,
      duplicateCount: summary.duplicateCount,
      insertedHealthRecords: summary.recordCount - summary.duplicateCount,
      databaseCounts: counts,
      databaseWhileOpen: databaseSizes(),
      warnings: summary.warnings,
    };
  } finally { clearInterval(interval); }
}

try {
  const firstImport = await measureImport(1);
  const repeatedImport = await measureImport(2);
  store.close();
  const result = {
    benchmark: 'synthetic-apple-health-xml-import',
    completedAt: new Date().toISOString(),
    environment: { node: process.version, platform: platform(), osRelease: release(), cpu: cpus()[0]?.model, logicalCpuCount: cpus().length },
    scope: '50,000 synthetic records in an uncompressed XML; no real user data, no ZIP extraction, no model calls',
    recordCount,
    recordMix: Object.fromEntries(recordDefinitions.map(({ type }) => [type, recordCount / recordDefinitions.length])),
    sourceBytes: statSync(sourcePath).size,
    generationMilliseconds: Number(generationMilliseconds.toFixed(2)),
    generationMethod: 'Generator streamed through pipeline with backpressure; no full XML string or record array',
    imports: [firstImport, repeatedImport],
    databaseAfterClose: databaseSizes(),
    processLifetimePeakRssBytes: process.resourceUsage().maxRSS * 1024,
    measurementNotes: [
      'Lifetime peak RSS includes Node/tsx/module loading, XML generation, both imports, and SQL counting; it is not isolated importer overhead.',
      'Per-import sampled RSS is observed every 20 ms and at importer progress callbacks; it may miss shorter peaks.',
      'Repeat import deduplicates health records but stores a second import manifest and provenance links, so disk use can grow.',
      'SQLite sizes include its WAL and shared-memory files while open, plus the database after close/checkpoint.',
      'This synthetic XML measurement does not establish performance for large real Apple Health ZIP archives or other computers.',
    ],
    artifacts: { runDirectory, sourcePath, databasePath, resultPath },
  };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  try { store.close(); } catch { /* Already closed or original import failed. */ }
  throw error;
}
