import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { ChatPanel, ReportsPanel } from '../src/renderer/App';
import { i18n } from '../src/renderer/i18n';
import type { AppSnapshot, Investigation, Report } from '../src/shared/types';

const active: Investigation = { id: 'synthetic-b04', sleepEpisodeId: 'synthetic-b04', goal: 'Synthetic continuation', language: 'zh', scope: 'main', createdAt: '2026-10-04T00:00:00Z', revision: 3, status: 'reported' };
const report: Report = { id: 'synthetic-report', investigationId: active.id, sleepEpisodeId: active.id, revision: 1, factRevision: 3, language: 'zh', createdAt: '2026-10-04T00:00:00Z', title: 'Synthetic saved report', summary: 'Synthetic summary', metrics: [], dimensions: [], score: null, scoreVersion: 'unscored-v1', limitations: [], action: 'Synthetic action', status: 'complete', markdown: '' };
const base: AppSnapshot & { canResume?: boolean } = { language: 'zh', configured: false, messages: [], busy: false, investigations: [active], active, canResume: true, facts: [], imports: [], candidates: [], reports: [report], feedback: [] };
const action = async () => true;
const panel = (state = base, blocked = false) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ReportsPanel, { state, action, blocked, makeReport: async () => {} })));
const chat = (state = base, blocked = false) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ChatPanel, { state, action, blocked, delta: '', makeReport: async () => {}, importFile: async () => {}, onConnect: () => {}, onOpenData: () => {}, onOpenReports: () => {} })));

for (const language of ['zh', 'en'] as const) {
  const resume = language === 'zh' ? '继续补充' : 'Continue adding information';
  const complete = language === 'zh' ? '基础问题已处理完' : 'You have addressed all the basic questions';
  test(`B04 ${language}: early report offers local continuation without requiring a model`, async () => {
    await i18n.changeLanguage(language);
    const html = panel({ ...base, language });
    assert.match(html, new RegExp(`<button[^>]*>${resume}`));
    assert.match(html, /Synthetic saved report/);
    assert.doesNotMatch(html, new RegExp(complete));
  });
  test(`B04 ${language}: completed questions show a clear end state without offering repeated questions`, async () => {
    await i18n.changeLanguage(language);
    const html = panel({ ...base, language, canResume: false });
    assert.match(html, new RegExp(complete));
    assert.doesNotMatch(html, new RegExp(resume));
  });
  test(`B04 ${language}: an active question never duplicates a continuation prompt`, async () => {
    await i18n.changeLanguage(language);
    const html = panel({ ...base, language, question: { id: 'q', scope: 'sleep', topic: 'recovery', text: 'Synthetic current question' } });
    assert.doesNotMatch(html, new RegExp(`${resume}|${complete}`));
  });
  test(`B04 ${language}: busy continuation is disabled`, async () => {
    await i18n.changeLanguage(language);
    const html = panel({ ...base, language, busy: true }, true);
    assert.match(html, new RegExp(`<button[^>]*disabled=""[^>]*>${resume}`));
  });
  test(`B04 ${language}: unavailable legacy capability and no selected analysis do not claim completion`, async () => {
    await i18n.changeLanguage(language);
    for (const state of [{ ...base, language, canResume: undefined }, { ...base, language, active: undefined }]) {
      assert.doesNotMatch(panel(state), new RegExp(`${resume}|${complete}`));
    }
  });
  test(`B04 ${language}: chat continuation is available with or without model, messages, and a post-report correction`, async () => {
    await i18n.changeLanguage(language);
    for (const configured of [false, true]) for (const withMessages of [false, true]) for (const status of ['reported', 'collecting'] as const) {
      const html = chat({ ...base, language, configured, active: { ...active, status }, messages: withMessages ? [{ id: 'synthetic-message', role: 'assistant', text: 'Synthetic previous conversation' }] : [] });
      assert.match(html, new RegExp(`<button[^>]*>${resume}`), `${configured}/${withMessages}/${status}`);
      assert.doesNotMatch(html, new RegExp(complete));
    }
  });
  test(`B04 ${language}: completed chat offers review without repeating skipped questions`, async () => {
    await i18n.changeLanguage(language);
    const html = chat({ ...base, language, canResume: false });
    assert.match(html, new RegExp(complete));
    assert.match(html, language === 'zh' ? /回看已填信息/ : /Review your information/);
    assert.doesNotMatch(html, new RegExp(`${resume}|question-card`));
  });
  test(`B04 ${language}: current question wins over stale resume metadata in chat`, async () => {
    await i18n.changeLanguage(language);
    const html = chat({ ...base, language, question: { id: 'current', scope: 'sleep', topic: 'recovery', text: 'Synthetic active question' } });
    assert.match(html, /Synthetic active question/);
    assert.doesNotMatch(html, new RegExp(`${resume}|${complete}`));
  });
}

test('B04 desktop IPC accepts the local resume operation', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const allowed = source.match(/const allowed = new Set\(\[([^\]]+)\]\)/)?.[1] ?? '';
  assert.ok(allowed.includes("'resume'"), 'the actual desktop transport must forward continuation to the controller');
});
