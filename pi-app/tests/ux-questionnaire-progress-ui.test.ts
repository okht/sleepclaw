import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { QuestionnaireProgress } from '../src/renderer/App';
import { i18n } from '../src/renderer/i18n';
import type { AppSnapshot, CollectionProgress, Investigation, Language } from '../src/shared/types';

const active: Investigation = { id: 'synthetic-progress-ui', sleepEpisodeId: 'synthetic-progress-ui', goal: 'Synthetic questionnaire progress', language: 'zh', scope: 'main', createdAt: '2026-10-04T00:00:00Z', revision: 1, status: 'collecting' };
const base: AppSnapshot = { language: 'zh', configured: false, messages: [], busy: false, investigations: [active], active, facts: [], imports: [], candidates: [], reports: [], feedback: [] };
const progress = (completed: number, skipped = 0, phase: CollectionProgress['phase'] = 'basics'): CollectionProgress => ({ total: 14, completed, known: completed - skipped, skipped, remaining: 14 - completed, phase });
const render = (state: AppSnapshot) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QuestionnaireProgress, { state })));
const copy = {
  zh: { label: '基础问卷进度', basics: '基础信息', count: (count: number) => `已完成 ${count} / 14 项`, skipped: (count: number) => `${count} 项已跳过或不确定`,
    phases: { basics: '正在了解睡眠', ready: '基础信息已完成', followup: '补充了解', paused: '问卷已暂停', reported: '报告已生成' },
    hints: { basics: /还剩 \d+ 项基础信息，可跳过，也可随时生成报告/, ready: /基础问题已处理完，可以生成报告，也可以继续补充情况/,
      followup: /当前是补充问题，不计入基础题数/, paused: /已有进度已保存，需要时可以继续补充/, reported: /回看回答，或补充信息后更新报告/ } },
  en: { label: 'Basic questionnaire progress', basics: 'Basic information', count: (count: number) => `${count} / 14 completed`, skipped: (count: number) => `${count} skipped or uncertain`,
    phases: { basics: 'Getting to know your sleep', ready: 'Basics complete', followup: 'A follow-up question', paused: 'Questionnaire paused', reported: 'Report ready' },
    hints: { basics: /\d+ basic items left\. You can skip or create a report anytime/, ready: /Basic items are covered; you can create a report or add more context/,
      followup: /This follow-up is separate from the basic items/, paused: /Your progress is saved\. Resume whenever you want to add more/, reported: /revisit your answers or update this report anytime/ } },
};
function assertAccessibleValue(html: string, language: Language, completed: number) {
  const controls = [...html.matchAll(/<progress\b([^>]*)>/g)];
  assert.equal(controls.length, 1, 'one native determinate progress indicator');
  const attributes = new Map([...controls[0][1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
  assert.equal(attributes.get('max'), '14');
  assert.equal(attributes.get('value'), String(completed));
  assert.equal(attributes.get('aria-label'), copy[language].label);
  assert.equal(attributes.get('aria-valuetext'), copy[language].count(completed));
  assert.ok(html.includes(`<section class="questionnaire-progress" aria-label="${copy[language].label}">`));
  assert.ok(html.includes(`<strong>${copy[language].count(completed)}</strong>`), 'visible and accessible counts agree');
  assert.ok(html.includes(copy[language].basics));
  assert.doesNotMatch(html, /questionnaire(?:Phase|Hint|Count|Progress|Skipped)|\{\{/);
}

for (const language of ['zh', 'en'] as const) {
  test(`Questionnaire UI ${language}: no active investigation or unavailable progress hides the indicator`, async () => {
    await i18n.changeLanguage(language);
    for (const state of [
      { ...base, language },
      { ...base, language, active: undefined, collectionProgress: progress(0) },
      { ...base, language, active: undefined, investigations: [], collectionProgress: undefined },
    ]) assert.equal(render(state), '');
  });

  test(`Questionnaire UI ${language}: zero, partial and skipped answers have accurate visible and accessible counts`, async () => {
    await i18n.changeLanguage(language);
    for (const [completed, skipped] of [[0, 0], [1, 0], [7, 3], [13, 13]]) {
      const html = render({ ...base, language, collectionProgress: progress(completed, skipped) });
      assertAccessibleValue(html, language, completed);
      assert.match(html, copy[language].hints.basics);
      assert.ok(html.includes(language === 'zh' ? `还剩 ${14 - completed} 项基础信息` : `${14 - completed} basic items left`));
      if (skipped > 0) assert.ok(html.includes(copy[language].skipped(skipped)));
      else assert.doesNotMatch(html, language === 'zh' ? /项已跳过或不确定/ : /skipped or uncertain/);
      assert.ok(!html.includes(copy[language].phases.reported));
    }
  });

  test(`Questionnaire UI ${language}: ready, follow-up, paused and reported have distinct stage explanations`, async () => {
    await i18n.changeLanguage(language);
    for (const [phase, completed] of [['ready', 14], ['followup', 4], ['followup', 14], ['paused', 7], ['paused', 14], ['reported', 14]] as const) {
      const html = render({ ...base, language, collectionProgress: progress(completed, 0, phase) });
      assertAccessibleValue(html, language, completed);
      assert.ok(html.includes(`<span class="questionnaire-phase">${copy[language].phases[phase]}</span>`));
      assert.match(html, copy[language].hints[phase]);
      for (const otherPhase of ['basics', 'ready', 'followup', 'paused', 'reported'] as const) if (phase !== otherPhase) {
        assert.ok(!html.includes(`<span class="questionnaire-phase">${copy[language].phases[otherPhase]}</span>`));
      }
      assert.equal(html.includes(copy[language].phases.reported), phase === 'reported', 'a full basic bar cannot imply that analysis or report generation has finished');
    }
  });

  test(`Questionnaire UI ${language}: 14 skipped answers and model activity never turn basic completion into a completed report`, async () => {
    await i18n.changeLanguage(language);
    for (const busy of [false, true]) {
      const html = render({ ...base, language, busy, task: busy ? { kind: 'model', cancellable: true } : undefined, collectionProgress: progress(14, 14, 'ready') });
      assertAccessibleValue(html, language, 14);
      assert.ok(html.includes(copy[language].skipped(14)));
      assert.ok(html.includes(copy[language].phases.ready));
      assert.match(html, copy[language].hints.ready);
      assert.ok(!html.includes(copy[language].phases.reported));
      assert.doesNotMatch(html, /分析已完成|全部分析完成|Analysis complete|All analysis complete/i);
    }
  });
}
