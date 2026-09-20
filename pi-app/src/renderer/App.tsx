import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive,
  useExternalStoreRuntime, type AppendMessage,
} from '@assistant-ui/react';
import { useTranslation } from 'react-i18next';
import type { AppSnapshot, ChatMessage, Fact, Investigation, Language, Metric, Report, SleepScope } from '../shared/types';
import { applyStreamEvent, conversationFacts, displayNumber, errorKey, formatDate, isSnapshot, localizedRecordText, manualTargetPayload, orderedReports, toDatetimeLocal, visibleMessages } from './ui-model';

const owl = new URL('./assets/owl-mark.svg', import.meta.url).href;
type Tab = 'chat' | 'data' | 'reports';
type Action = (method: string, params?: Record<string, unknown>) => Promise<boolean>;

function Owl({ large = false }: { large?: boolean }) {
  return <img className={large ? 'owl owl-large' : 'owl'} src={owl} alt="" aria-hidden="true" />;
}

function Icon({ name }: { name: 'sun' | 'moon' | 'arrow' | 'shield' | 'plus' | 'upload' | 'clock' | 'trash' }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'sun' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></> : null}
    {name === 'moon' ? <path d="M20.4 14A8.6 8.6 0 0 1 10 3.6 8.6 8.6 0 1 0 20.4 14Z" /> : null}
    {name === 'arrow' ? <path d="M5 12h14m-6-6 6 6-6 6" /> : null}
    {name === 'shield' ? <><path d="m12 3 8 3v5c0 5-5 8.5-8 10-3-1.5-8-5-8-10V6l8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></> : null}
    {name === 'plus' ? <path d="M12 5v14M5 12h14" /> : null}
    {name === 'upload' ? <><path d="M12 15V3m-4 4 4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></> : null}
    {name === 'clock' ? <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></> : null}
    {name === 'trash' ? <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5" /></> : null}
  </svg>;
}

export function DesktopTitlebar({ children }: { children?: React.ReactNode }) {
  return <header className="desktop-titlebar">{children}</header>;
}

export function SidebarBrand() {
  return <div className="brand"><Owl /><span className="brand-wordmark">SleepClaw<span aria-hidden="true">.</span></span></div>;
}

export function HistoryItem({ item, language, selected, blocked, onSelect, onDelete }: {
  item: Investigation; language: Language; selected: boolean; blocked: boolean;
  onSelect: () => void; onDelete: () => void;
}) {
  const { t } = useTranslation();
  return <div className="history-row">
    <button type="button" className={`history-item ${selected ? 'active' : ''}`} disabled={blocked}
      aria-current={selected ? 'page' : undefined} onClick={onSelect}>
      <span>{item.goal}</span><small>{formatDate(item.createdAt, language)}</small>
    </button>
    <button type="button" className="history-delete" disabled={blocked} aria-label={t('deleteHistoryLabel', { goal: item.goal })} title={t('delete')}
      aria-haspopup="dialog" onClick={() => { if (!blocked) onDelete(); }}>
      <Icon name="trash" />
    </button>
  </div>;
}

export function DeleteAnalysisDialog({ item, blocked, onCancel, onConfirm, fallbackFocus }: {
  item: Investigation; blocked: boolean; onCancel: () => void; onConfirm: () => Promise<boolean>;
  fallbackFocus?: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const trigger = document.activeElement;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      if (trigger instanceof HTMLButtonElement && trigger.isConnected && !trigger.disabled) trigger.focus();
      else fallbackFocus?.current?.focus();
    };
  }, [fallbackFocus]);
  const confirm = async () => {
    if (blocked || submitting.current) return;
    submitting.current = true;
    setDeleting(true);
    setFailed(false);
    try {
      if (await onConfirm()) { onCancel(); return; }
      setFailed(true);
    } catch { setFailed(true); }
    finally { submitting.current = false; setDeleting(false); }
  };
  return <dialog ref={dialog} className="delete-dialog" role="alertdialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    aria-busy={deleting} onCancel={(event) => { event.preventDefault(); if (!submitting.current) onCancel(); }}>
    <div className="delete-dialog-symbol"><Icon name="trash" /></div>
    <h2 id={`${id}-title`}>{t('deleteHistoryTitle', { goal: item.goal })}</h2>
    <div id={`${id}-description`}>
      <p className="delete-dialog-copy">{t('deleteHistoryScope')}</p>
      <p className="delete-dialog-kept"><Icon name="shield" /><span>{t('deleteHistoryKept')}</span></p>
      <p className="delete-dialog-warning">{t('deleteHistoryWarning')}</p>
    </div>
    {failed ? <p className="delete-dialog-error" role="alert">{t('deleteHistoryFailed')}</p> : null}
    <div className="delete-dialog-actions">
      <button ref={cancel} type="button" className="delete-dialog-cancel" disabled={deleting} onClick={onCancel}>{t('cancel')}</button>
      <button type="button" className="delete-dialog-confirm" disabled={blocked || deleting} onClick={() => void confirm()}>
        {t(deleting ? 'deletingHistory' : 'deleteHistoryAction')}
      </button>
    </div>
  </dialog>;
}

