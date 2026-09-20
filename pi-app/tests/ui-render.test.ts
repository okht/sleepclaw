import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { ConnectionPanel, ConversationEmpty, DeleteAnalysisDialog, DesktopTitlebar, HistoryItem, SidebarBrand, Welcome, ManualTargetForm, ReportsPanel, ReportView } from '../src/renderer/App';
import { i18n } from '../src/renderer/i18n';
import type { AppSnapshot, Report } from '../src/shared/types';

const action = async () => true;
const state: AppSnapshot = { language: 'zh', configured: false, messages: [], busy: false, investigations: [], facts: [], imports: [], candidates: [], reports: [], feedback: [] };

test('connection screen keeps API key outside a chat composer and supports local use', () => {
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ConnectionPanel, { state, action, pending: false, onDone: () => {}, onOffline: () => {} })));
  assert.match(html, /type="password"/);
  assert.match(html, /autocomplete="off"/i);
  assert.match(html, /先在本地体验/);
  assert.match(html, /owl-mark\.svg/);
  assert.doesNotMatch(html, /composer-input/);
  assert.match(html, /connection-form-heading/);
  assert.match(html, /连接你自己的模型/);
  assert.match(html, /class="ui-icon"/);
});

test('integrated titlebar reserves native controls and keeps preferences clickable', () => {
  const html = renderToStaticMarkup(createElement(DesktopTitlebar, null, createElement('button', null, 'EN')));
  assert.match(html, /desktop-titlebar/);
  assert.doesNotMatch(html, /owl-mark\.svg|SleepClaw|desktop-brand/);
  assert.match(html, /<button>EN<\/button>/);
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  assert.match(css, /--chrome-height:\s*40px/);
  assert.match(css, /\.desktop-titlebar\s*\{[^}]*titlebar-area-width[^}]*-webkit-app-region:\s*drag/);
  assert.match(css, /\.desktop-titlebar button\s*\{[^}]*-webkit-app-region:\s*no-drag/);
  assert.match(css, /\.desktop-titlebar\s*\{[^}]*background:\s*transparent[^}]*border:\s*0[^}]*box-shadow:\s*none/);
  assert.match(css, /\.desktop-titlebar\s*\{[^}]*justify-content:\s*flex-end/);
  assert.match(css, /\.app\s*\{[^}]*padding-top:\s*var\(--chrome-height\)/);
  assert.match(css, /\.connection-scroll\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/);
});

test('loading titlebar also omits the duplicate branding', () => {
  const html = renderToStaticMarkup(createElement(DesktopTitlebar));
  assert.equal(html, '<header class="desktop-titlebar"></header>');
});

test('history deletion is a separate named dialog trigger with busy protection', async () => {
  for (const language of ['zh', 'en'] as const) {
    await i18n.changeLanguage(language);
    const item = { id: 'synthetic-history', goal: 'Synthetic <sleep>', language, scope: 'main' as const, createdAt: '2026-09-21', revision: 1, status: 'collecting' as const };
    const render = (blocked: boolean) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(HistoryItem, {
      item, language, selected: true, blocked, onSelect: () => {}, onDelete: () => {},
    })));
    const html = render(false);
    assert.equal((html.match(/<button /g) || []).length, 2);
    assert.match(html, /aria-current="page"/);
    assert.match(html, /<\/button><button type="button" class="history-delete"/);
    assert.match(html, /aria-haspopup="dialog"/);
    assert.match(html, language === 'zh' ? /aria-label="删除分析：Synthetic &lt;sleep&gt;"/ : /aria-label="Delete conversation: Synthetic &lt;sleep&gt;"/);
    assert.doesNotMatch(html, /<sleep>/);
    for (const button of render(true).matchAll(/<button\b[^>]*>/g)) assert.match(button[0], /disabled=""/);
  }
  await i18n.changeLanguage('zh');
});

