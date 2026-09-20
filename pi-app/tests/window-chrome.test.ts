import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseWindowTheme, titleBarOverlay, windowChromeOptions, WINDOW_TITLEBAR_HEIGHT } from '../src/window-chrome.js';

test('Windows removes the native title strip while retaining window controls and resizing', () => {
  const options = windowChromeOptions('dark', 'win32');
  assert.equal(options.titleBarStyle, 'hidden');
  assert.equal(options.frame, true);
  assert.equal(options.resizable, true);
  assert.deepEqual(options.titleBarOverlay, { color: '#080b0e', symbolColor: '#e8e7e4', height: 40 });
  assert.equal(options.backgroundColor, '#080b0e');
});

test('light and dark title controls use matching surfaces and a stable safe-area height', () => {
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  for (const theme of ['dark', 'light'] as const) {
    const options = windowChromeOptions(theme, 'win32');
    const overlay = titleBarOverlay(theme);
    assert.equal(overlay.height, WINDOW_TITLEBAR_HEIGHT);
    assert.equal(overlay.color, options.backgroundColor);
    assert.notEqual(overlay.color, overlay.symbolColor);
    const themeBlock = theme === 'dark' ? css.match(/:root\s*\{([^}]+)\}/)?.[1] : css.match(/:root\[data-theme='light'\]\s*\{([^}]+)\}/)?.[1];
    assert.equal(themeBlock?.match(/--page:\s*(#[a-f0-9]+)/)?.[1], overlay.color);
  }
  assert.deepEqual(titleBarOverlay('light'), { color: '#f8f7f4', symbolColor: '#242529', height: 40 });
  const changed = titleBarOverlay('dark');
  changed.color = '#ff0000';
  assert.equal(titleBarOverlay('dark').color, '#080b0e');
});

test('macOS retains native traffic lights without the Windows overlay API', () => {
  const options = windowChromeOptions('light', 'darwin');
  assert.equal(options.titleBarStyle, 'hidden');
  assert.equal(options.titleBarOverlay, undefined);
  assert.equal(options.frame, true);
});

test('window theme IPC accepts only an explicit light or dark theme', () => {
  assert.equal(parseWindowTheme({ theme: 'light' }), 'light');
  assert.equal(parseWindowTheme({ theme: 'dark' }), 'dark');
  for (const params of [undefined, null, false, 'dark', [], {}, { theme: 'system' }, { theme: '#fff' }, { theme: 0 }, { theme: 'dark', height: 999 }, Object.create({ theme: 'dark' })]) {
    assert.throws(() => parseWindowTheme(params), { message: 'INVALID_WINDOW_THEME' });
  }
});
