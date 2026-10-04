import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { SleepApp } from '../src/controller';
import { ConversationEmpty, ReportsPanel } from '../src/renderer/App';
import { i18n } from '../src/renderer/i18n';
import { createSleepTools } from '../src/tools';
import type { AppSnapshot, Investigation, Report } from '../src/shared/types';

// All records and statements are synthetic. Expected ownership is stated by each
// scenario, independent of the production report-filtering implementation.
const first = { start: '2026-09-01T23:00:00.000Z', end: '2026-09-02T07:00:00.000Z', source: 'SYNTHETIC_WATCH_A' };
const second = { start: '2026-09-02T23:00:00.000Z', end: '2026-09-03T07:00:00.000Z', source: 'SYNTHETIC_WATCH_B' };
function investigation(id: string, episode = id): Investigation {
  return { id, sleepEpisodeId: episode, goal: `GOAL_${id}`, language: 'en', scope: 'main', createdAt: '2026-09-01T00:00:00.000Z', revision: 3, status: 'collecting', ...first };
}
function report(id: string, owner: Investigation, overrides: Partial<Report> = {}): Report {
  return { id, investigationId: owner.id, sleepEpisodeId: owner.sleepEpisodeId, revision: 1, factRevision: owner.revision, language: 'en',
    createdAt: '2026-09-04T12:00:00.000Z', title: `TITLE_${id}`, summary: `SUMMARY_${id}`, metrics: [], dimensions: [], score: null,
    scoreVersion: 'unscored-v1', limitations: [], action: `ACTION_${id}`, status: 'complete', markdown: '',
    basis: { start: owner.start, end: owner.end, source: owner.source, scope: owner.scope }, ...overrides };
}
function snapshot(active?: Investigation, reports: Report[] = []): AppSnapshot {
  return { language: 'en', active, investigations: active ? [active] : [], configured: false, messages: [], busy: false,
    facts: [], imports: [], candidates: [], reports, feedback: [] };
}
const action = async () => true;
function panel(state: AppSnapshot): string {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ReportsPanel, { state, action, blocked: false, makeReport: async () => {} })));
}
function conversation(state: AppSnapshot): string {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ConversationEmpty, {
    state, blocked: false, onOpenData: () => {}, onOpenReports: () => {}, importFile: async () => {},
  })));
}
function optionIds(html: string): string[] { return [...html.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]); }
function visibleWithoutDetails(html: string): string { return html.replace(/<details\b[\s\S]*?<\/details>/g, ''); }

for (const language of ['zh', 'en'] as const) {
  test(`B03 ${language}: A has a report, newly created B stays empty and does not advertise A as ready`, async () => {
    await i18n.changeLanguage(language);
    const a = investigation('A'), b = investigation('B');
    const state = { ...snapshot(b, [report('FOREIGN_A', a)]), language, investigations: [a, b] };
    const html = panel(state);
    assert.doesNotMatch(html, /TITLE_FOREIGN_A|SUMMARY_FOREIGN_A|ACTION_FOREIGN_A|report-document|report-picker/);
    assert.match(html, language === 'zh' ? /还没有报告/ : /No report yet/);
    assert.doesNotMatch(conversation(state), /报告已经好了|信息变了|report is ready|report needs a fresh/);
    assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>(?:生成报告|Create report)<\/button>/, 'B can create its own report');
  });

  test(`B03 ${language}: unselected or draft report view cannot fall back to another investigation`, async () => {
    await i18n.changeLanguage(language);
    const a = investigation('A');
    const state = { ...snapshot(undefined, [report('UNSELECTED_A', a)]), language, investigations: [a] };
    const html = panel(state);
    assert.doesNotMatch(html, /TITLE_UNSELECTED_A|SUMMARY_UNSELECTED_A|ACTION_UNSELECTED_A|report-document|report-picker/);
    assert.match(html, /empty-panel/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>(?:生成报告|Create report)<\/button>/);
    assert.doesNotMatch(conversation(state), /报告已经好了|信息变了|report is ready|report needs a fresh/);
  });

  test(`B03 ${language}: report owner and its own sleep basis are visible before expanding details`, async () => {
    await i18n.changeLanguage(language);
    const current = { ...investigation('CURRENT_OWNER'), start: '2026-09-01T23:15:00.000Z', source: second.source };
    const stale = report('OLDER_VERSION', current, { status: 'stale', factRevision: 1,
      basis: { ...first, scope: 'main' } });
    const html = visibleWithoutDetails(panel({ ...snapshot(current, [stale]), language }));
    assert.match(html, /GOAL_CURRENT_OWNER/);
    assert.match(html, /SYNTHETIC_WATCH_A/, 'historical version shows its original source');
    assert.match(html, new RegExp(first.start.replace(/\./g, '\\.')));
    assert.doesNotMatch(html, /SYNTHETIC_WATCH_B/, 'current target must not relabel a saved report');
    assert.match(html, language === 'zh' ? /主要睡眠/ : /Main sleep/);
  });

  test(`B03 ${language}: feedback confirmation belongs to the displayed report only`, async () => {
    await i18n.changeLanguage(language);
    const a = investigation('A'), b = investigation('B');
    const own = report('OWN_B', b), foreign = report('FOREIGN_A', a);
    const state = { ...snapshot(b, [own, foreign]), language, feedback: [{ reportId: foreign.id, choice: 'accepted' as const, note: 'FOREIGN_FEEDBACK_NOTE', createdAt: first.start }] };
    const savedText = language === 'zh' ? /已保存的反馈：我愿意试试/ : /Saved response: I’ll try it/;
    assert.doesNotMatch(panel(state), savedText);
    assert.doesNotMatch(panel(state), /FOREIGN_FEEDBACK_NOTE|aria-pressed="true"/);
    state.feedback.push({ reportId: own.id, choice: 'accepted', note: 'OWN_FEEDBACK_NOTE', createdAt: first.start });
    const html = panel(state);
    assert.match(html, savedText);
    assert.match(html, /OWN_FEEDBACK_NOTE/);
    assert.doesNotMatch(html, /FOREIGN_FEEDBACK_NOTE/);
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  });
}

