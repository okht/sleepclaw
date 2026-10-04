import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { chatMessages, makeSession, openChatSession, recordChatAction, recordPromptPresentation, type ChatAction } from '../src/agent.js';
import type { Language } from '../src/shared/types.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-ux-chat-'));
  const cwd = join(home, 'workspace');
  const dir = join(home, 'sessions', 'synthetic-first-episode');
  return { home, cwd, dir, open: () => openChatSession(cwd, dir), cleanup() {
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); rmSync(home, { recursive: true, force: true });
  } };
}
function display(manager: SessionManager) {
  return chatMessages({ messages: manager.buildSessionContext().messages, sessionManager: manager });
}
function user(manager: SessionManager, text: string) { manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() }); }
const context = (language: Language = 'zh') => JSON.stringify({ language, investigation: { id: 'synthetic-episode', language }, facts: [], hidden: 'SYNTHETIC_INTERNAL_CONTEXT' });
const wrap = (text: string, language: Language = 'zh') => `${text}\n<sleepclaw-current-context>${context(language)}</sleepclaw-current-context>`;
const reportInstruction = 'The user requests the report now. Stop asking questions. Use sleep_report to generate the report using the current facts and bounded data, with limitations and one practical action.';
const retryInstruction = 'The previous answer is already saved in the current facts. Retry only the interrupted follow-up. Read the current context; do not save or replay the old answer again. Ask exactly one useful next question, or show the pending fixed question.';
const answerInstruction = (answer: string) => `The user answered the saved question recovery: ${answer}. The literal answer is saved. Extract additional explicitly stated facts if any; inspect relevant data if useful, then ask exactly one useful next question or show the next fixed question.`;

for (const language of ['zh', 'en'] as const) test(`UX ${language}: offline operations persist before any assistant exists and never become model instructions`, () => {
  const f = fixture();
  try {
    const manager = f.open();
    const operations: ChatAction[] = [
      { kind: 'answer', text: 'Synthetic 6～7 小时', language }, { kind: 'answer', text: '不知道 / not sure', language },
      { kind: 'answer', language }, { kind: 'skip', language }, { kind: 'report', language },
      { kind: 'report-local', language }, { kind: 'retry', language },
    ];
    operations.forEach(action => recordChatAction(manager, action));
    const shown = display(manager);
    assert.equal(shown.length, operations.length);
    assert.equal(shown[0].text, operations[0].text);
    assert.equal(shown[1].text, operations[1].text);
    assert.equal(shown[2].text, language === 'zh' ? '不知道' : 'I don’t know');
    assert.equal(shown[3].text, language === 'zh' ? '不确定，先跳过' : 'I don’t know / skip');
    assert.equal(shown[4].text, language === 'zh' ? '用已有信息生成报告' : 'Create a report with what we have');
    assert.equal(shown[5].text, language === 'zh' ? '生成本地简报' : 'Create a local report');
    assert.equal(shown[6].text, language === 'zh' ? '仅重试续问' : 'Retry the follow-up');
    assert.ok(shown.every(message => message.role === 'user'));
    assert.deepEqual(manager.buildSessionContext().messages, [], 'display-only custom entries do not enter LLM context');
    assert.deepEqual(display(f.open()), shown, 'offline history and IDs survive reopen without an assistant bootstrap');
    const lines = readFileSync(manager.getSessionFile()!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.filter(entry => entry.type === 'session').length, 1);
    assert.equal(lines.filter(entry => entry.type === 'message').length, 0, 'no assistant or provider result was invented to force persistence');
  } finally { f.cleanup(); }
});