test('deletion dialog has bilingual scope, safe target text, explicit actions, and busy protection', async () => {
  for (const language of ['zh', 'en'] as const) {
    await i18n.changeLanguage(language);
    const item = { id: 'synthetic-history', goal: 'Synthetic <sleep>', language, scope: 'main' as const, createdAt: '2026-09-21', revision: 1, status: 'collecting' as const };
    const render = (blocked: boolean) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(DeleteAnalysisDialog, {
      item, blocked, onCancel: () => {}, onConfirm: async () => true,
    })));
    const html = render(false);
    assert.match(html, /<dialog[^>]+role="alertdialog"[^>]+aria-labelledby="[^"]+"[^>]+aria-describedby="[^"]+"/);
    assert.match(html, /Synthetic &lt;sleep&gt;/);
    assert.match(html, language === 'zh' ? /<h2[^>]*>删除「Synthetic &lt;sleep&gt;」这段分析？<\/h2>/ : /<h2[^>]*>Delete Synthetic &lt;sleep&gt;\?<\/h2>/);
    assert.equal((html.match(/Synthetic &lt;sleep&gt;/g) || []).length, 1);
    assert.doesNotMatch(html, /delete-dialog-goal/);
    assert.doesNotMatch(html, /<sleep>/);
    assert.match(html, language === 'zh' ? /个人档案和已导入的 Apple Health 数据会保留/ : /personal profile and imported Apple Health data will be kept/);
    assert.match(html, language === 'zh' ? /删除后无法恢复/ : /cannot be undone/);
    assert.match(html, language === 'zh' ? /聊天、本次睡眠的回答、报告和行动反馈/ : /conversation, answers for this sleep, reports, and action feedback/);
    const buttons = [...render(true).matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
    assert.equal(buttons.length, 2);
    assert.match(buttons[0], /delete-dialog-cancel/);
    assert.doesNotMatch(buttons[0], /disabled/);
    assert.match(buttons[1], /delete-dialog-confirm" disabled=""/);
  }
  await i18n.changeLanguage('zh');
});

test('history trash is revealed on row hover or keyboard focus, with a touch fallback and themed dialog', () => {
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.history-row \.history-delete\s*\{\s*opacity:\s*0;\s*pointer-events:\s*none/);
  assert.match(css, /\.history-row:hover \.history-delete, \.history-row:focus-within \.history-delete\s*\{\s*opacity:\s*1;\s*pointer-events:\s*auto/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)\s*\{[^}]*opacity:\s*1/);
  assert.match(css, /\.delete-dialog\s*\{[^}]*background:\s*var\(--surface\)[^}]*color:\s*var\(--text\)[^}]*-webkit-app-region:\s*no-drag/);
  assert.match(css, /\.delete-dialog::backdrop\s*\{/);
  const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  const history = source.slice(source.indexOf('export function HistoryItem'), source.indexOf('function useDesktopState'));
  assert.doesNotMatch(history, /window.confirm/);
});

