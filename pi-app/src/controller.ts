import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { defineTool, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { SleepStore } from './domain/index';
import { createSleepTools, sleepContext } from './tools';
import { makeSession, testConnection, validateModelConfig, chatMessages, publicError } from './agent';
import type { AppSnapshot, AppEvent, ModelConfig, Language, FactValue, SleepScope, Feedback } from './shared/types';

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });
interface SavedSettings { language: Language; activeId?: string; model?: Omit<ModelConfig, 'apiKey'> }

export class SleepApp {
  readonly store: SleepStore;
  private settings: SavedSettings = { language: 'zh' };
  private config?: ModelConfig;
  private session?: AgentSession;
  private busy = false;
  private aborter?: AbortController;
  private cancelRequested = false;
  constructor(readonly home: string, private emit: (event: AppEvent) => void = () => {}) {
    mkdirSync(home, { recursive: true });
    this.store = new SleepStore(home);
    const file = join(home, 'settings.json');
    if (existsSync(file)) this.settings = JSON.parse(readFileSync(file, 'utf8'));
    if (!['zh', 'en'].includes(this.settings.language)) this.settings.language = 'zh';
  }
  private save(): void {
    const file = join(this.home, 'settings.json'); writeFileSync(`${file}.tmp`, JSON.stringify(this.settings, null, 2)); renameSync(`${file}.tmp`, file);
  }
  setCredential(apiKey?: string): void { if (this.settings.model && apiKey) this.config = { ...this.settings.model, apiKey }; }
  snapshot(): AppSnapshot {
    const domain = this.store.snapshot(this.settings.activeId);
    let messages = chatMessages(this.session);
    if (!this.session && domain.active) {
      const dir = join(this.home, 'sessions', domain.active.id);
      if (existsSync(dir)) messages = chatMessages({ messages: SessionManager.continueRecent(join(this.home, 'workspace'), dir).buildSessionContext().messages } as AgentSession);
    }
    return { ...domain, language: this.settings.language, model: this.settings.model, configured: Boolean(this.config), messages, busy: this.busy };
  }
  private publish(): void { this.emit({ type: 'state', state: this.snapshot() }); }
  private activeId(): string { const id = this.snapshot().active?.id; if (!id) throw new Error('TARGET_REQUIRED'); return id; }
  private context(): unknown {
    return sleepContext(this.store, this.activeId());
  }
  private tools() {
    return createSleepTools(this.store, { investigationId: () => this.activeId(), onChange: () => this.publish() }).map(tool => defineTool({
      name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
      execute: async (_id, params, signal) => result(await tool.execute(params, signal)),
    }));
  }
  private async getSession(): Promise<AgentSession> {
    if (!this.config) throw new Error('MODEL_REQUIRED');
    if (!this.session) this.session = await makeSession(this.home, this.config, this.tools(), join(this.home, 'sessions', this.activeId()));
    return this.session;
  }
  private async prompt(text: string): Promise<void> {
    const session = await this.getSession();
    let turns = 0;
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') this.emit({ type: 'delta', text: event.assistantMessageEvent.delta });
      if (event.type === 'tool_execution_start') this.emit({ type: 'progress', message: event.toolName });
      if (event.type === 'tool_execution_end') this.publish();
      if (event.type === 'turn_end' && ++turns >= 12) void session.abort();
    });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; void session.abort(); }, 120_000);
    try {
      if (this.cancelRequested) throw new Error('CANCELLED');
      const current = JSON.stringify(this.context());
      await session.prompt(`${text}\n<sleepclaw-current-context>${current}</sleepclaw-current-context>`, { expandPromptTemplates: true });
      if (timedOut) throw new Error('TIMEOUT');
      if (this.cancelRequested) throw new Error('CANCELLED');
      const last = session.messages.findLast(m => m.role === 'assistant');
      if (last?.role === 'assistant' && last.stopReason === 'error') throw new Error(last.errorMessage ?? 'REQUEST_FAILED');
      if (last?.role === 'assistant' && last.stopReason === 'aborted') throw new Error('CANCELLED');
    } finally { clearTimeout(timeout); unsubscribe(); }
  }
  private dropSession(): void { this.session?.dispose(); this.session = undefined; }
  private removeSessions(id?: string): void {
    const root = resolve(this.home, 'sessions'); const target = id ? resolve(root, id) : root;
    if (id && (!/^[a-f0-9-]{36}$/.test(id) || !target.startsWith(`${root}${sep}`))) throw new Error('INVALID_ID');
    if (!id || this.store.snapshot(this.settings.activeId).active?.id === id) this.dropSession();
    rmSync(target, { recursive: true, force: true });
  }
  async request(method: string, p: Record<string, unknown> = {}): Promise<AppSnapshot> {
    if (method === 'state') return this.snapshot();
    if (method === 'cancel') { this.cancelRequested = true; this.aborter?.abort(); await this.session?.abort(); return this.snapshot(); }
    if (this.busy) throw new Error('BUSY');
    this.busy = true; this.cancelRequested = false; this.aborter = new AbortController(); this.publish();
    try {
      switch (method) {
        case 'language': {
          if (p.language !== 'zh' && p.language !== 'en') throw new Error('INVALID_LANGUAGE');
          this.settings.language = p.language;
          const active = this.snapshot().active; if (active) this.store.setLanguage(active.id, p.language);
          this.save(); break;
        }
        case 'configure': {
          const config = validateModelConfig(p as unknown as ModelConfig);
          await testConnection(this.home, config, this.aborter.signal);
          if (this.cancelRequested) throw new Error('CANCELLED');
          this.dropSession(); this.config = config;
          const { apiKey: _key, ...saved } = config; this.settings.model = saved; this.save(); break;
        }
        case 'new': {
          this.dropSession();
          const inv = this.store.createInvestigation(String(p.goal ?? ''), this.settings.language, (p.scope ?? 'main') as SleepScope);
          this.settings.activeId = inv.id; this.save(); break;
        }
        case 'select': {
          this.store.selectInvestigation(String(p.id)); this.dropSession(); this.settings.activeId = String(p.id); this.save();
          if (this.config) await this.getSession(); break;
        }
        case 'import': await this.store.importFile(String(p.path), { signal: this.aborter.signal, onProgress: count => this.emit({ type: 'progress', message: this.settings.language === 'zh' ? `已读取 ${count} 条记录` : `Read ${count} records` }) }); break;
        case 'target': this.store.setTarget(this.activeId(), { start: String(p.start), end: String(p.end), source: String(p.source), scope: p.scope as SleepScope | undefined }); break;
        case 'answer': {
          const question = this.snapshot().question;
          this.store.answer(this.activeId(), (p.value ?? null) as FactValue, Boolean(p.skip));
          if (this.config && !p.skip) await this.prompt(`The user answered the saved question ${question?.topic}: ${String(p.value)}. The literal answer is saved. Extract additional explicitly stated facts if any; inspect relevant data if useful, then ask exactly one useful next question or show the next fixed question.`);
          break;
        }
        case 'fact': this.store.setFact(this.activeId(), { topic: String(p.topic), value: (p.value ?? null) as FactValue, scope: p.scope as 'profile' | 'sleep', status: p.status as 'known' | 'unknown' | undefined }); break;
        case 'send': {
          const text = String(p.text ?? '').trim(); if (!text || text.length > 20000) throw new Error('INVALID_MESSAGE');
          if (!this.snapshot().active) { const inv = this.store.createInvestigation(text, this.settings.language); this.settings.activeId = inv.id; this.save(); }
          await this.prompt(text); break;
        }
        case 'report': {
          if (this.config) {
            await this.prompt('The user requests the report now. Stop asking questions. Use sleep_report to generate the report using the current facts and bounded data, with limitations and one practical action.');
            const state = this.snapshot();
            const report = state.reports.find(r => r.investigationId === state.active?.id && r.factRevision === state.active.revision && r.status === 'complete');
            if (!report) {
              this.emit({ type: 'progress', message: this.settings.language === 'zh' ? '模型未保存完整报告，已根据现有事实生成本地简报，未加入 AI 解读。' : 'The model did not save a report. A local facts-only brief was created without AI interpretation.' });
              this.store.buildReport(this.activeId());
            }
          } else this.store.buildReport(this.activeId());
          break;
        }
        case 'feedback': this.store.recordFeedback(String(p.reportId), p.choice as Feedback['choice'], p.note as string | undefined); break;
        case 'delete': {
          const id = String(p.id); this.store.getInvestigation(id); this.removeSessions(id); this.store.deleteInvestigation(id);
          if (this.settings.activeId === id) delete this.settings.activeId; this.save(); break;
        }
        case 'deleteImport': {
          if (!this.snapshot().imports.some(i => i.id === p.id)) throw new Error('IMPORT_NOT_FOUND');
          this.removeSessions(); this.store.deleteImport(String(p.id)); break;
        }
        case 'deleteFact': {
          if (!this.snapshot().facts.some(f => f.id === p.id)) throw new Error('FACT_NOT_FOUND');
          this.removeSessions(); this.store.deleteFact(String(p.id)); break;
        }
        default: throw new Error('UNKNOWN_METHOD');
      }
    } catch (error) {
      const sanitized = publicError(error, this.settings.language); this.emit({ type: 'error', ...sanitized }); throw new Error(sanitized.code);
    } finally { this.busy = false; this.aborter = undefined; this.publish(); }
    return this.snapshot();
  }
  async close(): Promise<void> { this.aborter?.abort(); await this.session?.abort(); this.dropSession(); this.store.close(); }
}