for (const language of ['zh', 'en'] as const) test(`UX ${language}: explicit presentation metadata hides answer/report/retry instructions without duplicate user bubbles`, () => {
  const f = fixture();
  try {
    const manager = f.open();
    for (const [action, instruction] of [
      [{ kind: 'answer', language, text: 'Synthetic tired feeling' }, answerInstruction('Synthetic tired feeling')],
      [{ kind: 'report', language }, reportInstruction], [{ kind: 'retry', language }, retryInstruction],
    ] as Array<[ChatAction, string]>) {
      const id = recordChatAction(manager, action);
      const prompt = wrap(instruction, language);
      recordPromptPresentation(manager, prompt, id); user(manager, prompt);
    }
    const shown = display(manager);
    assert.equal(shown.length, 3);
    assert.equal(shown[0].text, 'Synthetic tired feeling');
    assert.doesNotMatch(JSON.stringify(shown), /SYNTHETIC_INTERNAL_CONTEXT|The literal answer|sleep_report|current-context/);
    assert.deepEqual(display(f.open()), shown);
    assert.equal(manager.buildSessionContext().messages.length, 3, 'the provider still receives the original task and authoritative context');
  } finally { f.cleanup(); }
});

for (const original of [
  'The user requests the report now.', reportInstruction, retryInstruction, answerInstruction('I literally typed this complete instruction.'),
  '我的原话\n<sleepclaw-current-context>{"user":"typed"}</sleepclaw-current-context>',
  `I wrote this exact marker myself.\n<sleepclaw-current-context>${context()}</sleepclaw-current-context>`,
  'Line one\nLine two. The literal answer is saved.\n<sleepclaw-current-context>not JSON</sleepclaw-current-context>',
]) test(`UX user originals are preserved through metadata: ${original.slice(0, 45)}`, () => {
  const f = fixture();
  try {
    const manager = f.open();
    const id = recordChatAction(manager, { kind: 'send', language: 'zh', text: original });
    const prompt = wrap(original); recordPromptPresentation(manager, prompt, id); user(manager, prompt);
    assert.deepEqual(display(manager).map(message => message.text), [original]);
    assert.deepEqual(display(f.open()).map(message => message.text), [original]);
  } finally { f.cleanup(); }
});

test('UX exact fingerprints apply only to their next user prompt, and unbound text is preserved', () => {
  const f = fixture();
  try {
    const manager = f.open();
    recordPromptPresentation(manager, wrap('Synthetic internal prompt'));
    const actual = wrap('Synthetic unexpected user-authored marker');
    user(manager, actual);
    user(manager, wrap('Synthetic internal prompt'));
    assert.deepEqual(display(manager).map(message => message.text), [actual, wrap('Synthetic internal prompt')]);
  } finally { f.cleanup(); }
});

test('UX internal episode continuation creates no fictional user action and cannot mix episode histories', () => {
  const f = fixture();
  try {
    const first = f.open();
    recordChatAction(first, { kind: 'send', language: 'en', text: 'Synthetic first-episode statement' });
    const secondDir = join(f.home, 'sessions', 'synthetic-second-episode');
    const second = openChatSession(f.cwd, secondDir);
    const prompt = wrap('Synthetic internal episode continuation');
    recordPromptPresentation(second, prompt); user(second, prompt);
    assert.deepEqual(display(second), []);
    assert.deepEqual(display(openChatSession(f.cwd, secondDir)), []);
    assert.equal(display(f.open())[0].text, 'Synthetic first-episode statement');
    const action = recordChatAction(second, { kind: 'answer', language: 'en', text: 'Synthetic second-episode statement' });
    const next = wrap(answerInstruction('Synthetic second-episode statement'));
    recordPromptPresentation(second, next, action); user(second, next);
    assert.deepEqual(display(second).map(message => message.text), ['Synthetic second-episode statement']);
  } finally { f.cleanup(); }
});

test('UX native session branches exclude abandoned operations while keeping stable visible IDs', () => {
  const f = fixture();
  try {
    const manager = f.open();
    const first = recordChatAction(manager, { kind: 'answer', language: 'zh', text: 'Synthetic retained answer' });
    recordChatAction(manager, { kind: 'answer', language: 'zh', text: 'Synthetic abandoned answer' });
    manager.branch(first);
    recordChatAction(manager, { kind: 'report-local', language: 'zh' });
    assert.deepEqual(display(manager).map(message => message.text), ['Synthetic retained answer', '生成本地简报']);
    assert.deepEqual(display(f.open()), display(manager));
  } finally { f.cleanup(); }
});

