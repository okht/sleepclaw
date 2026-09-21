import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SleepStore } from './domain/index.js';
import { createSleepTools, safeToolError } from './tools.js';
import { serveStdio } from './mcp.js';

async function main() {
  const args = process.argv.slice(2);
  const homeAt = args.indexOf('--home');
  const homeValue = homeAt >= 0 ? args[homeAt + 1] : process.env.SLEEPCLAW_HOME;
  if (homeAt >= 0) { if (!homeValue || homeValue.startsWith('--')) throw new Error('INVALID_TOOL_ARGUMENTS'); args.splice(homeAt, 2); }
  const home = resolve(homeValue ?? join(homedir(), '.sleepclaw-tools'));
  if (args[0] === 'mcp' && args.length === 1) { await serveStdio(home); return; }
  if (args[0] === '--help' || !args.length) {
    process.stdout.write('SleepClaw tools (Node >=24.13)\n  tools --home <directory> list\n  tools --home <directory> call <tool-name> <JSON>\n  tools --home <directory> call <tool-name> --stdin\n  tools --home <directory> mcp\nDefault store: ~/.sleepclaw-tools, independent from the desktop.\n');
    return;
  }
  const store = new SleepStore(home);
  try {
    const tools = createSleepTools(store);
    if (args[0] === 'list' && args.length === 1) {
      process.stdout.write(JSON.stringify(tools.map(({ name, description, parameters, readOnly }) => ({ name, description, inputSchema: parameters, readOnly }))) + '\n');
      return;
    }
    if (args[0] !== 'call' || args.length !== 3) throw new Error('INVALID_TOOL_ARGUMENTS');
    const tool = tools.find(tool => tool.name === args[1]);
    if (!tool) throw new Error('UNKNOWN_TOOL');
    let json = args[2];
    if (json === '--stdin') {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of process.stdin) { const buffer = Buffer.from(chunk); length += buffer.length; if (length > 65536) throw new Error('INVALID_TOOL_ARGUMENTS'); chunks.push(buffer); }
      json = Buffer.concat(chunks).toString('utf8');
    }
    if (Buffer.byteLength(json) > 65536) throw new Error('INVALID_TOOL_ARGUMENTS');
    let params: unknown;
    try { params = JSON.parse(json); } catch { throw new Error('INVALID_TOOL_ARGUMENTS'); }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    try { process.stdout.write(JSON.stringify(await tool.execute(params, controller.signal)) + '\n'); }
    finally { process.removeListener('SIGINT', cancel); }
  } finally { store.close(); }
}

void main().catch(error => {
  // MCP stdout is reserved for the protocol, including during startup failure.
  const out = process.argv.includes('mcp') ? process.stderr : process.stdout;
  out.write(JSON.stringify({ error: safeToolError(error) }) + '\n');
  process.exitCode = 1;
});