function useDesktopState() {
  const { t } = useTranslation();
  const [state, setState] = useState<AppSnapshot>();
  const [delta, setDelta] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [pending, setPending] = useState(0);
  const accept = useCallback((value: unknown) => {
    if (isSnapshot(value)) {
      setState(value);
      setDelta((text) => applyStreamEvent(text, { type: 'state', state: value }));
      if (!value.busy) setProgress('');
      return true;
    }
    return false;
  }, []);
  const refresh = useCallback(async () => {
    try { accept(await window.sleepclaw.request('state')); }
    catch (cause) { setError(t(errorKey(cause))); }
  }, [accept, t]);
  useEffect(() => {
    const unsubscribe = window.sleepclaw.onEvent((event) => {
      if (event.type === 'state') accept(event.state);
      if (event.type === 'delta') setDelta((text) => applyStreamEvent(text, event));
      if (event.type === 'progress') setProgress(event.message);
      if (event.type === 'error') { setError(t(errorKey(event.code))); setProgress(''); }
    });
    void refresh();
    return unsubscribe;
  }, [accept, refresh, t]);
  const action: Action = useCallback(async (method, params) => {
    setPending((count) => count + 1);
    setError('');
    if (method === 'send' || method === 'select' || method === 'new') setDelta('');
    try {
      await window.sleepclaw.request(method, params);
      await refresh();
      return true;
    } catch (cause) {
      setError((current) => current || t(errorKey(cause)));
      return false;
    } finally { setPending((count) => count - 1); setProgress(''); }
  }, [refresh, t]);
  return { state, delta, error, progress, pending, action, refresh, clearError: () => setError('') };
}

export function App() {
  const { t, i18n } = useTranslation();
  const { state, delta, error, progress, pending, action, refresh, clearError } = useDesktopState();
  const [tab, setTab] = useState<Tab>('chat');
  const [settings, setSettings] = useState(false);
  const [offline, setOffline] = useState(false);
  const [newAnalysis, setNewAnalysis] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Investigation>();
  const newButton = useRef<HTMLButtonElement>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('sleepclaw-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('sleepclaw-theme', theme); } catch { /* Appearance can remain session-only. */ }
    void window.sleepclaw.request('windowTheme', { theme }).catch(() => { /* Keep local appearance available if the window is closing. */ });
  }, [theme]);
  useEffect(() => {
    if (state?.language) {
      void i18n.changeLanguage(state.language);
      document.documentElement.lang = state.language === 'zh' ? 'zh-CN' : 'en';
    }
  }, [state?.language, i18n]);
  const importFile = async () => {
    try {
      const path = await window.sleepclaw.chooseFile();
      if (path && await action('import', { path })) { setOffline(true); setSettings(false); setTab('data'); }
    } catch { await refresh(); }
  };
  const makeReport = async () => { if (await action('report')) setTab('reports'); };
  const changeLanguage = () => void action('language', { language: state?.language === 'zh' ? 'en' : 'zh' });
  const controls = <div className="window-controls">
    <button className="quiet-button" onClick={changeLanguage} aria-label={t('language')}>{state?.language === 'en' ? '中文' : 'EN'}</button>
    <button className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={t('theme')} title={t('theme')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
  </div>;
  if (!state) return <><DesktopTitlebar /><main className="loading-page"><Owl large /><p role="status">{error || t('loading')}</p>{error ? <button onClick={() => void refresh()}>{t('retry')}</button> : null}</main></>;
  const blocked = pending > 0 || state.busy;
  const showConnection = settings || (!state.configured && !offline);
  return <div className={showConnection ? 'app connection-app' : 'app'}>
    <DesktopTitlebar>{controls}</DesktopTitlebar>
    {showConnection ? <>
      <div className="connection-scroll"><ConnectionPanel state={state} action={action} pending={pending > 0} onDone={() => { setSettings(false); setOffline(true); }} onOffline={() => { setOffline(true); setSettings(false); }} /></div>
    </> : <>
      <aside className="sidebar" aria-label={t('history')}>
        <SidebarBrand />
        <button ref={newButton} className="new-button" onClick={() => { setNewAnalysis(true); setTab('chat'); }} disabled={blocked}><Icon name="plus" />{t('newChat')}</button>
        <p className="section-label">{t('history')}</p>
        <nav className="history-list">
          {state.investigations.length ? state.investigations.map((item) => <HistoryItem key={item.id} item={item} language={state.language}
            selected={state.active?.id === item.id && !newAnalysis} blocked={blocked}
            onSelect={async () => { if (await action('select', { id: item.id })) { setNewAnalysis(false); setTab('chat'); } }}
            onDelete={() => setDeleteTarget(item)}
          />) : <div className="empty-history"><Icon name="clock" /><p>{t('emptyHistory')}</p></div>}
        </nav>
        <div className="sidebar-footer"><span className="local-note"><Icon name="shield" />{t('local')}</span><button className="text-button" onClick={() => void action('openNotices')}>{t('notices')}</button></div>
      </aside>
      <main className="workspace">
        <header className="workspace-header">
          <div className="tabs" role="tablist" aria-label="SleepClaw">
            {(['chat', 'data', 'reports'] as const).map((item) => <button key={item} role="tab" aria-selected={tab === item} aria-controls={`panel-${item}`} id={`tab-${item}`} className={tab === item ? 'selected' : ''} onClick={() => setTab(item)}>{t(item)}</button>)}
          </div>
          <div className="header-right"><button className="model-button" onClick={() => setSettings(true)} disabled={blocked} title={t('settings')} aria-label={state.model?.model ? `${t('settings')}: ${state.model.model}` : t('settings')}><span className={`status-dot ${state.configured ? 'connected' : ''}`} /><span>{state.model?.model || t('connectModel')}</span></button></div>
        </header>
        <div className={`workspace-content ${tab === 'chat' && state.active && !newAnalysis ? 'workspace-content-thread' : ''}`} role="tabpanel" aria-labelledby={`tab-${tab}`} id={`panel-${tab}`}>
          {tab === 'chat' ? (!state.active || newAnalysis ? <Welcome state={state} action={action} importFile={importFile} blocked={blocked} onStarted={() => setNewAnalysis(false)} onConnect={() => setSettings(true)} />
            : <ChatPanel key={state.active.id} state={state} delta={delta} action={action} importFile={importFile} makeReport={makeReport} blocked={blocked} onConnect={() => setSettings(true)} onOpenData={() => setTab('data')} onOpenReports={() => setTab('reports')} />) : null}
          {tab === 'data' ? <DataPanel key={state.active?.id || 'unselected'} state={state} action={action} blocked={blocked} importFile={importFile} /> : null}
          {tab === 'reports' ? <ReportsPanel state={state} action={action} blocked={blocked} makeReport={makeReport} /> : null}
        </div>
      </main>
    </>}
    {progress ? <div className="progress-toast" role="status"><span className="pulse-dot" />{progress}</div> : null}
    {error ? <div className="error-toast" role="alert"><span>{error}</span><button className="icon-button" aria-label={t('close')} onClick={clearError}>×</button></div> : null}
    {deleteTarget ? <DeleteAnalysisDialog key={deleteTarget.id} item={deleteTarget} blocked={blocked} fallbackFocus={newButton}
      onCancel={() => setDeleteTarget(undefined)} onConfirm={async () => {
        const deleted = await action('delete', { id: deleteTarget.id });
        if (deleted && state.active?.id === deleteTarget.id && !newAnalysis) setTab('chat');
        return deleted;
      }} /> : null}
  </div>;
}

