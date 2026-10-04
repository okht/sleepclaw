import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { SleepStore } from './domain/index';
import { createSleepTools, safeToolError, sleepContext } from './tools';
import { reportsForEpisode } from './shared/episode';
import { makeSession, testConnection, validateModelConfig, chatMessages, publicError, openChatSession, recordChatAction, recordPromptPresentation, type ChatAction } from './agent';
import { SubscriptionService } from './subscription';
import { SUBSCRIPTION_PROVIDER } from './subscription-credentials';
import type { AppSnapshot, AppEvent, AppNotice, AppTask, ModelConfig, Language, FactValue, SleepScope, Feedback, Investigation } from './shared/types';

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });
interface SavedWorkflow { episodeId: string; localCollection?: boolean; notice?: AppNotice; revision?: number; questionId?: string }
interface SavedSettings { language: Language; activeId?: string; model?: Omit<ModelConfig, 'apiKey'>; workflows?: Record<string, SavedWorkflow>; subscriptionDeviceId?: string }
const MODEL_FAILURES = new Set(['AUTH_FAILED', 'AUTH_REQUIRED', 'QUOTA', 'TIMEOUT', 'TURN_LIMIT', 'MODEL_NOT_FOUND', 'MODEL_REQUIRED', 'REQUEST_FAILED']);