test('dark atmosphere stays behind interaction layers and uses static warm and cool glows', () => {
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  const glow = css.match(/\.app::before\s*\{([^}]+)\}/)?.[1] ?? '';
  const texture = css.match(/\.app::after\s*\{([^}]+)\}/)?.[1] ?? '';
  for (const layer of [glow, texture]) {
    assert.match(layer, /pointer-events:\s*none/);
    assert.match(layer, /z-index:\s*-1/);
    assert.doesNotMatch(layer, /animation:/);
  }
  assert.match(glow, /var\(--ambient-warm\)/);
  assert.match(glow, /var\(--ambient-cool\)/);
  assert.equal((glow.match(/radial-gradient/g) || []).length, 3);
  assert.equal((texture.match(/radial-gradient/g) || []).length, 8);
  assert.match(texture, /background-size:\s*350px 200px/);
  assert.match(texture, /#00e5cc99/);
  assert.match(texture, /#ff4d4d66/);
  assert.doesNotMatch(texture, /url\(/);
  assert.match(css, /:root\[data-theme='light'\]\s*\{[^}]*--sky-opacity:\s*0/);
  const selection = css.match(/\.history-item\.active\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(selection, /background:\s*transparent/);
  assert.doesNotMatch(selection, /box-shadow|border-left/);
  assert.match(css, /\.history-item:not\(:disabled\):hover\s*\{\s*background:\s*var\(--accent-wash\);\s*\}/);
});

test('sidebar brand shares the large logo font and theme-aware gradient', () => {
  const html = renderToStaticMarkup(createElement(SidebarBrand));
  assert.match(html, /brand-wordmark/);
  assert.match(html, /SleepClaw/);
  assert.match(html, /owl-mark\.svg/);
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  const sidebar = css.match(/\.brand-wordmark\s*\{([^}]+)\}/)?.[1] ?? '';
  const wordmark = css.match(/\.connection-wordmark\s*\{([^}]+)\}/)?.[1] ?? '';
  const brand = css.match(/\.brand\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(brand, /position:\s*relative/);
  assert.match(brand, /top:\s*-48px/);
  for (const property of ['font-family', 'font-weight', 'letter-spacing', 'background']) {
    const declaration = new RegExp(`${property}:\\s*([^;]+)`);
    assert.ok(sidebar.match(declaration));
    assert.equal(sidebar.match(declaration)?.[1], wordmark.match(declaration)?.[1]);
  }
  assert.match(sidebar, /background-clip:\s*text/);
  assert.equal((css.match(/--brand-gradient:\s*linear-gradient/g) || []).length, 2);
});

test('welcome has one compact composer with an independent import action and editable starters in both languages', async () => {
  for (const language of ['zh', 'en'] as const) {
    await i18n.changeLanguage(language);
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(Welcome, {
      state: { ...state, language }, action, importFile: async () => {}, blocked: false, onStarted: () => {}, onConnect: () => {},
    })));
    assert.equal((html.match(/<form /g) || []).length, 1);
    assert.match(html, /for="sleep-goal"/);
    assert.match(html, /rows="2"/);
    assert.match(html, /type="button" class="import-button"/);
    assert.match(html, /class="goal-submit|class="primary-button goal-submit" disabled="" aria-label=/);
    assert.match(html, /class="starter-prompts" role="group" aria-label=/);
    assert.equal((html.match(/<option /g) || []).length, 3);
    assert.match(html, /class="welcome-offline"/);
    assert.match(html, language === 'zh' ? /睡醒还是累/ : /Still waking up tired/);
    assert.doesNotMatch(html, /starter_tired|welcomeOffline|welcome-import/);
  }
  await i18n.changeLanguage('zh');
});

test('busy welcome disables all actions while connected users do not see an offline prompt', () => {
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(Welcome, {
    state: { ...state, configured: true }, action, importFile: async () => {}, blocked: true, onStarted: () => {}, onConnect: () => {},
  })));
  for (const button of html.matchAll(/<button\b[^>]*>/g)) assert.match(button[0], /disabled=""/);
  assert.match(html, /<textarea[^>]*disabled=""/);
  assert.match(html, /<select[^>]*disabled=""/);
  assert.doesNotMatch(html, /class="welcome-offline"/);
});

const emptyConversationState: AppSnapshot = { ...state, active: { id: 'current', goal: 'Synthetic sleep', language: 'zh', scope: 'main', createdAt: '2026-09-21', revision: 3, status: 'reported' } };
const emptyConversationReport: Report = { id: 'report', investigationId: 'current', revision: 1, factRevision: 3, language: 'zh', createdAt: '2026-09-21', title: 'Synthetic report', summary: 'Synthetic summary', metrics: [], dimensions: [], score: null, scoreVersion: 'unscored-v1', limitations: [], action: '', status: 'complete', markdown: '' };
const renderEmptyConversation = (overrides: Partial<AppSnapshot>) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ConversationEmpty, {
  state: { ...emptyConversationState, ...overrides }, blocked: overrides.busy ?? false, onOpenData: () => {}, onOpenReports: () => {}, importFile: async () => {},
})));