export function ConnectionPanel({ state, action, pending, onDone, onOffline }: { state: AppSnapshot; action: Action; pending: boolean; onDone: () => void; onOffline: () => void }) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState(state.model?.provider || 'anthropic');
  const [model, setModel] = useState(state.model?.model || '');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(state.model?.baseUrl || '');
  const [protocol, setProtocol] = useState<'openai-completions' | 'anthropic-messages'>(state.model?.protocol || 'openai-completions');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await action('configure', { provider, model: model.trim(), apiKey: apiKey.trim(), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), protocol: provider === 'anthropic' ? 'anthropic-messages' : protocol });
    setApiKey('');
    if (ok) onDone();
  };
  return <main className="connection-content">
    <div className="connection-brand"><div className="owl-halo"><Owl large /></div><p className="connection-wordmark">SleepClaw<span aria-hidden="true">.</span></p><h1>{t('connectTitle')}</h1><p className="muted">{t('connectIntro')}</p></div>
    <form className="connection-form" onSubmit={submit}>
      <div className="connection-form-heading"><p className="eyebrow">{t('connectionEyebrow')}</p><h2>{t('connectionHeading')}</h2><p className="muted">{t('connectionDescription')}</p></div>
      <div className="provider-picker" role="group" aria-label={t('provider')}>
        {[['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['custom', t('custom')]].map(([value, label]) => <button type="button" aria-pressed={provider === value} key={value} className={provider === value ? 'selected' : ''} disabled={pending} onClick={() => { setProvider(value!); setProtocol(value === 'anthropic' ? 'anthropic-messages' : 'openai-completions'); setModel(''); setBaseUrl(''); }}>{label}</button>)}
      </div>
      {provider === 'custom' ? <><label>{t('baseUrl')}<input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required disabled={pending} autoComplete="off" placeholder="https://…" /></label>
        <label>{t('protocol')}<select value={protocol} onChange={(e) => setProtocol(e.target.value as typeof protocol)} disabled={pending}><option value="openai-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select></label></> : null}
      <label>{t('model')}<input value={model} onChange={(e) => setModel(e.target.value)} required disabled={pending} autoComplete="off" spellCheck={false} aria-describedby="model-hint" /><small id="model-hint">{t('modelHint')}</small></label>
      <label>{t('apiKey')}<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required disabled={pending} autoComplete="off" spellCheck={false} placeholder={t('apiKeyHint')} aria-describedby="key-hint" /><small id="key-hint">{t('keyPrivacy')}</small></label>
      <button className="primary-button" type="submit" disabled={pending || !model.trim() || !apiKey.trim()}>{pending ? t('connecting') : t('connect')}<Icon name="arrow" /></button>
      <p className="privacy-note"><Icon name="shield" /><span>{t('privacy')}</span></p>
      <div className="connection-offline"><button type="button" className="text-button offline-link" onClick={onOffline} disabled={pending}>{state.configured ? t('back') : t('offline')}<Icon name="arrow" /></button>
        {!state.configured ? <p className="small muted">{t('offlineNote')}</p> : null}
      </div>
    </form>
  </main>;
}

function ScopeSelect({ value, onChange, disabled = false, compact = false }: { value: SleepScope; onChange: (value: SleepScope) => void; disabled?: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  return <label className="scope-select"><span className={compact ? 'sr-only' : undefined}>{t('scope')}</span><select value={value} onChange={(event) => onChange(event.target.value as SleepScope)} disabled={disabled}>{(['main', 'nap', 'segment'] as const).map((scope) => <option key={scope} value={scope}>{t(scope)}</option>)}</select></label>;
}

export function Welcome({ state, action, importFile, blocked, onStarted, onConnect }: { state: AppSnapshot; action: Action; importFile: () => Promise<void>; blocked: boolean; onStarted: () => void; onConnect: () => void }) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState('');
  const [scope, setScope] = useState<SleepScope>('main');
  const goalInput = useRef<HTMLTextAreaElement>(null);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (blocked || !goal.trim()) return; if (await action('new', { goal: goal.trim(), scope })) onStarted(); };
  return <section className="welcome page-body" aria-labelledby="welcome-title">
    <div className="welcome-heading"><div className="welcome-owl"><Owl large /></div><h1 id="welcome-title">{t('welcomeTitle')}</h1><p className="intro muted">{t('welcomeText')}</p></div>
    <form className="goal-form" onSubmit={submit}><label className="sr-only" htmlFor="sleep-goal">{t('goal')}</label><textarea ref={goalInput} id="sleep-goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={t('goalPlaceholder')} rows={2} required maxLength={2000} disabled={blocked} />
      <div className="form-footer"><div className="goal-options"><button type="button" className="import-button" onClick={() => void importFile()} disabled={blocked} title={t('importHint')}><Icon name="upload" />{t('import')}</button><ScopeSelect value={scope} onChange={setScope} disabled={blocked} compact /></div><button type="submit" className="primary-button goal-submit" disabled={blocked || !goal.trim()} aria-label={t('start')} title={t('start')}><Icon name="arrow" /></button></div>
    </form>
    <div className="starter-prompts" role="group" aria-label={t('starterPrompts')}>{(['tired', 'waking', 'routine'] as const).map((topic) => <button key={topic} type="button" disabled={blocked} onClick={() => { setGoal(t(`starter_${topic}_prompt`)); goalInput.current?.focus(); }}>{t(`starter_${topic}`)}<Icon name="arrow" /></button>)}</div>
    <p className="welcome-data-note"><Icon name="shield" />{t('welcomeDataNote')}</p>
    {!state.configured ? <div className="welcome-offline"><span>{t('welcomeOffline')}</span><button type="button" className="text-button" onClick={onConnect} disabled={blocked}>{t('connectModel')}<Icon name="arrow" /></button></div> : null}
  </section>;
}

function UserMessage() { const { t } = useTranslation(); return <MessagePrimitive.Root className="message user-message"><span className="message-author">{t('you')}</span><div className="message-text"><MessagePrimitive.Parts /></div></MessagePrimitive.Root>; }
function AssistantMessage() { return <MessagePrimitive.Root className="message assistant-message"><span className="message-author"><Owl /> SleepClaw</span><div className="message-text"><MessagePrimitive.Parts /></div></MessagePrimitive.Root>; }
const messageComponents = { UserMessage, AssistantMessage };
const convertMessage = (message: ChatMessage) => ({ id: message.id, role: message.role, content: [{ type: 'text' as const, text: message.text }] });

export function ConversationEmpty({ state, blocked, onOpenData, onOpenReports, importFile }: { state: AppSnapshot; blocked: boolean; onOpenData: () => void; onOpenReports: () => void; importFile: () => Promise<void> }) {
  const { t } = useTranslation();
  const report = orderedReports(state.reports.filter((item) => item.investigationId === state.active?.id), state.active?.id)[0];
  const stale = report && (report.status === 'stale' || report.factRevision !== state.active?.revision);
  const title = state.busy ? 'conversationWorking' : report ? (stale ? 'conversationReportStale' : 'conversationReportReady') : 'conversationEmptyTitle';
  const description = state.busy ? 'conversationWorkingHint' : report ? (stale ? 'conversationReportStaleHint' : 'conversationReportReadyHint') : state.configured ? 'conversationEmptyHint' : 'conversationLocalHint';
  return <section className="conversation-empty" aria-labelledby="conversation-empty-title">
    <div className="conversation-presence"><Owl large /></div>
    <p className="conversation-state"><span className={`status-dot ${state.busy ? 'working' : 'connected'}`} />{t(state.busy ? 'progress' : report ? 'reports' : 'thisSleep')}</p>
    <h2 id="conversation-empty-title">{t(title)}</h2><p className="conversation-empty-description">{t(description)}</p>
    {!state.busy ? <div className="conversation-empty-actions"><button className="secondary-button" onClick={report ? onOpenReports : onOpenData} disabled={blocked}>{t(report ? 'viewReport' : 'reviewFacts')}<Icon name="arrow" /></button><button className="text-button" onClick={() => void importFile()} disabled={blocked}><Icon name="upload" />{t('import')}</button></div> : null}
  </section>;
}

function ChatPanel({ state, delta, action, importFile, makeReport, blocked, onConnect, onOpenData, onOpenReports }: { state: AppSnapshot; delta: string; action: Action; importFile: () => Promise<void>; makeReport: () => Promise<void>; blocked: boolean; onConnect: () => void; onOpenData: () => void; onOpenReports: () => void }) {
  const { t } = useTranslation();
  const messages = useMemo(() => visibleMessages(state.messages, delta, state.active?.id), [state.messages, delta, state.active?.id]);
  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.type === 'text' ? part.text : '').join('\n');
    if (text.trim()) await action('send', { text });
  }, [action]);
  const onCancel = useCallback(async () => { await action('cancel'); }, [action]);
  const runtime = useExternalStoreRuntime({ messages, convertMessage, isRunning: state.busy, onNew, onCancel });
  const empty = !messages.length && !state.question;
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="thread">
    <div className="conversation-heading"><div><p className="eyebrow"><Icon name="moon" />{t(state.active?.scope || 'main')}</p><h1>{state.active?.goal}</h1></div><button className="text-button report-button" onClick={() => void makeReport()} disabled={blocked}>{t('createReport')}<Icon name="arrow" /></button></div>
    <ThreadPrimitive.Viewport className={`thread-viewport${empty ? ' thread-viewport-empty' : ''}`}>
      {empty ? <ConversationEmpty state={state} blocked={blocked} onOpenData={onOpenData} onOpenReports={onOpenReports} importFile={importFile} /> : null}
      {!messages.length && state.question ? <div className="question-presence"><Owl /><span>{t('appSubtitle')}</span></div> : null}
      <ThreadPrimitive.Messages components={messageComponents} />
      {state.question ? <QuestionCard key={state.question.id} state={state} action={action} blocked={blocked} makeReport={makeReport} /> : null}
    </ThreadPrimitive.Viewport>
    <div className="composer-area">
      {state.configured ? <ComposerPrimitive.Root className="composer"><ComposerPrimitive.Input className="composer-input" placeholder={t('composer')} aria-label={t('composer')} disabled={blocked && !state.busy} />
        <div className="composer-actions"><button type="button" className="icon-button" aria-label={t('import')} title={t('import')} onClick={() => void importFile()} disabled={blocked}>＋</button>
          {state.busy ? <ComposerPrimitive.Cancel className="send-button">■ <span>{t('stop')}</span></ComposerPrimitive.Cancel> : <ComposerPrimitive.Send className="send-button">↑ <span>{t('send')}</span></ComposerPrimitive.Send>}
        </div></ComposerPrimitive.Root> : <div className="connect-callout"><div className="connect-callout-copy"><Icon name="moon" /><div><p>{t('localModeTitle')}</p><span>{t('localModeHint')}</span></div></div><button className="primary-button" onClick={onConnect} disabled={blocked}>{t('connectModel')}<Icon name="arrow" /></button></div>}
      <p className="composer-disclaimer">{t('disclaimer')}</p>
    </div>
  </ThreadPrimitive.Root></AssistantRuntimeProvider>;
}

