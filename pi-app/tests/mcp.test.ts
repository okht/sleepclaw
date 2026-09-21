import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { SleepStore } from '../src/domain/index.js';
import { createSleepMcpServer } from '../src/mcp.js';
import type { Fact, Investigation, Report } from '../src/shared/types.js';
import type { HealthEvidenceAnalysis } from '../src/health/evidence.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'src', 'tools-cli.ts');
const createHome = () => mkdtempSync(join(tmpdir(), 'sleepclaw-mcp-test-'));
const selected = { start: '2026-09-20T23:00:00+08:00', end: '2026-09-21T00:00:00+08:00', source: 'Synthetic Watch' };
async function call<T>(client: Client, name: string, args: Record<string, unknown>, expectedError?: string): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(Array.isArray(result.content));
  const content = result.content as Array<{ type: string; text?: string }>;
  assert.equal(content.length, 1); assert.equal(content[0].type, 'text');
  const payload = JSON.parse(content[0].text!);
  if (expectedError) { assert.equal(result.isError, true); assert.equal(payload.code, expectedError); }
  else assert.notEqual(result.isError, true, content[0].text);
  return payload as T;
}

function runCli(home: string, args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, '--home', home, ...args], {
      cwd: root, env: getDefaultEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Synthetic tools CLI timed out')); }, 15_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

test('real MCP Client and linked transports expose shared schemas and privacy-safe errors', { timeout: 20_000 }, async () => {
  const home = createHome();
  const store = new SleepStore(home);
  const server = createSleepMcpServer(store);
  const client = new Client({ name: 'sleepclaw-synthetic-tests', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const list = await client.listTools();
    for (const name of ['sleep_context', 'sleep_create', 'sleep_import', 'sleep_target', 'sleep_data_query', 'sleep_health_analysis', 'sleep_fact', 'sleep_plan', 'sleep_question', 'sleep_report', 'sleep_feedback']) {
      assert.ok(list.tools.some(item => item.name === name), name);
    }
    assert.equal(list.tools.find(item => item.name === 'sleep_health_analysis')?.annotations?.readOnlyHint, true);
    assert.equal(list.tools.find(item => item.name === 'sleep_fact')?.inputSchema.additionalProperties, false);
    await call(client, 'sleep_create', { goal: 'Synthetic' }, 'INVALID_TOOL_ARGUMENTS');
    await call(client, 'sleep_create', { goal: 'Synthetic', language: 'en', unexpected: 'synthetic-secret' }, 'INVALID_TOOL_ARGUMENTS');
    const unknown = await call<{ code: string }>(client, 'unknown_private_synthetic_tool', {}, 'UNKNOWN_TOOL');
    assert.doesNotMatch(JSON.stringify(unknown), /unknown_private_synthetic_tool/);
    const failure = await call(client, 'sleep_import', { path: join(home, 'private-synthetic-missing.xml') }, 'TOOL_FAILED');
    assert.doesNotMatch(JSON.stringify(failure), /private-synthetic|ENOENT|\.xml|C:\\/);
    assert.equal(store.snapshot().investigations.length, 0);
  } finally { await client.close(); await server.close(); store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('real stdio MCP server completes self-report and imported-data tool workflows without Pi or API keys', { timeout: 30_000 }, async () => {
  const home = createHome();
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', cli, '--home', home, 'mcp'], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'sleepclaw-stdio-tests', version: '1.0.0' });
  const protocolErrors: Error[] = [];
  client.onerror = error => { protocolErrors.push(error); };
  transport.stderr?.on('data', () => { /* SQLite diagnostics stay off protocol stdout. */ });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, 'sleepclaw');
    assert.ok((await client.listTools()).tools.length >= 11);
    const created = await call<Investigation>(client, 'sleep_create', { goal: 'Synthetic self-report first', language: 'en' });
    const investigationId = created.id;
    await call(client, 'sleep_question', { investigationId, topic: 'sleep_duration_hours', text: 'How long did you sleep?', reason: 'Keep recalled evidence separate.', scope: 'sleep' });
    const uncertainty = { kind: 'range', original: '6-7 hours', lower: 6, upper: 7, unit: 'hours' };
    const fact = await call<Fact>(client, 'sleep_fact', { investigationId, topic: 'sleep_duration_hours', value: '6-7 hours', uncertainty, scope: 'sleep' });
    assert.equal(fact.value, '6-7 hours');
    await call(client, 'sleep_fact', { investigationId, topic: 'sleep_duration_hours', value: 6.5, uncertainty, scope: 'sleep' }, 'INVALID_FACT_UNCERTAINTY');
    const context = await call<{ investigation: Investigation }>(client, 'sleep_context', { investigationId });
    await call(client, 'sleep_plan', { investigationId, objective: 'Summarize available recollection', revision: context.investigation.revision, steps: [{ id: 'report', kind: 'report', description: 'Keep uncertain duration explicit', status: 'pending' }] });
    const selfReport = await call<Report>(client, 'sleep_report', { investigationId, interpretation: '', action: '' });
    assert.equal(selfReport.metrics.find(item => item.key === 'selfReportedSleepMinutes'), undefined);
    assert.equal(selfReport.metrics.find(item => item.key === 'totalSleepMinutes')?.value, null);
    await call(client, 'sleep_feedback', { investigationId, reportId: selfReport.id, choice: 'later', note: 'Synthetic recollection only' });

    const path = join(home, 'synthetic-export.xml');
    writeFileSync(path, '<HealthData>' +
      '<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Synthetic Watch" startDate="2026-09-20 23:00:00 +0800" endDate="2026-09-20 23:20:00 +0800" value="HKCategoryValueSleepAnalysisAsleepCore"/>' +
      [54, 58, 62].map((value, i) => `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Synthetic Watch" startDate="2026-09-20 23:${String(i * 10).padStart(2, '0')}:00 +0800" endDate="2026-09-20 23:${String(i * 10).padStart(2, '0')}:00 +0800" value="${value}" unit="count/min"/>`).join('') + '</HealthData>');
    await call(client, 'sleep_import', { path });
    const duplicate = await call<{ duplicateCount: number }>(client, 'sleep_import', { path });
    assert.equal(duplicate.duplicateCount, 4);
    await call(client, 'sleep_target', { investigationId, ...selected, start: '2026-09-20T23:00:00' }, 'TIMEZONE_REQUIRED');
    await call(client, 'sleep_target', { investigationId, ...selected });
    await call(client, 'sleep_health_analysis', { investigationId, end: '2026-09-21T00:01:00+08:00' }, 'INVALID_QUERY_RANGE');
    const evidence = await call<HealthEvidenceAnalysis>(client, 'sleep_health_analysis', { investigationId });
    assert.equal(evidence.physiology.find(item => item.type === 'heartRate')?.median, 58);
    assert.equal(evidence.physiology.find(item => item.type === 'hrv')?.median, null);
    assert.equal(evidence.sleep.unobservedMinutes, 40);
    assert.equal(evidence.sleep.observedAwakeMinutes, null);
    const query = await call<{ observations: unknown[]; truncated: boolean }>(client, 'sleep_data_query', { investigationId, type: 'heartRate' });
    assert.equal(query.observations.length, 3); assert.equal(query.truncated, false);
    const report = await call<Report>(client, 'sleep_report', { investigationId, interpretation: '', action: '' });
    assert.equal(report.revision, selfReport.revision + 1);
    const unrelated = await call<Investigation>(client, 'sleep_create', { goal: 'Separate investigation', language: 'en' });
    await call(client, 'sleep_feedback', { investigationId: unrelated.id, reportId: report.id, choice: 'cannot' }, 'REPORT_NOT_FOUND');
    await call(client, 'sleep_feedback', { investigationId, reportId: report.id, choice: 'accepted' });
    const resumed = await call<{ feedback: Array<{ reportId: string }> }>(client, 'sleep_context', { investigationId });
    assert.ok(resumed.feedback.some(item => item.reportId === report.id));
    assert.deepEqual(protocolErrors, [], 'every stdout message must parse as MCP JSON-RPC');
  } finally { await client.close(); await transport.close(); rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('closing a real SDK connection during import waits for rollback before SQLite can close', { timeout: 20_000 }, async () => {
  const home = createHome();
  const store = new SleepStore(home);
  const server = createSleepMcpServer(store);
  const client = new Client({ name: 'sleepclaw-cancel-tests', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serverErrors: Error[] = [];
  server.onerror = error => { serverErrors.push(error); };
  let markEntered!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  let progressCount = 0;
  let firstProgress = true;
  const originalImport = store.importFile.bind(store);
  // Observe the real import's synchronous progress; do not replace records or its transaction result.
  store.importFile = (path, options = {}) => originalImport(path, {
    ...options,
    onProgress: count => {
      options.onProgress?.(count);
      progressCount = count;
      if (firstProgress) { firstProgress = false; markEntered(); }
    },
  });
  try {
    const investigation = store.createInvestigation('Keep my existing facts', 'en');
    const originalFact = store.setFact(investigation.id, { topic: 'recovery', value: 'Synthetic existing fact', scope: 'sleep' });
    const path = join(home, 'synthetic-interrupted.xml');
    const xml = '<HealthData>' + Array.from({ length: 4000 }, (_, index) => {
      const timestamp = new Date(Date.UTC(2026, 8, 20, 23) + index * 1000).toISOString();
      return `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Synthetic Watch" startDate="${timestamp}" endDate="${timestamp}" value="60" unit="count/min"/>`;
    }).join('') + '</HealthData>';
    assert.ok(Buffer.byteLength(xml) < 2 * 1024 * 1024);
    writeFileSync(path, xml);
    await server.connect(serverTransport); await client.connect(clientTransport);
    // Attach the expected close rejection before triggering transport shutdown.
    const outcome = client.callTool({ name: 'sleep_import', arguments: { path } }).then(
      result => ({ result, error: undefined }), error => ({ result: undefined, error }),
    );
    await entered;
    assert.equal(progressCount, 1000, 'shutdown starts after real records have entered the transaction');
    const idle = server.whenIdle();
    let idleResolved = false;
    void idle.then(() => { idleResolved = true; });
    await Promise.resolve();
    assert.equal(idleResolved, false, 'active import must keep whenIdle pending');
    await client.close();
    await idle;
    const completed = await outcome;
    assert.match(String(completed.error), /Connection closed/i);
    assert.ok(progressCount < 4000, 'the original import never reached completion');
    assert.deepEqual(store.snapshot(investigation.id).imports, []);
    assert.deepEqual(store.getRecords(), []);
    assert.equal(store.snapshot(investigation.id).facts.find(fact => fact.id === originalFact.id)?.value, originalFact.value);
    store.setFact(investigation.id, { topic: 'noise', value: 'A new fact after rollback', scope: 'sleep' });
    const retry = await store.importFile(path);
    assert.equal(retry.recordCount, 4000);
    assert.equal(retry.duplicateCount, 0, 'cancelled rows must have rolled back, including global deduplication rows');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(serverErrors, []);
  } finally {
    await client.close(); await server.close(); await server.whenIdle();
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('source CLI list/call/stdin produce exactly one JSON value and safe failures', { timeout: 30_000 }, async () => {
  const home = createHome();
  try {
    const list = await runCli(home, ['list']);
    assert.equal(list.code, 0); assert.equal(list.stdout.trim().split('\n').length, 1);
    assert.ok(JSON.parse(list.stdout).some((item: { name: string }) => item.name === 'sleep_health_analysis'));
    const created = await runCli(home, ['call', 'sleep_create', '--stdin'], JSON.stringify({ goal: 'CLI synthetic report', language: 'en' }));
    assert.equal(created.code, 0);
    const investigationId = JSON.parse(created.stdout).id;
    const report = await runCli(home, ['call', 'sleep_report', JSON.stringify({ investigationId, interpretation: '', action: '' })]);
    assert.equal(report.code, 0); assert.equal(JSON.parse(report.stdout).revision, 1);
    for (const args of [['call', 'unknown_tool', '{}'], ['call', 'sleep_create', '{invalid'], ['call', 'sleep_create', '{}']]) {
      const result = await runCli(home, args);
      assert.equal(result.code, 1); assert.equal(result.stdout.trim().split('\n').length, 1);
      assert.ok(['UNKNOWN_TOOL', 'INVALID_TOOL_ARGUMENTS'].includes(JSON.parse(result.stdout).error.code));
    }
    const tooLarge = await runCli(home, ['call', 'sleep_create', '--stdin'], 'x'.repeat(65537));
    assert.equal(tooLarge.code, 1); assert.equal(JSON.parse(tooLarge.stdout).error.code, 'INVALID_TOOL_ARGUMENTS');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('raw MCP startup stdout contains only JSON-RPC frames, never CLI banners or SQLite logs', { timeout: 20_000 }, async () => {
  const home = createHome();
  try {
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw-synthetic-check', version: '1.0.0' } } };
    const result = await runCli(home, ['mcp'], JSON.stringify(initialize) + '\n');
    assert.equal(result.code, 0);
    const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(frames.length > 0);
    assert.ok(frames.every(frame => frame.jsonrpc === '2.0'));
    assert.equal(frames.find(frame => frame.id === 1)?.result.serverInfo.name, 'sleepclaw');
    assert.doesNotMatch(result.stdout, /ExperimentalWarning|SQLite is an experimental|SleepClaw tools \(Node/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