export class SleepApp {
  readonly store: SleepStore;
  private settings: SavedSettings = { language: 'zh' };
  private config?: ModelConfig;
  private session?: AgentSession;
  private sessionInvestigationId?: string;
  private sessionEpisodeId?: string;
  private busy = false;
  private aborter?: AbortController;
  private cancelRequested = false;
  private task?: AppTask;
  private subscription?: SubscriptionService;
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
  setCredential(apiKey?: string): void { if (this.settings.model && this.settings.model.authMode !== 'chatgpt' && apiKey) this.config = { ...this.settings.model, apiKey }; }
  async initializeSubscription(options: Omit<Parameters<typeof SubscriptionService.create>[0], 'changed'>): Promise<void> {
    if (!/^[a-f0-9-]{36}$/i.test(this.settings.subscriptionDeviceId ?? '')) { this.settings.subscriptionDeviceId = randomUUID(); this.save(); }
    this.subscription = await SubscriptionService.create({ ...options, deviceId: this.settings.subscriptionDeviceId, changed: () => this.publish() });
    if (this.settings.model?.authMode === 'chatgpt' && this.subscription.ready()) this.config = { ...this.settings.model };
  }
  private recordAction(kind: ChatAction['kind'], text?: string): string {
    const investigation = this.store.getInvestigation(this.activeId());
    const manager = this.session && this.sessionMatches(investigation) ? this.session.sessionManager : openChatSession(join(this.home, 'workspace'), this.sessionDir(investigation));
    return recordChatAction(manager, { kind, text, language: this.settings.language });
  }
  private sessionDir(investigation: Investigation): string {
    const root = join(this.home, 'sessions', investigation.id);
    return investigation.sleepEpisodeId && investigation.sleepEpisodeId !== investigation.id
      ? join(root, 'episodes', investigation.sleepEpisodeId) : root;
  }
  private sessionMatches(investigation: Investigation): boolean {
    return this.sessionInvestigationId === investigation.id && this.sessionEpisodeId === (investigation.sleepEpisodeId ?? investigation.id);
  }
  snapshot(): AppSnapshot {
    const domain = this.store.snapshot(this.settings.activeId);
    const currentSession = domain.active && this.sessionMatches(domain.active) ? this.session : undefined;
    let messages = chatMessages(currentSession, this.settings.language);
    if (!currentSession && domain.active) {
      const dir = this.sessionDir(domain.active);
      if (existsSync(dir)) { const manager = openChatSession(join(this.home, 'workspace'), dir); messages = chatMessages({ messages: manager.buildSessionContext().messages, sessionManager: manager }, this.settings.language); }
    }
    const workflow = domain.active ? this.workflow(domain.active) : undefined;
    const notice = workflow?.revision === domain.active?.revision
      && (workflow?.notice?.kind !== 'followup-failed' || workflow.questionId === domain.question?.id) ? workflow?.notice : undefined;
    return { ...domain, language: this.settings.language, model: this.settings.model, configured: Boolean(this.config && (this.config.authMode !== 'chatgpt' || this.subscription?.ready())), messages, busy: this.busy, task: this.task, subscription: this.subscription?.snapshot(),
      notice, localCollection: Boolean(workflow?.localCollection) };
  }
  private workflow(investigation: Investigation): SavedWorkflow | undefined {
    const value = this.settings.workflows?.[investigation.id];
    return value?.episodeId === (investigation.sleepEpisodeId ?? investigation.id) ? value : undefined;
  }
  private updateWorkflow(update: (value: SavedWorkflow) => void): void {
    const investigation = this.store.getInvestigation(this.activeId());
    const value = this.workflow(investigation) ?? { episodeId: investigation.sleepEpisodeId ?? investigation.id };
    update(value);
    (this.settings.workflows ??= {})[investigation.id] = value;
    this.save();
  }
  private clearNotice(): void { this.updateWorkflow(value => { delete value.notice; delete value.revision; delete value.questionId; }); }
  private notice(kind: AppNotice['kind'], code: string): void {
    const state = this.store.snapshot(this.activeId());
    this.updateWorkflow(value => { value.notice = { kind, code }; value.revision = state.active!.revision; value.questionId = state.question?.id; });
  }
  private recoverableFailure(error: unknown, episodeId: string): string {
    const active = this.store.getInvestigation(this.activeId());
    if ((active.sleepEpisodeId ?? active.id) !== episodeId) throw new Error('EPISODE_CHANGED');
    if (this.cancelRequested) throw new Error('CANCELLED');
    const { code } = publicError(error, this.settings.language);
    if (!MODEL_FAILURES.has(code)) throw error;
    return code;
  }
  private async followup(text: string, actionId?: string): Promise<void> {
    const active = this.store.getInvestigation(this.activeId());
    try { await this.prompt(text, actionId); this.clearNotice(); }
    catch (error) {
      const code = publicError(error, this.settings.language).code;
      if (code === 'CANCELLED' || this.cancelRequested) {
        // The answer is already durable even when the user stops its follow-up.
        const current = this.store.getInvestigation(this.activeId());
        if ((current.sleepEpisodeId ?? current.id) === (active.sleepEpisodeId ?? active.id)) this.notice('followup-failed', 'CANCELLED');
        return;
      }
      this.notice('followup-failed', this.recoverableFailure(error, active.sleepEpisodeId ?? active.id));
    }
  }
  private publish(): void { this.emit({ type: 'state', state: this.snapshot() }); }
  private activeId(): string { const id = this.snapshot().active?.id; if (!id) throw new Error('TARGET_REQUIRED'); return id; }
  private context(): unknown {
    return sleepContext(this.store, this.activeId());
  }
  private tools(investigationId: string, episodeId: string) {
    return createSleepTools(this.store, { investigationId: () => investigationId, episodeId, onChange: () => this.publish() }).map(tool => defineTool({
      name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
      execute: async (_id, params, signal) => {
        try {
          const value = await tool.execute(params, signal);
          const current = this.store.getInvestigation(investigationId);
          if ((current.sleepEpisodeId ?? current.id) !== episodeId) void this.session?.abort();
          return result(value);
        } catch (error) {
          // Pi retains the failed-tool result while the model receives only the
          // application-owned code and recovery hint, never raw local errors.
          throw new Error(JSON.stringify(safeToolError(error)));
        }
      },
    }));
  }
  private async getSession(): Promise<AgentSession> {
    if (!this.config) throw new Error('MODEL_REQUIRED');
    if (this.config.authMode === 'chatgpt' && !this.subscription?.ready()) throw new Error('AUTH_REQUIRED');
    const investigation = this.store.getInvestigation(this.activeId());
    if (this.session && !this.sessionMatches(investigation)) this.dropSession();
    if (!this.session) {
      const episodeId = investigation.sleepEpisodeId ?? investigation.id;
      this.session = await makeSession(this.home, this.config, this.tools(investigation.id, episodeId), this.sessionDir(investigation), undefined, this.config.authMode === 'chatgpt' ? this.subscription?.runtime : undefined);
      this.sessionInvestigationId = investigation.id;
      this.sessionEpisodeId = episodeId;
    }
    return this.session;
  }
  private async prompt(text: string, actionId?: string): Promise<void> {
    let turns = 0;
    let timedOut = false;
    let turnLimitReached = false;
    const timeout = setTimeout(() => { timedOut = true; void this.session?.abort(); }, 120_000);
    try {
      // Retargeting ends the old model context. Continue the same user request
      // in the selected episode's session, with one shared timeout/turn budget.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (timedOut) throw new Error('TIMEOUT');
        if (this.cancelRequested) throw new Error('CANCELLED');
        const session = await this.getSession();
        const investigationId = this.sessionInvestigationId!;
        const episodeId = this.sessionEpisodeId!;
        const episodeChanged = () => (this.store.getInvestigation(investigationId).sleepEpisodeId ?? investigationId) !== episodeId;
        const unsubscribe = session.subscribe(event => {
          if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') this.emit({ type: 'delta', text: event.assistantMessageEvent.delta });
          if (event.type === 'tool_execution_start') this.emit({ type: 'progress', message: event.toolName });
          if (event.type === 'tool_execution_end') this.publish();
          if (event.type === 'turn_end' && ++turns >= 12) { turnLimitReached = true; void session.abort(); }
        });
        let promptError: unknown;
        try {
          if (timedOut) throw new Error('TIMEOUT');
          if (this.cancelRequested) throw new Error('CANCELLED');
          const current = this.context() as Record<string, unknown>;
          const continuation = attempt ? { episodeContinuation: 'The selected sleep episode changed. Continue the original request using only this episode\'s current facts; historical statements about another sleep require the user to confirm their applicability. Do not change the selected episode again unless the request explicitly requires it.' } : {};
          const fullPrompt = `${text}\n<sleepclaw-current-context>${JSON.stringify({ ...current, ...continuation })}</sleepclaw-current-context>`;
          recordPromptPresentation(session.sessionManager, fullPrompt, attempt ? undefined : actionId);
          await session.prompt(fullPrompt, { expandPromptTemplates: true });
        } catch (error) { promptError = error; }
        finally { unsubscribe(); }
        if (timedOut) throw new Error('TIMEOUT');
        if (this.cancelRequested) throw new Error('CANCELLED');
        if (turnLimitReached) throw new Error('TURN_LIMIT');
        if (episodeChanged()) {
          this.dropSession();
          if (attempt === 2 || turns >= 12) throw new Error('EPISODE_CHANGED');
          continue;
        }
        if (promptError) throw promptError;
        const last = session.messages.findLast(m => m.role === 'assistant');
        if (last?.role === 'assistant' && last.stopReason === 'error') {
          const error = new Error(last.errorMessage ?? 'REQUEST_FAILED');
          if (this.config?.authMode === 'chatgpt' && publicError(error, this.settings.language).code === 'AUTH_FAILED') this.subscription?.expire();
          throw error;
        }
        if (last?.role === 'assistant' && last.stopReason === 'aborted') throw new Error('CANCELLED');
        return;
      }
    } finally { clearTimeout(timeout); }
  }
  private dropSession(): void { this.session?.dispose(); this.session = undefined; this.sessionInvestigationId = undefined; this.sessionEpisodeId = undefined; }
  private removeSessions(id?: string): void {
    const root = resolve(this.home, 'sessions'); const target = id ? resolve(root, id) : root;
    if (id && (!/^[a-f0-9-]{36}$/.test(id) || !target.startsWith(`${root}${sep}`))) throw new Error('INVALID_ID');
    if (!id || this.store.snapshot(this.settings.activeId).active?.id === id) this.dropSession();
    rmSync(target, { recursive: true, force: true });
  }
  async request(method: string, p: Record<string, unknown> = {}): Promise<AppSnapshot> {
    if (method === 'state') return this.snapshot();
    if (method === 'submitSubscriptionCode') { this.subscription?.submit(p.code); return this.snapshot(); }
    if (method === 'openSubscriptionLogin') { this.subscription?.openBrowser(); return this.snapshot(); }
    if (method === 'cancel') { this.cancelRequested = true; this.aborter?.abort(); await this.session?.abort(); return this.snapshot(); }
    if (this.busy) throw new Error('BUSY');
    const kind = method === 'loginSubscription' ? 'auth' : ['configure', 'configureSubscription'].includes(method) ? 'configure' : method === 'import' ? 'import' : ['send', 'report', 'retryFollowup'].includes(method) || (method === 'answer' && this.config && !p.skip && !this.snapshot().localCollection) ? 'model' : undefined;
    this.task = kind ? { kind, cancellable: true } : undefined;
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
        case 'loginSubscription':
        case 'configureSubscription': {
          if (!this.subscription) throw new Error('AUTH_UNAVAILABLE');
          const model = this.subscription.model(p.model);
          if (method === 'loginSubscription') {
            const timer = setTimeout(() => this.aborter?.abort(), 300_000);
            try { await this.subscription.login(this.aborter.signal); } finally { clearTimeout(timer); }
          }
          if (!this.subscription.ready()) throw new Error('AUTH_REQUIRED');
          const config: ModelConfig = { provider: SUBSCRIPTION_PROVIDER, model, authMode: 'chatgpt' };
          this.task = { kind: 'configure', cancellable: true }; this.publish();
          await testConnection(this.home, config, this.aborter.signal, this.subscription.runtime);
          if (this.cancelRequested) throw new Error('CANCELLED');
          this.dropSession(); this.config = config; this.settings.model = config; this.save(); break;
        }
        case 'logoutSubscription': {
          if (!this.subscription) throw new Error('AUTH_UNAVAILABLE');
          await this.subscription.logout();
          if (this.settings.model?.authMode === 'chatgpt') { this.dropSession(); this.config = undefined; }
          break;
        }
        case 'new': {
          this.dropSession();
          const inv = this.store.createInvestigation(String(p.goal ?? ''), this.settings.language, (p.scope ?? 'main') as SleepScope);
          this.settings.activeId = inv.id; this.save(); break;
        }
        case 'select': {
          this.store.selectInvestigation(String(p.id)); this.dropSession(); this.settings.activeId = String(p.id); this.save();
          if (this.snapshot().configured) await this.getSession(); break;
        }
        case 'import': await this.store.importFile(String(p.path), { signal: this.aborter.signal, onProgress: count => this.emit({ type: 'progress', message: this.settings.language === 'zh' ? `已读取 ${count} 条记录` : `Read ${count} records` }) }); break;
        case 'target': {
          const investigation = this.store.setTarget(this.activeId(), { start: String(p.start), end: String(p.end), source: String(p.source), scope: p.scope as SleepScope | undefined });
          if (this.session && !this.sessionMatches(investigation)) this.dropSession();
          break;
        }
        case 'resume': this.store.resumeCollection(this.activeId()); break;
        case 'continueLocal': {
          this.store.resumeCollection(this.activeId());
          this.clearNotice(); this.updateWorkflow(value => { value.localCollection = true; }); break;
        }
        case 'continueWithModel': {
          if (!this.config) throw new Error('MODEL_REQUIRED');
          this.updateWorkflow(value => { value.localCollection = false; }); break;
        }
        case 'retryFollowup': {
          if (this.snapshot().notice?.kind !== 'followup-failed') throw new Error('NO_PENDING_FOLLOWUP');
          if (!this.config) throw new Error('MODEL_REQUIRED');
          await this.followup('The previous answer is already saved in the current facts. Retry only the interrupted follow-up. Read the current context; do not save or replay the old answer again. Ask exactly one useful next question, or show the pending fixed question.', this.recordAction('retry'));
          if (!this.snapshot().notice) this.updateWorkflow(value => { value.localCollection = false; });
          break;
        }
        case 'answer': {
          const question = this.snapshot().question;
          this.store.answer(this.activeId(), (p.value ?? null) as FactValue, Boolean(p.skip));
          const actionId = this.recordAction(p.skip ? 'skip' : 'answer', p.value == null ? undefined : String(p.value));
          this.clearNotice();
          if (this.config && !p.skip && !this.snapshot().localCollection) await this.followup(`The user answered the saved question ${question?.topic}: ${String(p.value)}. The literal answer is saved. Extract additional explicitly stated facts if any; inspect relevant data if useful, then ask exactly one useful next question or show the next fixed question.`, actionId);
          break;
        }
        case 'fact': this.store.setFact(this.activeId(), { topic: String(p.topic), value: (p.value ?? null) as FactValue, scope: p.scope as 'profile' | 'sleep', status: p.status as 'known' | 'unknown' | undefined }); break;
        case 'send': {
          const text = String(p.text ?? '').trim(); if (!text || text.length > 20000) throw new Error('INVALID_MESSAGE');
          if (!this.snapshot().active) { const inv = this.store.createInvestigation(text, this.settings.language); this.settings.activeId = inv.id; this.save(); }
          await this.prompt(text, this.recordAction('send', text)); break;
        }
        case 'reportLocal': {
          this.store.buildReport(this.activeId()); this.recordAction('report-local'); this.clearNotice(); break;
        }
        case 'report': {
          const actionId = this.recordAction(this.config ? 'report' : 'report-local');
          if (this.config) {
            const active = this.store.getInvestigation(this.activeId());
            let failure: string | undefined;
            try { await this.prompt('The user requests the report now. Stop asking questions. Use sleep_report to generate the report using the current facts and bounded data, with limitations and one practical action.', actionId); }
            catch (error) { failure = this.recoverableFailure(error, active.sleepEpisodeId ?? active.id); }
            const state = this.snapshot();
            const report = reportsForEpisode(state.reports, state.active).find(r => r.factRevision === state.active!.revision && r.status === 'complete');
            if (!report) {
              this.store.buildReport(this.activeId());
              this.notice('report-local', failure ?? 'REPORT_NOT_SAVED');
              this.emit({ type: 'progress', message: this.settings.language === 'zh' ? '已根据现有事实生成本地简报，未加入 AI 解读。' : 'A local facts-only brief was created without AI interpretation.' });
            } else {
              this.store.pauseCollection(this.activeId());
              if (failure) this.notice(report.aiInterpretation ? 'report-saved' : 'report-local', failure);
              else this.clearNotice();
            }
          } else { this.store.buildReport(this.activeId()); this.clearNotice(); }
          break;
        }
        case 'feedback': {
          const state = this.snapshot();
          if (!reportsForEpisode(state.reports, state.active).some(report => report.id === p.reportId)) throw new Error('REPORT_NOT_FOUND');
          this.store.recordFeedback(String(p.reportId), p.choice as Feedback['choice'], p.note as string | undefined);
          break;
        }
        case 'delete': {
          const id = String(p.id); this.store.getInvestigation(id); this.removeSessions(id); this.store.deleteInvestigation(id);
          if (this.settings.workflows) delete this.settings.workflows[id];
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
      const cancellation = method === 'import' && publicError(error, this.settings.language).code === 'CANCELLED';
      const sanitized = publicError(cancellation ? new Error('IMPORT_CANCELLED') : error, this.settings.language);
      if (this.config?.authMode === 'chatgpt' && sanitized.code === 'AUTH_FAILED') this.subscription?.expire();
      this.emit({ type: 'error', ...sanitized }); throw new Error(sanitized.code);
    } finally { this.busy = false; this.task = undefined; this.aborter = undefined; this.publish(); }
    return this.snapshot();
  }
  async close(): Promise<void> { this.aborter?.abort(); await this.session?.abort(); this.dropSession(); this.store.close(); }
}