function QuestionCard({ state, action, blocked, makeReport }: { state: AppSnapshot; action: Action; blocked: boolean; makeReport: () => Promise<void> }) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState('');
  const question = state.question;
  if (!question) return null;
  const numeric = question.topic === 'sleep_duration_hours' || question.topic === 'remembered_awakenings';
  return <section className="question-card" aria-labelledby="question-title"><p className="section-label">{t('question')}</p><h2 id="question-title">{question.text}</h2>
    {question.reason ? <p className="question-reason"><span>{t('questionReason')} · </span>{question.reason}</p> : null}
    <form onSubmit={async (event) => { event.preventDefault(); if (await action('answer', { value: numeric ? Number(answer) : answer })) setAnswer(''); }}>
      <label className="sr-only" htmlFor="question-answer">{t('answer')}</label>{numeric ? <input id="question-answer" type="number" inputMode="decimal" min={0} step={question.topic === 'remembered_awakenings' ? 1 : 'any'} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={question.topic === 'sleep_duration_hours' ? t('hoursPlaceholder') : t('countPlaceholder')} disabled={blocked} required /> : <textarea id="question-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={t('answerPlaceholder')} rows={2} disabled={blocked} maxLength={6000} />}
      <div className="question-actions"><button className="primary-button" type="submit" disabled={blocked || !answer.trim()}>{t('continue')} →</button><button className="text-button" type="button" onClick={() => void action('answer', { skip: true })} disabled={blocked}>{t('skip')}</button></div>
    </form><button className="text-button report-shortcut" onClick={() => void makeReport()} disabled={blocked}>{t('reportNow')} ↗</button>
  </section>;
}

