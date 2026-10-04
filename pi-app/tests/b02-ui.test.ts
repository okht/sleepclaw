import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { ConversationEmpty, ReportsPanel } from '../src/renderer/App';
import { i18n } from '../src/renderer/i18n';
import { reportsForEpisode } from '../src/shared/episode';
import type { AppSnapshot, Investigation, Report } from '../src/shared/types';

const active: Investigation = { id: 'investigation', sleepEpisodeId: 'night-b', goal: 'Synthetic sleep', language: 'zh', scope: 'main', createdAt: '2026-01-01', revision: 9, status: 'collecting', start: '2026-01-02T23:00:00Z', end: '2026-01-03T07:00:00Z', source: 'Watch' };
const reportA: Report = { id: 'report-a', investigationId: active.id, sleepEpisodeId: active.id, revision: 1, factRevision: 3, language: 'zh', createdAt: '2026-01-04', title: 'OLD_NIGHT_A', summary: 'OLD_SYMPTOM_A', metrics: [], dimensions: [], score: null, scoreVersion: 'unscored-v1', limitations: [], action: '', status: 'stale', markdown: '', basis: { start: '2026-01-01T23:00:00Z', end: '2026-01-02T07:00:00Z', scope: 'main', source: 'Watch' } };
const reportB: Report = { ...reportA, id: 'report-b', sleepEpisodeId: 'night-b', title: 'CURRENT_NIGHT_B', summary: 'CURRENT_SUMMARY_B', createdAt: '2026-01-03', factRevision: 9, status: 'complete', basis: { start: active.start, end: active.end, scope: active.scope, source: active.source } };
const state: AppSnapshot = { language: 'zh', configured: false, messages: [], busy: false, active, investigations: [active], facts: [], imports: [], candidates: [], reports: [], feedback: [] };
const action = async () => true;

for (const language of ['zh', 'en'] as const) test(`B02 ${language}: report panel and conversation status follow selected sleep`, async () => {
  await i18n.changeLanguage(language);
  const render = (reports: Report[], current = active) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ReportsPanel, {
    state: { ...state, active: current, language, reports }, action, blocked: false, makeReport: async () => {},
  })));
  const empty = render([reportA]);
  assert.doesNotMatch(empty, /OLD_NIGHT_A|OLD_SYMPTOM_A|report-document/);
  assert.match(empty, language === 'zh' ? /还没有报告/ : /No report yet/);
  const current = render([reportA, reportB, { ...reportB, id: 'foreign', investigationId: 'other', title: 'FOREIGN_REPORT' }]);
  assert.match(current, /CURRENT_NIGHT_B/);
  assert.doesNotMatch(current, /OLD_NIGHT_A|OLD_SYMPTOM_A|FOREIGN_REPORT|report-picker/);
  const returned = render([reportA, reportB], { ...active, sleepEpisodeId: active.id });
  assert.match(returned, /OLD_NIGHT_A/);
  assert.doesNotMatch(returned, /CURRENT_NIGHT_B/);
  const conversation = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ConversationEmpty, {
    state: { ...state, language, reports: [reportA] }, blocked: false, onOpenData: () => {}, onOpenReports: () => {}, importFile: async () => {},
  })));
  assert.doesNotMatch(conversation, /报告已经好了|信息变了|report is ready|report needs a fresh/);
  await i18n.changeLanguage('zh');
});

test('B02 legacy reports require initial episode and matching time/scope before reuse', () => {
  const legacy = { ...reportB, sleepEpisodeId: undefined };
  assert.deepEqual(reportsForEpisode([legacy], active), []);
  const migrated = { ...active, sleepEpisodeId: active.id };
  assert.deepEqual(reportsForEpisode([legacy], migrated).map(r => r.id), [legacy.id]);
  assert.deepEqual(reportsForEpisode([{ ...reportA, sleepEpisodeId: undefined }], migrated), []);
  assert.deepEqual(reportsForEpisode([legacy], { ...migrated, scope: 'nap' }), []);
  assert.deepEqual(reportsForEpisode([legacy], { ...migrated, source: 'Phone' }).map(r => r.id), [legacy.id]);
  assert.deepEqual(reportsForEpisode([legacy]), []);
});

test('B02 legacy self-report-only reports stay usable only before a device window is chosen', () => {
  const legacy = { ...reportA, sleepEpisodeId: undefined, basis: { scope: 'main' as const } };
  const untargeted = { ...active, sleepEpisodeId: active.id, start: undefined, end: undefined };
  assert.deepEqual(reportsForEpisode([legacy], untargeted).map(r => r.id), [legacy.id]);
  assert.deepEqual(reportsForEpisode([{ ...legacy, basis: undefined }], untargeted), []);
  assert.deepEqual(reportsForEpisode([legacy], { ...active, sleepEpisodeId: active.id }), []);
});
