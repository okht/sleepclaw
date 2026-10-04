import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { ChatPanel, ComposerTaskStatus, GlobalTaskProgress } from '../src/renderer/App';
import { progressText, taskPresentation } from '../src/renderer/ui-model';
import { i18n } from '../src/renderer/i18n';
import type { AppSnapshot, AppTask, Investigation } from '../src/shared/types';

const active: Investigation = {
  id: 'synthetic-progress', sleepEpisodeId: 'synthetic-progress', goal: 'Synthetic progress routing',
  language: 'zh', scope: 'main', createdAt: '2026-10-04T00:00:00Z', revision: 1, status: 'collecting',
};
const base: AppSnapshot = {
  language: 'zh', configured: true, busy: false,
  messages: [{ id: 'synthetic-user', role: 'user', text: 'Synthetic message' }],
  investigations: [active], active, facts: [], imports: [], candidates: [], reports: [], feedback: [],
};
const kinds: AppTask['kind'][] = ['model', 'configure', 'import', 'auth'];
const booleans = [false, true];
const action = async () => true;
const noop = () => {};
const asyncNoop = async () => {};
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));

function renderTaskSurface(state: AppSnapshot, chatVisible: boolean, progress = 'sleep_data_query') {
  const presentation = taskPresentation(state, { chatVisible });
  return render(createElement(Fragment, {},
    presentation.placement === 'global' ? createElement(GlobalTaskProgress, { key: 'global', state, progress, action }) : null,
    chatVisible ? createElement(ChatPanel, {
      key: 'chat', state, progress, delta: '', action, importFile: asyncNoop, makeReport: asyncNoop,
      blocked: state.busy, onConnect: noop, onOpenData: noop, onOpenReports: noop,
    }) : null,
  ));
}

function cancellationButtons(html: string): string[] {
  return (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).filter(button => {
    const text = button.replace(/<[^>]+>/g, '').trim();
    return text === i18n.t('cancelTask') || text === `■ ${i18n.t('stop')}`;
  });
}

for (const kind of kinds) test(`UX progress routing: ${kind} covers busy, connection, page, local mode and cancellability`, () => {
  for (const busy of booleans) for (const configured of booleans) for (const chatVisible of booleans) {
    for (const localCollection of booleans) for (const cancellable of booleans) {
      const state: AppSnapshot = { ...base, busy, configured, localCollection, task: { kind, cancellable } };
      const expectedModel = busy && configured && kind === 'model';
      assert.deepEqual(taskPresentation(state, { chatVisible }), {
        placement: !busy ? 'none' : expectedModel && chatVisible ? 'composer' : 'global',
        modelRunning: expectedModel,
        canCancel: busy && cancellable,
      }, JSON.stringify({ kind, busy, configured, chatVisible, localCollection, cancellable }));
    }
  }
});

test('UX progress routing: a synchronous busy operation has no fake model or cancellation state', () => {
  for (const busy of booleans) for (const configured of booleans) for (const chatVisible of booleans) {
    assert.deepEqual(taskPresentation({ ...base, busy, configured, task: undefined }, { chatVisible }), {
      placement: 'none', modelRunning: false, canCancel: false,
    });
  }
});

