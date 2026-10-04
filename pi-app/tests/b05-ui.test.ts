import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { ChatPanel, ModelConnectionButton, RecoveryNotice, ReportView, ReportsPanel } from '../src/renderer/App';
import { i18n } from '../src/renderer/i18n';
import { errorKey } from '../src/renderer/ui-model';
import type { AppSnapshot, Report } from '../src/shared/types';

const active = { id: 'b05-ui', sleepEpisodeId: 'b05-ui', goal: 'Synthetic recovery', language: 'zh' as const, scope: 'main' as const, createdAt: '2026-10-04T00:00:00Z', revision: 3, status: 'reported' as const };
const report: Report = { id: 'b05-report', investigationId: active.id, sleepEpisodeId: active.id, revision: 1, factRevision: 3, language: 'zh', createdAt: active.createdAt, title: 'Synthetic local report', summary: 'Synthetic saved summary', metrics: [], dimensions: [], score: null, scoreVersion: 'unscored-v1', limitations: [], action: 'Synthetic action', status: 'complete', markdown: '' };
const base: AppSnapshot = { language: 'zh', configured: true, messages: [], busy: false, investigations: [active], active, facts: [], imports: [], candidates: [], reports: [report], feedback: [] };
const action = async () => true;
const makeReport = async () => {};
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));
const notice = (state: AppSnapshot, blocked = false) => render(createElement(RecoveryNotice, { state, action, blocked, makeReport, onConnect: () => {} }));

