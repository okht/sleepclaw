import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { ConnectionPanel, GlobalTaskProgress, InvestigationPlanView, ModelConnectionButton, ReportView, ReportsPanel, SubscriptionConnection } from '../src/renderer/App';
import { latestReportFeedback, progressText, errorKey } from '../src/renderer/ui-model';
import { i18n } from '../src/renderer/i18n';
import type { AppSnapshot, Feedback, Investigation, Report } from '../src/shared/types';

const active: Investigation = { id: 'ux-synthetic', sleepEpisodeId: 'ux-synthetic', goal: 'Synthetic UX task', language: 'zh', scope: 'main', createdAt: '2026-10-04T00:00:00Z', revision: 4, status: 'collecting' };
const report: Report = { id: 'ux-report', investigationId: active.id, sleepEpisodeId: active.id, revision: 1, factRevision: 4, language: 'zh', createdAt: active.createdAt, title: 'Synthetic report', summary: 'Synthetic summary', metrics: [], dimensions: [], score: null, scoreVersion: 'unscored-v1', limitations: [], action: 'Synthetic practical action', status: 'complete', markdown: '' };
const base: AppSnapshot = { language: 'zh', configured: false, messages: [], busy: false, investigations: [active], active, facts: [], imports: [], candidates: [], reports: [report], feedback: [] };
const action = async () => true;
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));