test('empty conversations reflect only their own reports and never imply an AI analysis occurred', () => {
  const ready = renderEmptyConversation({ reports: [emptyConversationReport] });
  assert.match(ready, /报告已经好了，慢慢看/);
  assert.match(ready, /查看报告/);
  assert.doesNotMatch(ready, /AI 已|已完成 AI/);
  const unrelated = renderEmptyConversation({ reports: [{ ...emptyConversationReport, investigationId: 'another-sleep' }] });
  assert.doesNotMatch(unrelated, /报告已经好了/);
  assert.match(unrelated, /回看已填信息/);
  assert.match(unrelated, /本地报告/);
});

test('stale or superseded report facts cannot show a completed conversation state', () => {
  for (const report of [{ ...emptyConversationReport, status: 'stale' as const }, { ...emptyConversationReport, factRevision: 2 }]) {
    const html = renderEmptyConversation({ reports: [report] });
    assert.match(html, /信息变了，报告也该更新了/);
    assert.doesNotMatch(html, /报告已经好了/);
  }
});

test('busy empty conversations are neutral, have no mutation actions and translate into English', async () => {
  const busy = renderEmptyConversation({ busy: true, reports: [emptyConversationReport] });
  assert.match(busy, /正在整理这次的信息/);
  assert.doesNotMatch(busy, /<button|报告已经好了|AI 正在/);
  await i18n.changeLanguage('en');
  const english = renderEmptyConversation({ configured: true, language: 'en' });
  assert.match(english, /Add a thought below/);
  assert.match(english, /Review your information/);
  assert.doesNotMatch(english, /conversationEmpty|conversationLocal/);
  await i18n.changeLanguage('zh');
});

test('report rendering escapes model prose and shows stale and missing-data states', () => {
  const report: Report = {
    id: 'report-1', investigationId: 'sleep-1', revision: 1, factRevision: 2, language: 'zh', createdAt: '2026-09-21T12:00:00Z',
    title: 'Sleep report', summary: 'A partial result', metrics: [{ key: 'totalSleepMinutes', value: null, unit: 'min', source: 'derived' }],
    dimensions: [{ key: 'duration', score: null, text: 'Not enough data' }], score: null, scoreVersion: 'unscored-v1',
    limitations: ['Limited coverage'], action: 'Keep a short note', aiInterpretation: '<script>window.stolen = true</script>', status: 'stale', markdown: '<h1>DO NOT RENDER THIS RAW</h1>',
    basis: { start: '2026-09-20T23:00:00+08:00', end: '2026-09-21T07:00:00+08:00', source: 'Synthetic Watch', scope: 'main' },
    timeline: [{ start: '2026-09-20T23:00:00+08:00', end: '2026-09-20T23:30:00+08:00', stage: 'core' }],
  };
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ReportView, { report, language: 'zh', action, blocked: false, hasFeedback: false })));
  assert.match(html, /需要更新/);
  assert.match(html, /暂不评分/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /DO NOT RENDER THIS RAW/);
  assert.match(html, /设备估计睡眠时长/);
  assert.match(html, /Synthetic Watch/);
  assert.match(html, /睡眠时间线/);
  assert.match(html, /核心睡眠/);
  const header = html.indexOf('class="report-header"');
  const summary = html.indexOf('A partial result');
  const interpretation = html.indexOf('&lt;script&gt;');
  const actionPosition = html.indexOf('Keep a short note');
  const basis = html.indexOf('<details class="report-section report-basis">');
  const metrics = html.indexOf('设备估计睡眠时长');
  assert.ok(header < html.indexOf('Synthetic Watch') && html.indexOf('Synthetic Watch') < summary);
  assert.ok(summary < interpretation && interpretation < actionPosition);
  assert.ok(actionPosition < basis && basis < metrics);
  assert.match(html, /<details class="action-feedback">/);
  assert.doesNotMatch(html, /<details[^>]*open/);
});