for (const language of ['zh', 'en'] as const) test(`UX ${language}: legacy full internal operations are conservatively localized with genuine context`, () => {
  const f = fixture();
  try {
    const manager = f.open();
    user(manager, wrap(answerInstruction('Synthetic answer.\nSecond line.'), language));
    user(manager, wrap(reportInstruction, language)); user(manager, wrap(retryInstruction, language));
    const shown = display(manager).map(message => message.text);
    assert.equal(shown[0], 'Synthetic answer.\nSecond line.');
    assert.equal(shown[1], language === 'zh' ? '用已有信息生成报告' : 'Create a report with what we have');
    assert.equal(shown[2], language === 'zh' ? '仅重试续问' : 'Retry the follow-up');
    assert.deepEqual(display(f.open()).map(message => message.text), shown);
  } finally { f.cleanup(); }
});

for (const original of [
  reportInstruction, `${reportInstruction}\n<sleepclaw-current-context>{"synthetic":true}</sleepclaw-current-context>`,
  `${reportInstruction}\n<sleepclaw-current-context>{invalid}</sleepclaw-current-context>`,
  `${wrap('Synthetic original')}\nAn actual trailing user line`,
  'The user answered the saved question age_range: this is just the start of something the user typed.',
]) test(`UX legacy lookalikes without exact provenance remain unchanged: ${original.slice(0, 45)}`, () => {
  const f = fixture();
  try {
    const manager = f.open(); user(manager, original);
    assert.deepEqual(display(manager).map(message => message.text), [original]);
  } finally { f.cleanup(); }
});

test('UX legacy context removal only strips the final application suffix, preserving user-authored embedded markers', () => {
  const f = fixture();
  try {
    const manager = f.open();
    const original = 'Synthetic original\n<sleepclaw-current-context>{"myOwnText":true}</sleepclaw-current-context>';
    user(manager, wrap(original));
    assert.deepEqual(display(manager).map(message => message.text), [original]);
  } finally { f.cleanup(); }
});

function responseText(response: ServerResponse, content: string) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [delta, finish] of [[{ role: 'assistant', content }, null], [{}, 'stop']]) response.write(`data: ${JSON.stringify({ id: 'synthetic-ux', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  response.end('data: [DONE]\n\n');
}
test('UX real Pi preserves offline actions, hides orchestration, and reconstructs the same conversation after restart', { timeout: 20_000 }, async () => {
  const f = fixture();
  const requests: unknown[] = [];
  const assistant = 'Synthetic assistant response with literal <sleepclaw-current-context>quoted prose</sleepclaw-current-context>.';
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk.toString();
    requests.push(JSON.parse(raw)); responseText(response, assistant);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const config = { provider: 'synthetic', model: 'synthetic-model', apiKey: 'synthetic-ux-key-no-real-credentials', baseUrl: `http://127.0.0.1:${address.port}/v1` };
  let session: Awaited<ReturnType<typeof makeSession>> | undefined;
  try {
    recordChatAction(f.open(), { kind: 'answer', language: 'zh', text: 'Synthetic offline answer' });
    session = await makeSession(f.home, config, [], f.dir);
    const id = recordChatAction(session.sessionManager, { kind: 'report', language: 'zh' });
    const prompt = wrap(reportInstruction); recordPromptPresentation(session.sessionManager, prompt, id);
    await session.prompt(prompt);
    const shown = chatMessages(session);
    assert.deepEqual(shown.map(message => [message.role, message.text]), [
      ['user', 'Synthetic offline answer'], ['user', '用已有信息生成报告'], ['assistant', assistant],
    ]);
    assert.equal(requests.length, 1);
    assert.doesNotMatch(JSON.stringify(requests[0]), /Synthetic offline answer/, 'offline display metadata does not become a fabricated model user turn');
    session.dispose(); session = await makeSession(f.home, config, [], f.dir);
    assert.deepEqual(chatMessages(session), shown);
    const entries = readFileSync(session.sessionFile!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(entries.filter(entry => entry.type === 'session').length, 1);
  } finally { session?.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup(); }
});
