import test from 'node:test';
import assert from 'node:assert/strict';
import { resources } from '../src/renderer/i18n';
import { applyStreamEvent, conversationFacts, displayNumber, errorKey, formatDate, isSnapshot, localizedRecordText, manualTargetPayload, orderedReports, toDatetimeLocal, visibleMessages } from '../src/renderer/ui-model';
import type { AppSnapshot, Fact, Report } from '../src/shared/types';

test('every UI string has both a Chinese and an English translation', () => {
  assert.deepEqual(Object.keys(resources.zh.translation).sort(), Object.keys(resources.en.translation).sort());
  for (const dictionary of [resources.zh.translation, resources.en.translation]) {
    assert.ok(Object.values(dictionary).every((value) => typeof value === 'string' && value.trim().length > 0));
  }
});

test('live streaming is only a projection and does not mutate native Pi messages', () => {
  const messages = [{ id: 'user-1', role: 'user' as const, text: 'How did I sleep?' }];
  const result = visibleMessages(messages, 'Looking at your records', 'sleep-1');
  assert.equal(result.length, 2);
  assert.equal(result[1]?.id, 'stream-sleep-1');
  assert.equal(messages.length, 1);
  assert.equal(visibleMessages(messages, '', 'sleep-1'), messages);
});

test('personal facts persist but facts from another investigation stay out of view', () => {
  const base = { value: 'value', status: 'known' as const, revision: 1, updatedAt: '2026-01-01' };
  const facts: Fact[] = [
    { ...base, id: 'profile', topic: 'age', scope: 'profile' },
    { ...base, id: 'current', topic: 'coffee', scope: 'sleep', investigationId: 'current' },
    { ...base, id: 'other', topic: 'coffee', scope: 'sleep', investigationId: 'other' },
  ];
  assert.deepEqual(conversationFacts(facts, 'current').map((fact) => fact.id), ['profile', 'current']);
});

test('reports prefer current investigation then latest version without changing source order', () => {
  const reports = [
    { id: 'other', investigationId: 'other', createdAt: '2026-09-20' },
    { id: 'old', investigationId: 'current', createdAt: '2026-09-01' },
    { id: 'new', investigationId: 'current', createdAt: '2026-09-02' },
  ] as Report[];
  assert.deepEqual(orderedReports(reports, 'current').map((report) => report.id), ['new', 'old', 'other']);
  assert.equal(reports[0]?.id, 'other');
});

test('missing measurements never become zero in the report UI', () => {
  assert.equal(displayNumber(null), '—');
  assert.equal(displayNumber(Number.NaN), '—');
  assert.equal(displayNumber(Number.POSITIVE_INFINITY), '—');
  assert.equal(displayNumber(0), '0');
});

test('snapshot guard does not accept provider configuration as a full app state', () => {
  assert.equal(isSnapshot({ configured: true }), false);
  assert.equal(isSnapshot(null), false);
  assert.equal(isSnapshot({ configured: false, messages: [], investigations: [] } as unknown as AppSnapshot), true);
});

test('dates gracefully handle unavailable and malformed values', () => {
  assert.equal(formatDate(undefined, 'zh'), '—');
  assert.equal(formatDate('not-a-date', 'en'), 'not-a-date');
  assert.notEqual(formatDate('2026-09-21T08:30:00Z', 'zh'), '—');
});

test('two streamed Pi turns separated by a tool snapshot do not duplicate committed text', () => {
  let delta = applyStreamEvent('', { type: 'delta', text: 'Let me inspect your data.' });
  const state: AppSnapshot = { messages: [{ id: 'first', role: 'assistant', text: delta }], configured: true, investigations: [], busy: true,
    language: 'en', facts: [], imports: [], candidates: [], reports: [], feedback: [] };
  delta = applyStreamEvent(delta, { type: 'state', state });
  assert.equal(delta, '');
  delta = applyStreamEvent(delta, { type: 'delta', text: 'I found an interruption.' });
  const rendered = visibleMessages(state.messages, delta, 'sleep');
  assert.deepEqual(rendered.map((message) => message.text), ['Let me inspect your data.', 'I found an interruption.']);
  delta = applyStreamEvent(delta, { type: 'state', state: { ...state, messages: rendered, busy: false } });
  assert.equal(delta, '');
});

test('IPC failures expose known error keys without echoing arbitrary request content', () => {
  assert.equal(errorKey(new Error("Error invoking remote method 'sleepclaw:request': Error: AUTH_FAILED")), 'error_AUTH_FAILED');
  assert.equal(errorKey(new Error('provider echoed a secret key: private-test-secret')), 'error_REQUEST_FAILED');
});

test('English data notices do not leak untranslated internal warning text', () => {
  const warning = '部分记录缺少设备来源，分析时需要确认来源。';
  assert.match(localizedRecordText(warning, 'en'), /device source/);
  assert.equal(localizedRecordText(warning, 'zh'), warning);
  assert.doesNotMatch(localizedRecordText('一条未知的内部提示', 'en'), /[\u3400-\u9fff]/);
});

test('manual targets convert the explicitly entered local range to ISO without selecting a date or source', () => {
  const start = '2025-10-12T21:45:00';
  const end = '2025-10-13T06:20:30';
  assert.equal(manualTargetPayload('', end, 'Watch'), null);
  assert.equal(manualTargetPayload(start, end, ''), null);
  const target = manualTargetPayload(start, end, 'Watch');
  assert.deepEqual(target, { start: new Date(start).toISOString(), end: new Date(end).toISOString(), source: 'Watch' });
  assert.equal(toDatetimeLocal(target?.start), start);
  assert.equal(toDatetimeLocal(target?.end), end);
});

test('manual targets reject backward ranges, invalid dates, and non-local input', () => {
  assert.equal(manualTargetPayload('2026-09-21T10:00', '2026-09-21T09:00', 'Watch'), null);
  assert.equal(manualTargetPayload('2026-02-30T10:00', '2026-03-01T09:00', 'Watch'), null);
  assert.equal(manualTargetPayload('2026-09-21T10:00Z', '2026-09-21T11:00Z', 'Watch'), null);
  assert.equal(manualTargetPayload('2026-09-21T10:00', '2026-09-21T10:00', 'Watch'), null);
  assert.equal(toDatetimeLocal('invalid'), '');
});