test('reports lead with interpretation and available numbers while unavailable metrics stay collapsed', () => {
  const report: Report = {
    id: 'report-2', investigationId: 'sleep-1', revision: 1, factRevision: 1, language: 'zh', createdAt: '2026-09-21T12:00:00Z',
    title: 'Self-report', summary: 'Your account is available', metrics: [
      { key: 'totalSleepMinutes', value: null, unit: 'min', source: 'derived' },
      { key: 'selfReportedSleepMinutes', value: 390, unit: 'min', source: 'self-report' },
      { key: 'heartRateMean', value: null, unit: 'bpm', source: 'derived' },
    ],
    dimensions: [{ key: 'duration', score: null, text: 'From your account' }], score: null, scoreVersion: 'unscored-v1',
    limitations: ['Limited coverage'], action: 'One small action', aiInterpretation: 'A useful interpretation', status: 'complete', markdown: '',
  };
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ReportView, { report, language: 'zh', action, blocked: false, hasFeedback: false })));
  const missing = html.indexOf('<details class="missing-metrics">');
  assert.ok(missing > 0);
  assert.ok(html.indexOf('A useful interpretation') < html.indexOf('自述睡眠时长'));
  assert.ok(html.indexOf('自述睡眠时长') < missing);
  assert.ok(html.indexOf('记录心率均值') > missing);
  assert.match(html, /2 项指标暂无数据/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.doesNotMatch(html, /class="report-score"/);
  assert.match(html, />390 </);
  assert.match(html, /One small action/);
  assert.ok(html.indexOf('One small action') < html.indexOf('自述睡眠时长'));
});

test('existing reports show their title once and only offer a picker for multiple versions', () => {
  const report: Report = {
    id: 'report-compact', investigationId: 'sleep-compact', revision: 1, factRevision: 1, language: 'zh', createdAt: '2026-09-21T12:00:00Z',
    title: 'A single report title', summary: 'The useful summary', metrics: [], dimensions: [], score: null, scoreVersion: 'unscored-v1',
    limitations: [], action: 'The one action', status: 'complete', markdown: '',
  };
  const render = (reports: Report[]) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ReportsPanel, {
    state: { ...state, reports }, action, blocked: false, makeReport: async () => {},
  })));
  const single = render([report]);
  assert.equal((single.match(/A single report title/g) || []).length, 1);
  assert.doesNotMatch(single, /把睡眠看明白一点|看明白，再做一点改变|id="report-picker"/);
  assert.match(single, /class="report-toolbar"/);
  assert.match(single, /class="page-body reports-page reports-page-populated"/);
  const multiple = render([report, { ...report, id: 'report-older', revision: 2 }]);
  assert.match(multiple, /id="report-picker"/);
  assert.equal((multiple.match(/<option /g) || []).length, 2);
  assert.equal((multiple.match(/A single report title/g) || []).length, 1);
});

test('desktop layout contains page scrolling and leaves one active content scroll owner', () => {
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  assert.match(css, /html, body, #root\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.app\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/);
  assert.match(css, /\.workspace-content\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/);
  assert.match(css, /\.workspace-content-thread\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.thread-viewport\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/);
  assert.doesNotMatch(css, /\.timeline-scroll\s*\{[^}]*max-height/);
});

test('manual range entry exposes local timezone and requires a user-selected source', () => {
  const configuredState: AppSnapshot = { ...state, active: { id: 'sleep', goal: 'Look at an earlier sleep', language: 'zh', scope: 'main', createdAt: '2026-09-21', revision: 1, status: 'collecting' },
    imports: [{ id: 'import', name: 'export.xml', importedAt: '2026-09-21', recordCount: 2, duplicateCount: 0, sources: ['Watch A', 'Watch B'], warnings: [] }] };
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ManualTargetForm, { state: configuredState, action, blocked: false })));
  assert.equal((html.match(/type="datetime-local"/g) || []).length, 2);
  assert.match(html, new RegExp(Intl.DateTimeFormat().resolvedOptions().timeZone));
  assert.match(html, /<option value="" selected="">/);
  assert.match(html, /Watch A/);
  assert.match(html, /Watch B/);
  assert.match(html, /type="submit" disabled=""/);
});