for (const language of ['zh', 'en'] as const) {
  for (const code of ['AUTH_FAILED', 'QUOTA', 'TIMEOUT', 'MODEL_NOT_FOUND', 'REPORT_NOT_SAVED']) test(`B05 ${language}: ${code} keeps local delivery and its reason visible`, async () => {
    await i18n.changeLanguage(language);
    const state = { ...base, language, notice: { kind: 'report-local' as const, code } };
    const html = notice(state);
    assert.match(html, /role="status"/);
    assert.ok(html.includes(i18n.t('localReportReady')));
    assert.ok(html.includes(i18n.t(`error_${code}`)));
    assert.ok(html.includes(i18n.t('createLocalReport')));
    assert.doesNotMatch(html, /Retry the follow-up only|只重试 AI 续问/);
    assert.equal(notice(JSON.parse(JSON.stringify(state))), html, 'a restored snapshot retains the notice');
  });

  test(`B05 ${language}: saved-answer failure gives separate retry and local routes without asking to submit again`, async () => {
    await i18n.changeLanguage(language);
    const html = notice({ ...base, language, notice: { kind: 'followup-failed', code: 'AUTH_FAILED' } });
    for (const key of ['answerSavedFollowupFailed', 'answerSavedFollowupHint', 'retryFollowup', 'continueLocal', 'createLocalReport']) assert.ok(html.includes(i18n.t(key)), key);
    assert.doesNotMatch(html, /<form|type="submit"/);
    const disabled = notice({ ...base, language, notice: { kind: 'followup-failed', code: 'AUTH_FAILED' } }, true);
    assert.equal((disabled.match(/<button/g) ?? []).length, (disabled.match(/<button[^>]*disabled=""/g) ?? []).length);
  });

  test(`B05 ${language}: disconnected recovery still offers local progress`, async () => {
    await i18n.changeLanguage(language);
    const html = notice({ ...base, language, configured: false, notice: { kind: 'followup-failed', code: 'MODEL_REQUIRED' } });
    assert.ok(html.includes(i18n.t('connectModel')));
    assert.match(html, new RegExp(`<button[^>]*disabled=""[^>]*>${i18n.t('retryFollowup')}`));
    const localButton = html.match(new RegExp(`<button[^>]*>${i18n.t('continueLocal')}</button>`))?.[0];
    assert.ok(localButton);
    assert.doesNotMatch(localButton, /disabled=/);
  });

  test(`B05 ${language}: saved AI report is retained without being labelled as a local fallback`, async () => {
    await i18n.changeLanguage(language);
    const html = notice({ ...base, language, notice: { kind: 'report-saved', code: 'QUOTA' } });
    assert.ok(html.includes(i18n.t('reportSavedInterrupted')));
    assert.doesNotMatch(html, /without AI interpretation|最新版本没有 AI 解读/);
    const view = render(createElement(ReportView, { report: { ...report, aiInterpretation: 'Synthetic preserved interpretation' }, language, action, blocked: false, hasFeedback: false }));
    assert.match(view, /Synthetic preserved interpretation/);
    assert.ok(!view.includes(i18n.t('aiPending')));
  });

  test(`B05 ${language}: local brief access remains available with and without model configuration`, async () => {
    await i18n.changeLanguage(language);
    for (const configured of [false, true]) {
      const state = { ...base, language, configured };
      const reports = render(createElement(ReportsPanel, { state, action, blocked: false, makeReport }));
      const chat = render(createElement(ChatPanel, { state, action, blocked: false, makeReport, delta: '', importFile: async () => {}, onConnect: () => {}, onOpenData: () => {}, onOpenReports: () => {} }));
      assert.ok(reports.includes(i18n.t('createLocalReport')));
      assert.ok(chat.includes(i18n.t('createLocalReport')));
      assert.ok(reports.includes(i18n.t('aiPending')));
    }
  });

  test(`B05 ${language}: local collection explains its mode and offers a way back`, async () => {
    await i18n.changeLanguage(language);
    const html = notice({ ...base, language, localCollection: true });
    assert.ok(html.includes(i18n.t('localCollectionHint')));
    assert.ok(html.includes(i18n.t('continueWithModel')));
    assert.doesNotMatch(html, /Reason:|原因：/);
    assert.equal(notice({ ...base, language, active: undefined, localCollection: true, notice: { kind: 'report-local', code: 'QUOTA' } }), '');
    assert.equal(notice({ ...base, language }), '');
  });

  test(`B05 ${language}: model failures replace the connected dot with a warning without discarding the model`, async () => {
    await i18n.changeLanguage(language);
    for (const code of ['AUTH_FAILED', 'QUOTA', 'TIMEOUT', 'TURN_LIMIT', 'REQUEST_FAILED', 'MODEL_NOT_FOUND']) {
      for (const kind of ['report-local', 'report-saved', 'followup-failed'] as const) {
        const state = { ...base, language, model: { provider: 'synthetic', model: 'Synthetic saved model' }, notice: { kind, code } };
        const html = render(createElement(ModelConnectionButton, { state, blocked: false, onConnect: () => {} }));
        assert.match(html, /class="status-dot warning"/);
        assert.doesNotMatch(html, /status-dot connected/);
        assert.ok(html.includes(i18n.t('modelConnectionWarning')));
        assert.ok(html.includes(i18n.t(errorKey(code))));
        assert.match(html, /Synthetic saved model/);
        assert.equal(state.configured, true);
      }
    }
  });

  test(`B05 ${language}: successful recovery, cancellation and local fallback do not show a connection fault`, async () => {
    await i18n.changeLanguage(language);
    for (const notice of [undefined, { kind: 'report-local' as const, code: 'REPORT_NOT_SAVED' }, { kind: 'followup-failed' as const, code: 'CANCELLED' }]) {
      const html = render(createElement(ModelConnectionButton, { state: { ...base, language, notice }, blocked: false, onConnect: () => {} }));
      assert.match(html, /class="status-dot connected"/);
      assert.doesNotMatch(html, /status-dot warning/);
      assert.ok(!html.includes(i18n.t('modelConnectionWarning')));
    }
    const disconnected = render(createElement(ModelConnectionButton, { state: { ...base, language, configured: false }, blocked: false, onConnect: () => {} }));
    assert.doesNotMatch(disconnected, /status-dot connected|status-dot warning/);
  });

  test(`B05 ${language}: processing-limit and stale-retry errors provide specific next steps`, async () => {
    await i18n.changeLanguage(language);
    for (const code of ['TURN_LIMIT', 'NO_PENDING_FOLLOWUP']) {
      assert.equal(errorKey(code), `error_${code}`);
      assert.notEqual(i18n.t(errorKey(code)), code);
      assert.notEqual(i18n.t(errorKey(code)), i18n.t('error_REQUEST_FAILED'));
    }
  });
}

test('B05 desktop transport includes report, follow-up and collection recovery actions', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const allowed = main.match(/const allowed = new Set\(\[([^\]]+)\]\)/)?.[1] ?? '';
  for (const method of ['reportLocal', 'retryFollowup', 'continueLocal', 'continueWithModel']) assert.ok(allowed.includes(`'${method}'`), method);
});