test('B03 mixed investigations and episodes expose only current report versions in newest-first order', async () => {
  await i18n.changeLanguage('en');
  const a = investigation('A'), b = investigation('B', 'B_NIGHT_2');
  const own1 = report('B_VERSION_1', b, { createdAt: '2026-09-01T12:00:00.000Z', revision: 1 });
  const own2 = report('B_VERSION_2', b, { createdAt: '2026-09-03T12:00:00.000Z', revision: 2 });
  const own3 = report('B_VERSION_3', b, { createdAt: '2026-09-04T12:00:00.000Z', revision: 3 });
  const foreign = [report('OTHER_OWNER', a), report('OLD_EPISODE', investigation('B')), report('COLLIDING_EPISODE', { ...a, sleepEpisodeId: b.sleepEpisodeId })];
  for (const reports of [[own1, ...foreign, own3, own2], [own2, own3, ...foreign.reverse(), own1]]) {
    const html = panel(snapshot(b, reports));
    assert.deepEqual(optionIds(html), ['B_VERSION_3', 'B_VERSION_2', 'B_VERSION_1']);
    assert.match(html, /TITLE_B_VERSION_3/);
    assert.doesNotMatch(html, /OTHER_OWNER|OLD_EPISODE|COLLIDING_EPISODE/);
  }
});

test('B03 equal-timestamp versions choose the highest revision regardless of storage order', async () => {
  await i18n.changeLanguage('en');
  const owner = investigation('A');
  const oldest = report('SAME_TIME_1', owner, { revision: 1 });
  const newest = report('SAME_TIME_3', owner, { revision: 3 });
  const middle = report('SAME_TIME_2', owner, { revision: 2 });
  for (const reports of [[oldest, newest, middle], [middle, oldest, newest]]) {
    const html = panel(snapshot(owner, reports));
    assert.deepEqual(optionIds(html), [newest.id, middle.id, oldest.id]);
    assert.match(html, /TITLE_SAME_TIME_3/);
  }
});

test('B03 newest stale report remains visible with its refresh warning instead of reverting to an older complete report', async () => {
  await i18n.changeLanguage('en');
  const owner = investigation('A');
  const older = report('OLDER_COMPLETE', owner, { createdAt: '2026-09-01T12:00:00.000Z', revision: 1 });
  const newer = report('NEWER_STALE', owner, { revision: 2, status: 'stale', factRevision: 1 });
  const html = panel(snapshot(owner, [older, newer]));
  assert.match(html, /TITLE_NEWER_STALE/);
  assert.doesNotMatch(html, /TITLE_OLDER_COMPLETE/);
  assert.match(html, /Needs refresh/);
});

