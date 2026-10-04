import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ChatMessage, Language } from './types.js';

const ACTION_ENTRY = 'sleepclaw.chat-action.v1';
const PROMPT_ENTRY = 'sleepclaw.prompt-presentation.v1';
export interface ChatAction {
  kind: 'send' | 'answer' | 'skip' | 'report' | 'report-local' | 'retry';
  language: Language;
  /** Original user text, never the internal instruction sent to the model. */
  text?: string;
}
type EntryReader = Pick<SessionManager, 'getBranch'>;
type EntryWriter = Pick<SessionManager, 'appendCustomEntry'>;
type MessageLike = { role: string; content?: unknown };
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');

/** Pi normally delays the first write until an assistant message exists. Open
 * an empty new file through its public API so offline action entries are durable
 * immediately, without inventing an assistant response or modifying SDK internals. */
export function openChatSession(cwd: string, sessionDir: string): SessionManager {
  mkdirSync(sessionDir, { recursive: true });
  const manager = SessionManager.continueRecent(cwd, sessionDir);
  const path = manager.getSessionFile();
  if (path && !existsSync(path)) {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    return SessionManager.open(path, sessionDir, cwd);
  }
  return manager;
}

function actionText(action: ChatAction): string {
  if (action.kind === 'send' || action.kind === 'answer') return action.text ?? (action.language === 'zh' ? '不知道' : 'I don’t know');
  const labels: Record<Exclude<ChatAction['kind'], 'send' | 'answer'>, [string, string]> = {
    skip: ['不确定，先跳过', 'I don’t know / skip'],
    report: ['用已有信息生成报告', 'Create a report with what we have'],
    'report-local': ['生成本地简报', 'Create a local report'],
    retry: ['仅重试续问', 'Retry the follow-up'],
  };
  return labels[action.kind][action.language === 'zh' ? 0 : 1];
}

/** A custom entry is display metadata only; Pi excludes it from model context. */
export function recordChatAction(manager: EntryWriter, action: ChatAction): string {
  const text = actionText(action);
  if (!text.trim()) throw new Error('INVALID_CHAT_ACTION');
  return manager.appendCustomEntry(ACTION_ENTRY, { ...action, text });
}

/** Bind only the next actual user prompt, by its complete exact fingerprint.
 * Internal continuation attempts have no new actionId and create no user bubble. */
export function recordPromptPresentation(manager: EntryWriter, fullPrompt: string, actionId?: string): void {
  manager.appendCustomEntry(PROMPT_ENTRY, { promptSha256: fingerprint(fullPrompt), ...(actionId ? { actionId } : {}) });
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
}

/** Old sessions have no presentation metadata. Only recognize a trailing,
 * parseable application context; embedded lookalikes and ordinary text survive. */
function legacyUserText(content: string, fallback: Language): string {
  const open = '\n<sleepclaw-current-context>';
  const close = '</sleepclaw-current-context>';
  const start = content.lastIndexOf(open);
  if (start < 0 || !content.endsWith(close)) return content;
  let context: { investigation?: { id?: unknown; language?: unknown }; facts?: unknown; language?: unknown };
  try { context = JSON.parse(content.slice(start + open.length, -close.length)); }
  catch { return content; }
  if (!context || typeof context.investigation?.id !== 'string' || !Array.isArray(context.facts)) return content;
  const language = context.language === 'zh' || context.language === 'en' ? context.language
    : context.investigation.language === 'zh' || context.investigation.language === 'en' ? context.investigation.language : fallback;
  const text = content.slice(0, start);
  const answer = /^The user answered the saved question [a-zA-Z][a-zA-Z0-9_.-]{0,100}: ([\s\S]*)\. The literal answer is saved\. Extract additional explicitly stated facts if any; inspect relevant data if useful, then ask exactly one useful next question or show the next fixed question\.$/.exec(text);
  if (answer) return answer[1];
  if (text === 'The user requests the report now. Stop asking questions. Use sleep_report to generate the report using the current facts and bounded data, with limitations and one practical action.') return actionText({ kind: 'report', language });
  if (text === 'The previous answer is already saved in the current facts. Retry only the interrupted follow-up. Read the current context; do not save or replay the old answer again. Ask exactly one useful next question, or show the pending fixed question.') return actionText({ kind: 'retry', language });
  return text;
}

function isAction(value: unknown): value is ChatAction & { text: string } {
  if (!value || typeof value !== 'object') return false;
  const action = value as Partial<ChatAction>;
  return ['send', 'answer', 'skip', 'report', 'report-local', 'retry'].includes(action.kind ?? '')
    && ['zh', 'en'].includes(action.language ?? '') && typeof action.text === 'string';
}

export function presentedChatMessages(session?: { messages: readonly MessageLike[]; sessionManager?: EntryReader }, language: Language = 'zh'): ChatMessage[] {
  if (!session) return [];
  if (!session.sessionManager) return session.messages.flatMap((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const original = contentText(message.content);
    const text = message.role === 'user' ? legacyUserText(original, language) : original;
    return text ? [{ id: `pi-${index}`, role: message.role, text }] : [];
  });
  const result: ChatMessage[] = [];
  let expectedPrompt: string | undefined;
  let hasPresentationMetadata = false;
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type === 'custom') {
      if (entry.customType === ACTION_ENTRY && isAction(entry.data)) {
        hasPresentationMetadata = true;
        expectedPrompt = undefined;
        result.push({ id: `action-${entry.id}`, role: 'user', text: entry.data.text });
      } else if (entry.customType === PROMPT_ENTRY) {
        hasPresentationMetadata = true;
        const hash = (entry.data as { promptSha256?: unknown } | undefined)?.promptSha256;
        expectedPrompt = typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
      }
      continue;
    }
    if (entry.type !== 'message' || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) continue;
    const original = contentText(entry.message.content);
    if (entry.message.role === 'user') {
      const hidden = expectedPrompt === fingerprint(original);
      expectedPrompt = undefined;
      if (hidden) continue;
    }
    const text = entry.message.role === 'user' && !hasPresentationMetadata ? legacyUserText(original, language) : original;
    if (text) result.push({ id: `pi-${entry.id}`, role: entry.message.role, text });
  }
  return result;
}