function DataPanel({ state, action, blocked, importFile }: { state: AppSnapshot; action: Action; blocked: boolean; importFile: () => Promise<void> }) {
  const { t } = useTranslation();
  const facts = conversationFacts(state.facts, state.active?.id);
  const [scope, setScope] = useState<SleepScope>(state.active?.scope || 'main');
  return <section className="page-body data-page"><div className="page-heading"><div><p className="eyebrow">{t('dataEyebrow')}</p><h1>{t('data')}</h1></div><button className="primary-button" onClick={() => void importFile()} disabled={blocked}>＋ {t('import')}</button></div>
    <section className="panel"><h2>{t('selectedSleep')}</h2>{state.active?.start ? <p>{formatDate(state.active.start, state.language)} — {formatDate(state.active.end, state.language)}<span className="badge">{state.active.source}</span></p> : <p className="muted">{t('noTarget')}</p>}</section>
    <ManualTargetForm key={`${state.active?.id}-${state.active?.start}-${state.active?.end}-${state.active?.source}`} state={state} action={action} blocked={blocked} />
    {state.candidates.length ? <section className="panel"><div className="section-heading"><h2>{t('candidates')}</h2><ScopeSelect value={scope} onChange={setScope} disabled={blocked} /></div>{!state.active ? <p className="small warning">{t('startBeforeTarget')}</p> : null}<div className="candidate-list">
      {state.candidates.map((candidate) => <article className="candidate" key={candidate.id}><div><strong>{formatDate(candidate.start, state.language)} — {formatDate(candidate.end, state.language)}</strong><p className="small muted">{candidate.source} · {displayNumber(candidate.asleepMinutes)} {t('minutes')}</p></div><button className="secondary-button" disabled={blocked || !state.active} onClick={() => void action('target', { start: candidate.start, end: candidate.end, source: candidate.source, scope })}>{t('chooseSleep')}</button></article>)}
    </div></section> : null}
    <section className="panel"><h2>{t('imports')}</h2>{state.imports.length ? state.imports.map((item) => <article className="import-row" key={item.id}><div className="section-heading"><strong>{item.name}</strong><button className="text-button danger" disabled={blocked} onClick={() => { if (window.confirm(t('deleteImportConfirm', { name: item.name }))) void action('deleteImport', { id: item.id }); }}>{t('deleteImport')}</button></div><p className="small muted">{item.recordCount} {t('records')} · {item.duplicateCount} {t('duplicates')} · {formatDate(item.importedAt, state.language)}</p><p className="small">{item.sources.map((source) => source === '未知来源' ? t('unknownSource') : source).join(' · ')}</p>{item.warnings.map((warning, index) => <p className="warning small" key={index}>{localizedRecordText(warning, state.language)}</p>)}</article>) : <p className="muted">{t('noImports')}</p>}</section>
    <section className="panel"><h2>{t('facts')}</h2><p className="small muted">{t('factsHint')}</p>{facts.length ? <div className="fact-list">{facts.map((fact) => <FactRow key={`${fact.id}-${fact.revision}`} fact={fact} action={action} blocked={blocked} />)}</div> : <p className="muted">{t('noFacts')}</p>}</section>
    {state.active ? <button className="text-button danger" disabled={blocked} onClick={() => { if (window.confirm(t('deleteConfirm'))) void action('delete', { id: state.active?.id }); }}>{t('delete')}</button> : null}
  </section>;
}