for (const language of ['zh', 'en'] as const) {
  for (const kind of ['configure', 'import', 'model', 'auth'] as const) test(`UX ${language}: ${kind} exposes global cancellation without requiring a connected model`, async () => {
    await i18n.changeLanguage(language);
    for (const configured of [false, true]) {
      const state = { ...base, language, busy: true, configured, task: { kind, cancellable: true } };
      const html = render(createElement(GlobalTaskProgress, { state, progress: '', action }));
      assert.ok(html.includes(i18n.t(`task_${kind}`)));
      assert.ok(html.includes(i18n.t('cancelTask')));
      assert.match(html, /role="status"/);
      if (kind === 'import') assert.ok(html.includes(i18n.t('cancelImportHint')));
    }
  });

  test(`UX ${language}: cancellation is not offered for idle or unspecified synchronous work`, async () => {
    await i18n.changeLanguage(language);
    for (const state of [{ ...base, language }, { ...base, language, busy: true }, { ...base, language, busy: false, task: { kind: 'model' as const, cancellable: true } }]) assert.equal(render(createElement(GlobalTaskProgress, { state, progress: 'sleep_report', action })), '');
    const html = render(createElement(GlobalTaskProgress, { state: { ...base, language, busy: true, task: { kind: 'model', cancellable: false } }, progress: 'sleep_report', action }));
    assert.doesNotMatch(html, /<button|sleep_report/);
    assert.ok(html.includes(progressText('sleep_report', language)));
  });

  for (const status of ['signed-out', 'signed-in', 'expired'] as const) test(`UX ${language}: subscription ${status} has the appropriate model and account actions`, async () => {
    await i18n.changeLanguage(language);
    const state = { ...base, language, subscription: { status, models: [{ id: 'other-model', name: 'Synthetic other model' }, { id: 'gpt-5.6-sol', name: 'Synthetic recommended model' }] } };
    const html = render(createElement(SubscriptionConnection, { state, action, pending: false, onDone: () => {} }));
    assert.ok(html.includes(i18n.t(`subscriptionStatus_${status}`)));
    assert.match(html, /<option[^>]*value="gpt-5\.6-sol"[^>]*selected=""/);
    assert.ok(html.includes(i18n.t(status === 'signed-in' ? 'useSubscription' : status === 'expired' ? 'reconnectSubscription' : 'loginSubscription')));
    assert.equal(html.includes(i18n.t('logoutSubscription')), status !== 'signed-out');
    assert.doesNotMatch(html, /<input[^>]*type="password"/);
  });

  test(`UX ${language}: subscription sign-in accepts an optional private callback while the login task is busy`, async () => {
    await i18n.changeLanguage(language);
    const state: AppSnapshot = { ...base, language, busy: true, task: { kind: 'auth', cancellable: true }, subscription: { status: 'signing-in', models: [{ id: 'gpt-5.6-sol', name: 'Synthetic model' }], canOpenBrowser: true, prompt: { message: 'Synthetic callback request' }, progress: 'Synthetic provider detail' } };
    const html = render(createElement(SubscriptionConnection, { state, action, pending: true, onDone: () => {} }));
    assert.match(html, /Synthetic callback request/);
    assert.ok(html.includes(i18n.t('reopenSubscriptionLogin')));
    assert.match(html, /<input[^>]*type="password"[^>]*autoComplete="off"/i);
    const input = html.match(/<input[^>]*>/)?.[0] ?? '';
    assert.doesNotMatch(input, /disabled=/);
    assert.match(input, /value=""/);
    assert.ok(html.includes(i18n.t('subscriptionCallbackPrivacy')));
    assert.doesNotMatch(html, /Synthetic provider detail/);
    const global = render(createElement(GlobalTaskProgress, { state, progress: 'Synthetic provider detail', action }));
    assert.ok(global.includes(i18n.t('cancelTask')));
    assert.doesNotMatch(global, /Synthetic provider detail/);
  });

  test(`UX ${language}: connection screen exposes both methods and keeps the selected subscription separate from API-key entry`, async () => {
    await i18n.changeLanguage(language);
    const state: AppSnapshot = { ...base, language, model: { provider: 'openai-codex', model: 'gpt-5.6-sol', authMode: 'chatgpt' }, subscription: { status: 'signed-in', models: [{ id: 'gpt-5.6-sol', name: 'Synthetic model' }] } };
    const html = render(createElement(ConnectionPanel, { state, action, pending: false, onDone: () => {}, onOffline: () => {} }));
    for (const key of ['chatgptSubscription', 'apiKeyConnection', 'useSubscription']) assert.ok(html.includes(i18n.t(key)));
    assert.doesNotMatch(html, /type="password"|api-key-form/);
    const expired = render(createElement(ModelConnectionButton, { state: { ...state, subscription: { ...state.subscription!, status: 'expired' } }, blocked: false, onConnect: () => {} }));
    assert.match(expired, /status-dot warning/);
    assert.ok(expired.includes(i18n.t('error_AUTH_REQUIRED')));
  });

  test(`UX ${language}: missing subscription models disable login rather than inventing an unsupported model`, async () => {
    await i18n.changeLanguage(language);
    const state: AppSnapshot = { ...base, language, subscription: { status: 'signed-out', models: [] } };
    const html = render(createElement(SubscriptionConnection, { state, action, pending: false, onDone: () => {} }));
    assert.ok(html.includes(i18n.t('subscriptionModelsUnavailable')));
    const button = html.match(new RegExp(`<button[^>]*>${i18n.t('loginSubscription')}`))?.[0];
    assert.ok(button);
    assert.match(button, /disabled=""/);
  });

  test(`UX ${language}: current plan shows understandable steps and completion states`, async () => {
    await i18n.changeLanguage(language);
    const investigation = { ...active, plan: { objective: 'Synthetic investigation objective', revision: active.revision, updatedAt: active.createdAt, steps: [
      { id: 'a', kind: 'query' as const, description: 'Synthetic coverage check', status: 'done' as const },
      { id: 'b', kind: 'clarify' as const, description: 'Synthetic useful question', status: 'pending' as const, reason: 'Synthetic relevant reason' },
      { id: 'c', kind: 'report' as const, description: 'Synthetic report step', status: 'blocked' as const },
    ] } };
    const html = render(createElement(InvestigationPlanView, { investigation }));
    assert.match(html, /<details[^>]*open=""/);
    for (const key of ['investigationPlan', 'planCurrent', 'planStep_done', 'planStep_pending', 'planStep_blocked']) assert.ok(html.includes(i18n.t(key)), key);
    for (const text of ['Synthetic investigation objective', 'Synthetic coverage check', 'Synthetic useful question', 'Synthetic relevant reason']) assert.ok(html.includes(text));
    assert.ok(!html.includes(i18n.t('planStaleHint')));
  });

  test(`UX ${language}: stale plan is retained with an explicit warning and starts collapsed`, async () => {
    await i18n.changeLanguage(language);
    const investigation = { ...active, plan: { objective: 'Synthetic old objective', revision: active.revision - 1, updatedAt: active.createdAt, steps: [{ id: 'a', kind: 'query' as const, description: 'Synthetic old step', status: 'pending' as const }] } };
    const html = render(createElement(InvestigationPlanView, { investigation }));
    assert.doesNotMatch(html, /<details[^>]*open=/);
    assert.ok(html.includes(i18n.t('planStaleHint')));
    assert.match(html, /Synthetic old step/);
    assert.equal(render(createElement(InvestigationPlanView, { investigation: active })), '');
    assert.equal(render(createElement(InvestigationPlanView, {})), '');
  });

  test(`UX ${language}: tool progress uses user-facing activity instead of internal tool names`, () => {
    for (const name of ['sleep_context', 'sleep_fact', 'sleep_question', 'sleep_target', 'sleep_data_query', 'sleep_health_analysis', 'sleep_report', 'sleep_feedback', 'sleep_plan', 'sleep_future_tool']) {
      const text = progressText(name, language);
      assert.ok(text.length > 3);
      assert.doesNotMatch(text, /sleep_/);
      assert.equal(/[\u3400-\u9fff]/.test(text), language === 'zh');
    }
    for (const source of ['Read 42 records', '已读取 42 条记录']) assert.equal(progressText(source, language), language === 'zh' ? '已读取 42 条记录' : 'Read 42 records');
  });

  for (const choice of ['accepted', 'cannot', 'unhelpful', 'later'] as const) test(`UX ${language}: saved ${choice} feedback exposes the choice and note and permits updates`, async () => {
    await i18n.changeLanguage(language);
    const latestFeedback: Feedback = { reportId: report.id, choice, note: 'Synthetic current constraint', createdAt: active.createdAt };
    const html = render(createElement(ReportView, { report, language, action, blocked: false, latestFeedback }));
    assert.ok(html.includes(i18n.t('currentFeedback', { choice: i18n.t(choice) })));
    assert.match(html, /Synthetic current constraint/);
    assert.ok(html.includes(i18n.t('updateFeedback')));
    assert.ok(html.includes(i18n.t('feedbackUpdateHint')));
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
    assert.match(html, new RegExp(`aria-pressed="true"[^>]*>${i18n.t(choice)}</button>`));
    assert.match(html, /<textarea[^>]*>Synthetic current constraint<\/textarea>/);
  });

  test(`UX ${language}: report selection only displays the latest feedback for its own report`, async () => {
    await i18n.changeLanguage(language);
    const feedback: Feedback[] = [
      { reportId: report.id, choice: 'accepted', note: 'OLD-SYNTHETIC-NOTE', createdAt: '2026-10-04T01:00:00Z' },
      { reportId: 'other-report', choice: 'cannot', note: 'OTHER-SYNTHETIC-NOTE', createdAt: '2026-10-04T04:00:00Z' },
      { reportId: report.id, choice: 'later', note: 'CURRENT-SYNTHETIC-NOTE', createdAt: '2026-10-04T03:00:00Z' },
      { reportId: report.id, choice: 'unhelpful', note: 'OLDER-SYNTHETIC-NOTE', createdAt: '2026-10-04T02:00:00Z' },
    ];
    const html = render(createElement(ReportsPanel, { state: { ...base, language, feedback }, action, blocked: false, makeReport: async () => {} }));
    assert.match(html, /CURRENT-SYNTHETIC-NOTE/);
    assert.doesNotMatch(html, /OLD-SYNTHETIC-NOTE|OTHER-SYNTHETIC-NOTE|OLDER-SYNTHETIC-NOTE/);
    assert.equal(latestReportFeedback(feedback, 'missing'), undefined);
  });

  test(`UX ${language}: an empty action has an explicit end state without an empty feedback form`, async () => {
    await i18n.changeLanguage(language);
    const html = render(createElement(ReportView, { report: { ...report, action: '  ' }, language, action, blocked: false }));
    assert.ok(html.includes(i18n.t('noFeasibleAction')));
    assert.ok(html.includes(i18n.t('noFeasibleActionHint')));
    assert.doesNotMatch(html, /action-feedback|feedback-note|feedback-buttons/);
  });

  test(`UX ${language}: deletion confirms reports, feedback, exports and history removal while preserving original files`, async () => {
    await i18n.changeLanguage(language);
    for (const key of ['deleteFactConfirm', 'deleteImportConfirm']) {
      const text = i18n.t(key, { name: 'synthetic.xml' });
      for (const word of language === 'zh' ? ['报告', '反馈', '导出', '聊天历史', '原始'] : ['reports', 'feedback', 'exported', 'conversation history', 'original']) assert.ok(text.includes(word), `${key}: ${word}`);
      assert.doesNotMatch(text, /标记为需要更新|will need a refresh/);
    }
    assert.equal(errorKey('IMPORT_CANCELLED'), 'error_IMPORT_CANCELLED');
    assert.ok(i18n.t('error_IMPORT_CANCELLED').includes(language === 'zh' ? '原有记录' : 'earlier records'));
  });
}

test('UX feedback and plan text are escaped when displayed', () => {
  const text = '<script>synthetic()</script>';
  const html = render(createElement(ReportView, { report, language: 'zh', action, blocked: false, latestFeedback: { reportId: report.id, choice: 'cannot', note: text, createdAt: active.createdAt } }));
  assert.match(html, /&lt;script&gt;synthetic\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