const legacyCases: Array<{ name: string; current: Investigation; saved: Partial<Report>; visible: boolean }> = [
  { name: 'matching initial episode and explicit basis', current: investigation('A'), saved: {}, visible: true },
  { name: 'missing basis', current: investigation('A'), saved: { basis: undefined }, visible: false },
  { name: 'another investigation despite identical times', current: investigation('B'), saved: {}, visible: false },
  { name: 'another episode in the same investigation', current: investigation('A', 'A_NIGHT_2'), saved: {}, visible: false },
  { name: 'different time in an initial episode', current: { ...investigation('A'), ...second }, saved: {}, visible: false },
  { name: 'different sleep scope', current: { ...investigation('A'), scope: 'nap' }, saved: {}, visible: false },
  { name: 'source correction with unchanged sleep identity', current: { ...investigation('A'), source: 'Synthetic corrected source' }, saved: {}, visible: true },
];
for (const scenario of legacyCases) test(`B03 legacy display: ${scenario.name}`, async () => {
  await i18n.changeLanguage('en');
  const saved = report('LEGACY', investigation('A'), { sleepEpisodeId: undefined, ...scenario.saved });
  const html = panel(snapshot(scenario.current, [saved]));
  assert.equal(html.includes('TITLE_LEGACY'), scenario.visible);
  assert.equal(html.includes('class="report-document"'), scenario.visible);
});