export function ManualTargetForm({ state, action, blocked }: { state: AppSnapshot; action: Action; blocked: boolean }) {
  const { t } = useTranslation();
  const sources = [...new Set(state.imports.flatMap((item) => item.sources))].sort((a, b) => a.localeCompare(b));
  const [start, setStart] = useState(() => toDatetimeLocal(state.active?.start));
  const [end, setEnd] = useState(() => toDatetimeLocal(state.active?.end));
  const [source, setSource] = useState(state.active?.source && sources.includes(state.active.source) ? state.active.source : '');
  const [scope, setScope] = useState<SleepScope>(state.active?.scope || 'main');
  const payload = manualTargetPayload(start, end, source);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const incomplete = !start || !end || !source;
  return <details className="panel manual-target"><summary>{t('manualTarget')}</summary><p className="small muted">{t('manualTargetHint')}</p><p className="small muted">{t('localTimezone', { timezone })}</p>
    {!state.active ? <p className="small warning">{t('startBeforeTarget')}</p> : null}
    {!sources.length ? <p className="small muted">{t('importBeforeTarget')}</p> : null}
    <form onSubmit={async (event) => { event.preventDefault(); if (payload && state.active) await action('target', { ...payload, scope }); }}>
      <div className="target-time-fields"><label>{t('startTime')}<input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} step="1" disabled={blocked || !state.active} required /></label><label>{t('endTime')}<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} step="1" disabled={blocked || !state.active} required /></label></div>
      <label>{t('source')}<select value={source} onChange={(event) => setSource(event.target.value)} required disabled={blocked || !state.active || !sources.length}><option value="">{t('selectSource')}</option>{sources.map((name) => <option key={name} value={name}>{name === '未知来源' ? t('unknownSource') : name}</option>)}</select></label>
      {!incomplete && !payload ? <p className="small warning" role="alert">{t('invalidTargetRange')}</p> : null}
      <div className="form-footer"><ScopeSelect value={scope} onChange={setScope} disabled={blocked || !state.active} /><button className="secondary-button" type="submit" disabled={blocked || !state.active || !payload}>{t('applyTarget')}</button></div>
    </form>
  </details>;
}

