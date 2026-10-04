import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { FactEditor, FactRow, QuestionCard, ReportedFacts, ReportView } from '../src/renderer/App';
import { factDisplayValue } from '../src/renderer/ui-model';
import { i18n } from '../src/renderer/i18n';
import type { AppSnapshot, Fact, Report } from '../src/shared/types';

const active = { id: 'b06-ui', sleepEpisodeId: 'b06-ui', goal: 'Synthetic wording', language: 'zh' as const, scope: 'main' as const, createdAt: '2026-10-04T00:00:00Z', revision: 3, status: 'collecting' as const };
const base: AppSnapshot = { language: 'zh', configured: false, messages: [], busy: false, investigations: [active], active, facts: [], imports: [], candidates: [], reports: [], feedback: [] };
const fact: Fact = { id: 'b06-fact', investigationId: active.id, sleepEpisodeId: active.id, topic: 'sleep_duration_hours', scope: 'sleep', value: 6.5, status: 'known', revision: 1, updatedAt: active.createdAt };
const report: Report = { id: 'b06-report', investigationId: active.id, sleepEpisodeId: active.id, revision: 1, factRevision: 3, language: 'zh', createdAt: active.createdAt, title: 'Synthetic saved report', summary: 'Synthetic summary', metrics: [], dimensions: [], score: null, scoreVersion: 'unscored-v1', limitations: [], action: 'Synthetic action', status: 'complete', markdown: '' };
const action = async () => true;
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));

for (const language of ['zh', 'en'] as const) {
  for (const topic of ['sleep_duration_hours', 'remembered_awakenings']) test(`B06 ${language}: ${topic} accepts words, ranges and unknown replies at the initial input`, async () => {
    await i18n.changeLanguage(language);
    const state = { ...base, language, question: { id: 'synthetic-question', topic, scope: 'sleep' as const, text: 'Synthetic duration or awakening question' } };
    const html = render(createElement(QuestionCard, { state, action, blocked: false, makeReport: async () => {} }));
    assert.match(html, /<input[^>]*type="text"/);
    assert.doesNotMatch(html, /type="number"|inputMode="decimal"|min="0"/);
    assert.ok(html.includes(i18n.t('numericAnswerHint')));
    assert.ok(html.includes(i18n.t(topic === 'sleep_duration_hours' ? 'hoursPlaceholder' : 'countPlaceholder')));
  });

  for (const [label, saved] of [
    ['exact', fact],
    ['range', { ...fact, value: '六到七小时', uncertainty: { kind: 'range', original: '六到七小时', lower: 6, upper: 7, unit: 'hours' } }],
    ['approximate', { ...fact, value: '大概 7 小时', uncertainty: { kind: 'approximate', original: '大概 7 小时' } }],
    ['unknown wording', { ...fact, value: null, status: 'unknown', uncertainty: { kind: 'uncertain', original: '记不清，也许半夜醒过' } }],
    ['skipped', { ...fact, value: null, status: 'unknown' }],
  ] as Array<[string, Fact]>) test(`B06 ${language}: ${label} can be corrected using the original words`, async () => {
    await i18n.changeLanguage(language);
    const html = render(createElement(FactEditor, { fact: saved, action, blocked: false, onDone: () => {} }));
    assert.match(html, /<input[^>]*type="text"/);
    assert.doesNotMatch(html, /type="number"/);
    const expected = saved.uncertainty?.original || String(saved.value ?? '');
    assert.ok(html.includes(`value="${expected}"`));
    const row = render(createElement(FactRow, { fact: saved, action, blocked: false }));
    assert.ok(row.includes(factDisplayValue(saved, i18n.t('unknown'))));
    if (saved.uncertainty) assert.ok(row.includes(i18n.t(`uncertainty_${saved.uncertainty.kind}`)));
  });

  test(`B06 ${language}: report recap exposes core and custom facts without hiding uncertainty`, async () => {
    await i18n.changeLanguage(language);
    const facts: Fact[] = [
      { ...fact, value: '六到七小时', uncertainty: { kind: 'range', original: '六到七小时', lower: 6, upper: 7, unit: 'hours' } },
      { ...fact, id: 'recovery', topic: 'recovery', value: '醒来还是累' },
      { ...fact, id: 'custom', topic: 'room_noise', value: '楼下施工，半夜被吵醒' },
      { ...fact, id: 'unknown', topic: 'remembered_awakenings', value: null, status: 'unknown', uncertainty: { kind: 'uncertain', original: '记不清醒了几次' } },
    ];
    const html = render(createElement(ReportView, { report: { ...report, reportedFacts: facts }, language, action, blocked: false, hasFeedback: false }));
    for (const phrase of ['六到七小时', '醒来还是累', 'room_noise', '楼下施工，半夜被吵醒', '记不清醒了几次']) assert.ok(html.includes(phrase), phrase);
    assert.ok(html.includes(i18n.t('reportedFactsHint')));
    assert.doesNotMatch(html, /390|6\.5/);
  });

  test(`B06 ${language}: historical report without a fact snapshot never borrows live facts`, async () => {
    await i18n.changeLanguage(language);
    assert.equal(render(createElement(ReportedFacts, { language })), '');
    const empty = render(createElement(ReportedFacts, { language, facts: [] }));
    assert.ok(empty.includes(i18n.t('noReportedFacts')));
    const old = render(createElement(ReportView, { report, language, action, blocked: false, hasFeedback: false }));
    assert.ok(!old.includes(i18n.t('reportedFacts')));
  });
}

test('B06 factual wording remains text when rendering custom and uncertain content', () => {
  const wording = '<img src=x onerror=alert(1)> & synthetic';
  const html = render(createElement(ReportedFacts, { language: 'en', facts: [{ ...fact, topic: 'custom_fact', value: wording, uncertainty: { kind: 'uncertain', original: wording } }] }));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; synthetic/);
  assert.doesNotMatch(html, /<img src=x/);
});