for (const language of ['zh', 'en'] as const) {
  for (const kind of kinds) test(`UX progress ${language}: ${kind} renders one task surface and at most one enabled cancel`, async () => {
    await i18n.changeLanguage(language);
    for (const configured of booleans) for (const chatVisible of booleans) {
      for (const localCollection of booleans) for (const cancellable of booleans) {
        const state: AppSnapshot = { ...base, language, busy: true, configured, localCollection, task: { kind, cancellable } };
        const label = JSON.stringify({ kind, configured, chatVisible, localCollection, cancellable });
        const html = renderTaskSurface(state, chatVisible);
        const inline = kind === 'model' && configured && chatVisible;
        assert.equal((html.match(/class="composer-task-status"/g) ?? []).length, Number(inline), label);
        assert.equal((html.match(/class="task-progress task-progress-global"/g) ?? []).length, Number(!inline), label);
        assert.equal((html.match(/role="status"/g) ?? []).length, 1, label);
        assert.doesNotMatch(html, /progress-toast|sleep_data_query/, label);
        assert.ok(html.includes(kind === 'auth' ? i18n.t('task_auth') : progressText('sleep_data_query', language)), label);
        const buttons = cancellationButtons(html);
        assert.equal(buttons.length, Number(cancellable), label);
        for (const button of buttons) assert.doesNotMatch(button, /\bdisabled(?:=|\s|>)/, label);
        if (cancellable) assert.ok(buttons[0].includes(i18n.t(inline ? 'stop' : 'cancelTask')), label);
        if (chatVisible) {
          // The external-store runtime inserts an assistant placeholder for a running model after a user message.
          assert.equal((html.match(/class="message assistant-message"/g) ?? []).length, Number(kind === 'model' && configured), label);
          if (configured && kind !== 'model') {
            const send = (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).find(button => button.includes(`<span>${i18n.t('send')}</span>`));
            assert.ok(send, label);
            assert.match(send, /\bdisabled=""/, label);
            assert.match(html.match(/<textarea\b[^>]*class="composer-input"[^>]*>/)?.[0] ?? '', /\bdisabled=""/, label);
          }
        }
      }
    }
  });

  test(`UX progress ${language}: short synchronous busy and settled tasks do not offer Stop or fabricate typing`, async () => {
    await i18n.changeLanguage(language);
    for (const state of [
      { ...base, language, busy: true },
      { ...base, language, busy: false, task: { kind: 'model' as const, cancellable: true } },
      { ...base, language, busy: false },
    ]) {
      const html = renderTaskSurface(state, true);
      assert.equal(cancellationButtons(html).length, 0);
      assert.doesNotMatch(html, /task-progress-global|composer-task-status|class="message assistant-message"/);
    }
  });

  test(`UX progress ${language}: navigating between chat, reports and settings preserves exactly one cancellation`, async () => {
    await i18n.changeLanguage(language);
    const state: AppSnapshot = { ...base, language, busy: true, localCollection: true, task: { kind: 'model', cancellable: true } };
    for (const page of ['chat', 'reports', 'settings', 'chat']) {
      const html = renderTaskSurface(state, page === 'chat', 'sleep_report');
      assert.equal(cancellationButtons(html).length, 1, page);
      assert.equal(html.includes('composer-task-status'), page === 'chat', page);
      assert.equal(html.includes('task-progress-global'), page !== 'chat', page);
      assert.ok(html.includes(progressText('sleep_report', language)), page);
    }
  });

  test(`UX progress ${language}: inline status uses a human default and never introduces its own cancel button`, async () => {
    await i18n.changeLanguage(language);
    const state: AppSnapshot = { ...base, language, busy: true, task: { kind: 'model', cancellable: true } };
    const html = render(createElement(ComposerTaskStatus, { state, progress: '' }));
    assert.ok(html.includes(i18n.t('task_model')));
    assert.match(html, /role="status".*aria-live="polite"/);
    assert.doesNotMatch(html, /<button/);
    for (const kind of ['configure', 'import', 'auth'] as const) {
      assert.equal(render(createElement(ComposerTaskStatus, { state: { ...state, task: { kind, cancellable: true } }, progress: '' })), '');
    }
  });
}

test('UX progress layout: global status stays in document flow and a growing status cannot shrink the composer', () => {
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  const globalRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => /\.task-progress(?:-global)?(?=[\s>,.:#]|$)/.test(selector.trim()));
  assert.ok(globalRules.length > 0);
  for (const [, selector, declarations] of globalRules) {
    assert.doesNotMatch(declarations, /position\s*:\s*(?:fixed|absolute)|transform\s*:\s*translate/, selector.trim());
  }
  const composer = css.match(/\.composer-area\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(composer, /flex-shrink\s*:\s*0/);
  const status = css.match(/\.composer-task-status\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(status, /min-width\s*:\s*0/);
  assert.match(css, /\.composer-task-status\s*>\s*span:last-child\s*\{[^}]*overflow-wrap\s*:\s*anywhere/);
});