function FactRow({ fact, action, blocked }: { fact: Fact; action: Action; blocked: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(fact.value ?? ''));
  return <article className="fact-row"><div className="fact-description"><span className="badge">{t(fact.scope === 'profile' ? 'profile' : 'thisSleep')}</span><strong>{t(fact.topic, { defaultValue: fact.topic.replaceAll('_', ' ') })}</strong></div>
    {editing ? <form className="fact-edit" onSubmit={async (event) => { event.preventDefault(); const updated = typeof fact.value === 'number' ? Number(value) : value; if (await action('fact', { topic: fact.topic, value: updated, scope: fact.scope, status: 'known' })) setEditing(false); }}><label className="sr-only" htmlFor={`fact-${fact.id}`}>{t('factValue')}</label><input id={`fact-${fact.id}`} type={typeof fact.value === 'number' ? 'number' : 'text'} min={typeof fact.value === 'number' ? 0 : undefined} step="any" value={value} onChange={(event) => setValue(event.target.value)} disabled={blocked} autoFocus required /><button className="secondary-button" type="submit" disabled={blocked}>{t('save')}</button><button className="text-button" type="button" onClick={() => setEditing(false)}>{t('cancel')}</button></form>
      : <div className="fact-answer"><span>{fact.status === 'unknown' ? t('unknown') : String(fact.value ?? '—')}</span><div className="fact-controls"><button className="text-button" onClick={() => setEditing(true)} disabled={blocked}>{t('edit')}</button><button className="text-button danger" disabled={blocked} onClick={() => { if (window.confirm(t('deleteFactConfirm'))) void action('deleteFact', { id: fact.id }); }}>{t('deleteFact')}</button></div></div>}
  </article>;
}

export function ReportsPanel({ state, action, blocked, makeReport }: { state: AppSnapshot; action: Action; blocked: boolean; makeReport: () => Promise<void> }) {
  const { t } = useTranslation();
  const reports = orderedReports(state.reports, state.active?.id);
  const [selected, setSelected] = useState<string>();
  const report = reports.find((item) => item.id === selected) || reports[0];
  return <section className={`page-body reports-page ${report ? 'reports-page-populated' : ''}`}><div className={report ? 'report-toolbar' : 'page-heading'}>{report ? <h1 className="sr-only">{t('reports')}</h1> : <div><p className="eyebrow">{t('reportEyebrow')}</p><h1>{t('reportsTitle')}</h1><p className="muted">{t('reportsIntro')}</p></div>}
      {reports.length > 1 ? <div className="report-picker"><label className="sr-only" htmlFor="report-picker">{t('reports')}</label><select id="report-picker" value={report?.id} onChange={(event) => setSelected(event.target.value)}>{reports.map((item) => <option key={item.id} value={item.id}>{t('revision')} {item.revision} · {formatDate(item.createdAt, state.language)}{item.status === 'stale' ? ` · ${t('stale')}` : ''}</option>)}</select></div> : null}
      <div className={report ? 'report-toolbar-actions' : 'stack-actions'}><button className={report ? 'secondary-button' : 'primary-button'} disabled={blocked || !state.active} onClick={() => { setSelected(undefined); void makeReport(); }}>{t('createReport')}</button><button className="text-button" onClick={() => void action('openReports')}>{t('openFolder')} ↗</button></div></div>
    {!reports.length ? <div className="empty-panel"><Owl /><p className="muted">{t('noReports')}</p></div> : null}
    {report ? <ReportView key={report.id} report={report} language={state.language} action={action} blocked={blocked} hasFeedback={state.feedback.some((item) => item.reportId === report.id)} /> : null}
  </section>;
}

function MetricTable({ metrics, language, label }: { metrics: Metric[]; language: Language; label: string }) {
  const { t } = useTranslation();
  return <div className="metrics-table" role="table" aria-label={label}>{metrics.map((metric) => <div className="metric-row" role="row" key={metric.key}><div role="cell"><strong>{t(metric.key, { defaultValue: metric.key.replaceAll('_', ' ') })}</strong><small>{t(metric.source)}{metric.note ? ` · ${localizedRecordText(metric.note, language)}` : ''}</small></div><span role="cell">{displayNumber(metric.value)} <small>{metric.unit}</small></span></div>)}</div>;
}

