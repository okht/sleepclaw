import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { SleepStore } from '../src/domain/index.js';
import { createSleepTools, safeToolError, sleepContext } from '../src/tools.js';
import type { Feedback, Question } from '../src/shared/types.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-ux-domain-'));
  let store = new SleepStore(home);
  return { home, get store() { return store; }, reopen() { store.close(); store = new SleepStore(home); },
    cleanup() { store.close(); assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); rmSync(home, { recursive: true, force: true }); } };
}
const target = (day: number) => ({ start: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`, end: `2026-09-${String(day).padStart(2, '0')}T08:00:00Z`, source: 'Synthetic Watch' });

test('UX original action loop: rejecting both default and fallback stops adding repeated suggestions', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic action limits', 'zh').id;
    const initial = f.store.buildReport(id);
    f.store.recordFeedback(initial.id, 'cannot', 'Synthetic constraint A');
    const fallback = f.store.buildReport(id);
    assert.notEqual(fallback.action, initial.action);
    f.store.recordFeedback(fallback.id, 'unhelpful', 'Synthetic constraint B');
    const final = f.store.buildReport(id);
    assert.equal(final.action, '', 'do not reissue the already rejected fallback');
  } finally { f.cleanup(); }
});

test('UX original repeated question: the model cannot re-ask an answered topic without a specific clarification reason', async () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic known answer', 'en').id;
    f.store.setFact(id, { topic: 'sleep_duration_hours', scope: 'sleep', value: 7 });
    const question = createSleepTools(f.store, { investigationId: () => id }).find(tool => tool.name === 'sleep_question')!;
    await assert.rejects(question.execute({ topic: 'sleep_duration', scope: 'sleep', text: 'How many hours did you sleep?' }), /QUESTION_ALREADY_ANSWERED/);
  } finally { f.cleanup(); }
});

for (const language of ['zh', 'en'] as const) for (const choice of ['cannot', 'unhelpful', 'later'] as const) {
  test(`UX ${language}: repeated ${choice} feedback reaches a stable no-action report`, () => {
    const f = fixture();
    try {
      const id = f.store.createInvestigation('Synthetic stopping point', language).id;
      const first = f.store.buildReport(id);
      const originalRevision = f.store.getInvestigation(id).revision;
      f.store.recordFeedback(first.id, choice);
      const alternative = f.store.buildReport(id);
      f.store.recordFeedback(alternative.id, choice);
      const stopped = f.store.buildReport(id);
      assert.equal(stopped.action, '');
      assert.match(stopped.markdown, language === 'zh' ? /暂不新增行动建议/ : /No new action is suggested/);
      for (let retry = 0; retry < 3; retry++) assert.equal(f.store.buildReport(id).id, stopped.id);
      f.reopen(); assert.equal(f.store.buildReport(id).id, stopped.id);
      assert.equal(f.store.getInvestigation(id).revision, originalRevision, 'feedback does not alter facts or target revision');
      assert.equal(f.store.snapshot(id).reports.length, 3);
    } finally { f.cleanup(); }
  });
}

test('UX feedback changes are latest-wins and re-enabling an earlier action creates the latest report revision', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic changed feedback', 'en').id;
    const initial = f.store.buildReport(id);
    f.store.recordFeedback(initial.id, 'cannot');
    const fallback = f.store.buildReport(id);
    f.store.recordFeedback(fallback.id, 'cannot');
    const stopped = f.store.buildReport(id);
    f.store.recordFeedback(initial.id, 'accepted', 'Synthetic changed constraints');
    const restored = f.store.buildReport(id);
    assert.equal(restored.action, initial.action);
    assert.ok(restored.revision > stopped.revision, 'restored action must become the visible latest report');
    assert.notEqual(restored.id, initial.id);
    assert.equal(f.store.buildReport(id).id, restored.id);
    f.store.recordFeedback(restored.id, 'unhelpful');
    assert.equal(f.store.buildReport(id).action, '');
    f.store.recordFeedback(fallback.id, 'accepted');
    assert.equal(f.store.buildReport(id).action, fallback.action);
  } finally { f.cleanup(); }
});

test('UX feedback is isolated by investigation and episode and is restored only on returning to that sleep', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic first investigation', 'en').id;
    f.store.setTarget(id, target(1));
    const first = f.store.buildReport(id); f.store.recordFeedback(first.id, 'cannot');
    const fallback = f.store.buildReport(id); f.store.recordFeedback(fallback.id, 'cannot');
    assert.equal(f.store.buildReport(id).action, '');
    f.store.setTarget(id, target(2));
    assert.equal(f.store.buildReport(id).action, first.action, 'another night has its own feedback');
    const second = f.store.createInvestigation('Synthetic second investigation', 'en').id;
    f.store.setTarget(second, target(1));
    assert.equal(f.store.buildReport(second).action, first.action, 'another investigation has its own feedback');
    f.store.setTarget(id, target(1));
    assert.equal(f.store.buildReport(id).action, '');
    f.reopen(); assert.equal(f.store.buildReport(id).action, '');
  } finally { f.cleanup(); }
});

test('UX changing language does not revive a rejected built-in default or fallback suggestion', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic bilingual feedback', 'en').id;
    const initial = f.store.buildReport(id); f.store.recordFeedback(initial.id, 'cannot');
    f.store.setLanguage(id, 'zh');
    const chineseFallback = f.store.buildReport(id);
    assert.match(chineseFallback.action, /先不重复上次/);
    f.store.recordFeedback(chineseFallback.id, 'later');
    f.store.setLanguage(id, 'en');
    assert.equal(f.store.buildReport(id).action, '');
  } finally { f.cleanup(); }
});

test('UX novel AI actions remain possible, but whitespace or case changes do not revive a rejected action', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic action identity', 'en').id;
    const first = f.store.buildReport(id, undefined, 'Synthetic action: move the lamp.');
    f.store.recordFeedback(first.id, 'cannot');
    const fallback = f.store.buildReport(id, undefined, '  SYNTHETIC ACTION:   MOVE THE LAMP. ');
    assert.notEqual(fallback.action.toLowerCase(), first.action.toLowerCase());
    f.store.recordFeedback(fallback.id, 'unhelpful');
    assert.equal(f.store.buildReport(id, undefined, first.action).action, '');
    assert.equal(f.store.buildReport(id, undefined, 'Synthetic new action: record a feasible constraint.').action, 'Synthetic new action: record a feasible constraint.');
  } finally { f.cleanup(); }
});

for (const status of ['known', 'unknown'] as const) test(`UX ${status} facts reject repeated alias questions atomically while a specific clarification remains available`, async () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic clarification guard', 'en').id;
    f.store.setFact(id, { topic: 'recovery', scope: 'sleep', value: status === 'known' ? 'Synthetic tired feeling' : null, status });
    f.store.buildReport(id);
    const question = createSleepTools(f.store, { investigationId: () => id }).find(tool => tool.name === 'sleep_question')!;
    const before = f.store.snapshot(id);
    for (const reason of [undefined, '   ', 'clarify', 'confirmation', 'more information', '........', '12345678', 'Similar sleep durations can still feel different.']) {
      await assert.rejects(question.execute({ topic: 'waking_feeling', scope: 'sleep', text: 'Synthetic repeated question?', ...(reason === undefined ? {} : { reason }) }), /QUESTION_ALREADY_ANSWERED/, reason);
      assert.deepEqual(f.store.snapshot(id), before, 'a rejected question must not clear a pause or mutate report/fact state');
    }
    const clarified = await question.execute({ topic: 'wake_feeling', scope: 'sleep', text: 'Synthetic clarification: was the feeling present immediately after waking?', reason: 'Distinguish immediate waking recovery from later daytime tiredness.' }) as Question;
    assert.equal(clarified.topic, 'recovery');
    assert.match(clarified.reason!, /Distinguish/);
    f.store.buildReport(id); f.reopen();
    assert.deepEqual(f.store.resumeCollection(id), clarified, 'explicit clarification stays compatible with B04 pause and resume');
    f.store.answer(id, 'Synthetic clarified recovery');
    assert.equal(f.store.snapshot(id).facts.find(fact => fact.topic === 'recovery')!.value, 'Synthetic clarified recovery');
    assert.equal(safeToolError(new Error('QUESTION_ALREADY_ANSWERED')).code, 'QUESTION_ALREADY_ANSWERED');
  } finally { f.cleanup(); }
});

test('UX known-topic checks respect sleep versus profile scope and shared profile facts across investigations', async () => {
  const f = fixture();
  try {
    const first = f.store.createInvestigation('Synthetic first scope', 'en').id;
    f.store.setFact(first, { topic: 'recovery', scope: 'sleep', value: 'Synthetic single-night recovery' });
    const firstTool = createSleepTools(f.store, { investigationId: () => first }).find(tool => tool.name === 'sleep_question')!;
    await firstTool.execute({ topic: 'recovery', scope: 'profile', text: 'Synthetic habitual recovery?' });
    f.store.setFact(first, { topic: 'usual_schedule', scope: 'profile', value: 'Synthetic usual schedule' });
    const second = f.store.createInvestigation('Synthetic second scope', 'zh').id;
    const secondTool = createSleepTools(f.store, { investigationId: () => second }).find(tool => tool.name === 'sleep_question')!;
    await secondTool.execute({ topic: 'recovery', scope: 'sleep', text: 'Synthetic second-night recovery?' });
    await assert.rejects(secondTool.execute({ topic: 'usual_schedule', scope: 'profile', text: 'Synthetic repeat schedule?' }), /QUESTION_ALREADY_ANSWERED/);
  } finally { f.cleanup(); }
});

test('UX an unanswered topic or a new episode can be asked and explicit corrections need no repeated question', async () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic new information', 'en').id;
    f.store.setTarget(id, target(1));
    const tools = createSleepTools(f.store, { investigationId: () => id });
    const question = tools.find(tool => tool.name === 'sleep_question')!;
    const fact = tools.find(tool => tool.name === 'sleep_fact')!;
    await question.execute({ topic: 'sleep_duration', scope: 'sleep', text: 'Synthetic first duration?' });
    await fact.execute({ topic: 'sleep_duration_hours', scope: 'sleep', value: 7 });
    await fact.execute({ topic: 'sleep_duration', scope: 'sleep', value: 6.5 });
    assert.equal(f.store.snapshot(id).facts.find(item => item.topic === 'sleep_duration_hours')!.value, 6.5);
    f.store.setTarget(id, target(2));
    await question.execute({ topic: 'sleep_duration_hours', scope: 'sleep', text: 'Synthetic next-night duration?' });
    assert.equal(f.store.snapshot(id).question!.topic, 'sleep_duration_hours');
  } finally { f.cleanup(); }
});

test('UX fixed-seed feedback changes follow a per-action latest-choice oracle through new reports and reopen', () => {
  const f = fixture();
  try {
    const id = f.store.createInvestigation('Synthetic feedback sequence', 'en').id;
    const original = f.store.buildReport(id);
    f.store.recordFeedback(original.id, 'cannot');
    const fallback = f.store.buildReport(id);
    const choices: Feedback['choice'][] = ['accepted', 'cannot', 'unhelpful', 'later'];
    const latest = new Map<string, Feedback['choice']>([[original.action, 'cannot']]);
    let random = 57231;
    for (let step = 0; step < 64; step++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const report = (random & 0x100) === 0 ? original : fallback;
      const choice = choices[(random >>> 12) % choices.length];
      f.store.recordFeedback(report.id, choice, `Synthetic choice ${step}`);
      latest.set(report.action, choice);
      const rejected = (action: string) => latest.has(action) && latest.get(action) !== 'accepted';
      const expected = !rejected(original.action) ? original.action : !rejected(fallback.action) ? fallback.action : '';
      assert.equal(f.store.buildReport(id).action, expected, `step ${step}`);
      if (step % 8 === 7) f.reopen();
      const context = sleepContext(f.store, id) as { feedback: Feedback[] };
      assert.equal(context.feedback.at(-1)!.choice, choice);
    }
  } finally { f.cleanup(); }
});