test('B03 seeded generalization: 24 independently owned sleep contexts stay isolated across 192 shuffled report histories', async () => {
  await i18n.changeLanguage('en');
  let seed = 303_2026;
  function shuffled<T>(items: T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const j = seed % (i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  const contexts: Array<{ owner: Investigation; expected: string[] }> = [];
  const history: Report[] = [];
  for (let owner = 0; owner < 12; owner++) {
    for (let episode = 0; episode < 2; episode++) {
      const current = { ...investigation(`OWNER_${owner}`, `EPISODE_${owner}_${episode}`),
        scope: (['main', 'nap', 'segment'] as const)[owner % 3], ...(episode ? second : first) };
      const expected = [3, 2, 1].map(version => `R_${owner}_${episode}_V${version}`);
      contexts.push({ owner: current, expected });
      history.push(...[1, 2, 3].map(version => report(`R_${owner}_${episode}_V${version}`, current, {
        revision: version, createdAt: version === 1 ? '2026-09-04T12:00:00.000Z' : '2026-09-05T12:00:00.000Z',
      })));
    }
  }
  // Unknown legacy provenance must not become visible merely because its timestamp is newer.
  history.push(report('UNATTRIBUTED', contexts[0].owner, { sleepEpisodeId: undefined, basis: undefined, createdAt: '2026-10-01T12:00:00.000Z' }));
  for (const { owner, expected } of contexts) {
    for (let permutation = 0; permutation < 8; permutation++) {
      const html = panel(snapshot(owner, shuffled(history)));
      assert.deepEqual(optionIds(html), expected, `${owner.id}/${owner.sleepEpisodeId}, permutation ${permutation}`);
      const summaries = [...html.matchAll(/SUMMARY_([A-Z0-9_]+)/g)].map(match => match[1]);
      assert.deepEqual(summaries, [expected[0]], 'exactly the selected latest report is rendered');
      assert.doesNotMatch(html, /UNATTRIBUTED/);
    }
  }
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-b03-'));
  const app = new SleepApp(home);
  return { home, app, cleanup: async () => { await app.close(); rmSync(home, { recursive: true, force: true }); } };
}

test('B03 real desktop API: A report, empty B, B report, return to A, restart and return to B retain their own summaries', async () => {
  await i18n.changeLanguage('en');
  const f = fixture();
  let restored: SleepApp | undefined;
  try {
    let state = await f.app.request('new', { goal: 'SYNTHETIC_A_JOURNEY' });
    const a = state.active!.id;
    await f.app.request('fact', { topic: 'recovery', scope: 'sleep', value: 'SYNTHETIC_A_RECOVERY' });
    state = await f.app.request('report');
    const firstReportId = state.reports[0].id;
    state = await f.app.request('new', { goal: 'SYNTHETIC_B_JOURNEY' });
    const b = state.active!.id;
    assert.doesNotMatch(panel(state), /SYNTHETIC_A_RECOVERY|report-document/);
    await f.app.request('fact', { topic: 'recovery', scope: 'sleep', value: 'SYNTHETIC_B_RECOVERY' });
    state = await f.app.request('report');
    assert.match(panel(state), /SYNTHETIC_B_RECOVERY/);
    assert.doesNotMatch(panel(state), /SYNTHETIC_A_RECOVERY/);
    state = await f.app.request('select', { id: a });
    assert.match(panel(state), /SYNTHETIC_A_RECOVERY/);
    assert.doesNotMatch(panel(state), /SYNTHETIC_B_RECOVERY/);
    restored = new SleepApp(f.home);
    assert.match(panel(restored.snapshot()), /SYNTHETIC_A_RECOVERY/);
    state = await restored.request('select', { id: b });
    assert.match(panel(state), /SYNTHETIC_B_RECOVERY/);
    assert.doesNotMatch(panel(state), /SYNTHETIC_A_RECOVERY/);
    assert.ok(state.reports.some(saved => saved.id === firstReportId), 'filtering preserves the stored A report');
  } finally { await restored?.close(); await f.cleanup(); }
});

test('B03 desktop feedback rejects a report from another investigation without changing either record', async () => {
  const f = fixture();
  try {
    await f.app.request('new', { goal: 'Synthetic A' });
    const reportA = (await f.app.request('report')).reports[0];
    await f.app.request('new', { goal: 'Synthetic B' });
    const before = f.app.snapshot();
    await assert.rejects(f.app.request('feedback', { reportId: reportA.id, choice: 'cannot', note: 'Wrong owner' }));
    assert.deepEqual(f.app.snapshot().feedback, before.feedback);
    assert.deepEqual(f.app.snapshot().reports, before.reports);
  } finally { await f.cleanup(); }
});

test('B03 desktop feedback rejects another episode and resumes when the report-owning episode is selected again', async () => {
  const f = fixture();
  try {
    await f.app.request('new', { goal: 'Synthetic episode feedback' });
    await f.app.request('target', first);
    const own = (await f.app.request('report')).reports[0];
    await f.app.request('target', second);
    await assert.rejects(f.app.request('feedback', { reportId: own.id, choice: 'accepted' }));
    assert.deepEqual(f.app.snapshot().feedback, []);
    await f.app.request('target', first);
    const state = await f.app.request('feedback', { reportId: own.id, choice: 'accepted' });
    assert.deepEqual(state.feedback.map(item => [item.reportId, item.choice]), [[own.id, 'accepted']]);
  } finally { await f.cleanup(); }
});

test('B03 current sleep keeps all feedback choices and still permits feedback on an older visible version', async () => {
  const f = fixture();
  try {
    await f.app.request('new', { goal: 'Synthetic current-report feedback' });
    const initial = (await f.app.request('report')).reports[0];
    await f.app.request('fact', { topic: 'recovery', scope: 'sleep', value: 'Synthetic revised recovery' });
    const state = await f.app.request('report');
    const current = state.reports.find(saved => saved.id !== initial.id)!;
    assert.ok(current);
    const choices = ['accepted', 'cannot', 'unhelpful', 'later'] as const;
    for (const choice of choices) await f.app.request('feedback', { reportId: current.id, choice, note: `Synthetic ${choice}` });
    await f.app.request('feedback', { reportId: initial.id, choice: 'later', note: 'Synthetic older-version feedback' });
    assert.deepEqual(f.app.snapshot().feedback.map(item => [item.reportId, item.choice]), [
      ...choices.map(choice => [current.id, choice]), [initial.id, 'later'],
    ]);
  } finally { await f.cleanup(); }
});

test('B03 a persisted missing active selection cannot submit feedback to a remaining historical report', async () => {
  const f = fixture();
  let restored: SleepApp | undefined;
  try {
    await f.app.request('new', { goal: 'Synthetic surviving report' });
    const own = (await f.app.request('report')).reports[0];
    writeFileSync(join(f.home, 'settings.json'), JSON.stringify({ language: 'en', activeId: 'synthetic-deleted-selection' }));
    restored = new SleepApp(f.home);
    assert.equal(restored.snapshot().active, undefined);
    await assert.rejects(restored.request('feedback', { reportId: own.id, choice: 'later' }));
    assert.deepEqual(restored.snapshot().feedback, []);
  } finally { await restored?.close(); await f.cleanup(); }
});

for (const bound of [false, true]) test(`B03 ${bound ? 'episode-bound' : 'external'} tool rejects foreign-episode feedback while accepting the visible episode`, async () => {
  const f = fixture();
  try {
    const id = f.app.store.createInvestigation('Synthetic tool feedback', 'en').id;
    f.app.store.setTarget(id, first);
    const old = f.app.store.buildReport(id);
    const current = f.app.store.setTarget(id, second);
    const own = f.app.store.buildReport(id);
    const tools = createSleepTools(f.app.store, bound ? { investigationId: () => id, episodeId: current.sleepEpisodeId } : {});
    const feedback = tools.find(tool => tool.name === 'sleep_feedback')!;
    const ownerArgs = bound ? {} : { investigationId: id };
    await assert.rejects(feedback.execute({ ...ownerArgs, reportId: old.id, choice: 'cannot' }));
    assert.deepEqual(f.app.snapshot().feedback, []);
    await feedback.execute({ ...ownerArgs, reportId: own.id, choice: 'later' });
    assert.deepEqual(f.app.snapshot().feedback.map(item => item.reportId), [own.id]);
  } finally { await f.cleanup(); }
});