export function ReportView({ report, language, action, blocked, hasFeedback }: { report: Report; language: Language; action: Action; blocked: boolean; hasFeedback: boolean }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const availableMetrics = report.metrics.filter((metric) => metric.value !== null && Number.isFinite(metric.value));
  const missingMetrics = report.metrics.filter((metric) => metric.value === null || !Number.isFinite(metric.value));
  return <article className="report-document"><header className="report-header"><div><h2>{report.title}</h2><p className="report-meta">{t('revision')} {report.revision} · {formatDate(report.createdAt, language)}{report.basis ? <> · {t('source')}：{report.basis.source || t('self-report')}</> : null}</p></div>{report.status === 'stale' ? <span className="badge warning">{t('stale')}</span> : null}</header>
    <section className={`report-summary ${report.score === null ? 'report-summary-unscored' : ''}`}>{report.score !== null ? <div className="report-score"><span className="small muted">{t('score')}</span><strong>{displayNumber(report.score)}</strong><span className="small muted">/ 100 · {report.scoreVersion}</span></div> : null}<div><p className="section-label">{t('summary')}</p><p>{report.summary}</p>{report.score === null ? <p className="small muted score-note">{t(report.scoreVersion === 'unscored-v1' ? 'unvalidatedScore' : 'noScore')}</p> : null}</div></section>
    {report.aiInterpretation ? <section className="report-section report-ai"><h3>{t('ai')}</h3><p className="preserve-lines">{report.aiInterpretation}</p><p className="small muted">{t('disclaimer')}</p></section> : <p className="small muted ai-pending">{t('aiPending')}</p>}
    <section className="report-section action-section"><p className="section-label">{t('tonight')}</p><h3>{report.action}</h3><details className="action-feedback"><summary>{t('feedback')}</summary><label className="sr-only" htmlFor="feedback-note">{t('feedbackNote')}</label><textarea id="feedback-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('feedbackNote')} maxLength={2000} disabled={blocked} /><div className="feedback-buttons">{(['accepted', 'cannot', 'unhelpful', 'later'] as const).map((choice) => <button className="secondary-button" key={choice} disabled={blocked} onClick={() => void action('feedback', { reportId: report.id, choice, note })}>{t(choice)}</button>)}</div></details>{hasFeedback ? <p className="small success" role="status">{t('feedbackSaved')}</p> : null}</section>
    {report.basis ? <details className="report-section report-basis"><summary>{t('reportBasis')} <span className="small muted">{t('expand')}</span></summary><dl><div><dt>{t('scope')}</dt><dd>{t(report.basis.scope || 'main')}</dd></div><div><dt>{t('source')}</dt><dd>{report.basis.source || t('self-report')}</dd></div><div><dt>{t('startTime')}</dt><dd><time dateTime={report.basis.start}>{formatDate(report.basis.start, language)}</time></dd></div><div><dt>{t('endTime')}</dt><dd><time dateTime={report.basis.end}>{formatDate(report.basis.end, language)}</time></dd></div></dl></details> : null}
    <section className="report-section"><h3>{t('metrics')}</h3>{availableMetrics.length ? <MetricTable metrics={availableMetrics} language={language} label={t('metrics')} /> : <p className="small muted">{t('noMetrics')}</p>}
      {missingMetrics.length ? <details className="missing-metrics"><summary>{t('missingMetrics', { count: missingMetrics.length })}</summary><p className="small muted">{t('missingMetricsHint')}</p><MetricTable metrics={missingMetrics} language={language} label={t('missingMetrics', { count: missingMetrics.length })} /></details> : null}
    </section>
    <details className="report-section dimension-section"><summary>{t('dimensions')} <span className="small muted">{t('expand')}</span></summary><div className="dimension-grid">{report.dimensions.map((dimension) => <div className="dimension" key={dimension.key}><div className="dimension-heading"><strong>{t(dimension.key, { defaultValue: dimension.key })}</strong>{dimension.score !== null ? <span>{displayNumber(dimension.score)}</span> : null}</div><p className="small muted">{dimension.text}</p></div>)}</div></details>
    {report.timeline?.length ? <details className="report-section timeline-section"><summary>{t('timeline')} <span className="small muted">{t('expand')}</span></summary><p className="small muted">{t('timelineHint')}</p><div className="timeline-scroll"><table><thead><tr><th scope="col">{t('startTime')}</th><th scope="col">{t('endTime')}</th><th scope="col">{t('stage')}</th></tr></thead><tbody>{report.timeline.slice(0, 200).map((item, index) => <tr key={`${item.start}-${item.stage}-${index}`}><td><time dateTime={item.start} title={item.start}>{formatDate(item.start, language)}</time></td><td><time dateTime={item.end} title={item.end}>{formatDate(item.end, language)}</time></td><td>{t(`stage_${item.stage}`, { defaultValue: item.stage })}</td></tr>)}</tbody></table></div></details> : null}
    <section className="report-section"><h3>{t('limitations')}</h3><ul className="limitations">{report.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></section>
  </article>;
}
