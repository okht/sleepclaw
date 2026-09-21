import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const app = resolve(import.meta.dirname, '..');
const source = resolve(app, '../plugins/sleepclaw');

test('desktop production runtime lock includes the new shared statistics dependency', () => {
  const names = createRequire(import.meta.url)('../scripts/runtime.cjs').dependencies as string[];
  const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(app, 'runtime-lock.json'), 'utf8'));
  const mainLock = JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, Object.fromEntries(names.map(name => [name, manifest.dependencies[name]])));
  assert.deepEqual(lock.packages['node_modules/simple-statistics'], mainLock.packages['node_modules/simple-statistics']);
});

test('built plugin runs from a relocated path with spaces under both host launch conventions', { timeout: 30000 }, async t => {
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/build-plugin.ts'], { cwd: app, windowsHide: true, stdio: 'pipe' });
  const root = mkdtempSync(join(tmpdir(), 'sleepclaw-plugin-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = join(root, 'plugin with spaces');
  cpSync(source, plugin, { recursive: true });
  const unrelated = join(root, 'unrelated cwd'); mkdirSync(unrelated);
  const config = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8')).mcpServers.sleepclaw;
  const manifest = JSON.parse(readFileSync(join(plugin, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(JSON.parse(readFileSync(join(plugin, '.claude-plugin/plugin.json'), 'utf8')).version, manifest.version);
  const licenses = JSON.parse(readFileSync(join(plugin, 'runtime/dependencies.json'), 'utf8')) as Array<{name:string;files:string[]}>;
  assert.ok(licenses.some(item => item.name === 'simple-statistics'));
  assert.ok(licenses.every(item => item.files.length > 0));
  assert.ok(!licenses.some(item => item.name.includes('pi-coding-agent') || item.name.includes('electron')));
  for (const host of ['codex', 'claude']) {
    const home = join(root, host, 'data');
    const args = config.args.map((arg: string) => host === 'claude' ? arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin) : arg);
    const transport = new StdioClientTransport({ command: process.execPath, args, cwd: host === 'codex' ? resolve(plugin, config.cwd) : unrelated, env: { SLEEPCLAW_HOME: home }, stderr: 'pipe' });
    const client = new Client({ name: `sleepclaw-${host}-packaging-test`, version: '1.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.equal(listed.tools.length, 11);
      const result = await client.callTool({ name: 'sleep_create', arguments: { goal: 'Understand my sleep', language: 'en' } });
      assert.notEqual(result.isError, true);
      const content = result.content as Array<{ type: string; text: string }>;
      assert.equal(JSON.parse(content[0].text).language, 'en');
    } finally { await client.close(); }
  }
});
