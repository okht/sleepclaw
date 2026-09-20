import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

test('renderer bundles variable English and Chinese fonts before theme styles', () => {
  const entry = read('src/renderer/index.tsx');
  let fontBytes = 0;
  for (const font of ['@fontsource-variable/inter/wght.css', '@fontsource-variable/unbounded/wght.css', '@fontsource-variable/noto-sans-sc/index.css']) {
    assert.ok(entry.indexOf(`import '${font}'`) >= 0);
    assert.ok(entry.indexOf(`import '${font}'`) < entry.indexOf("import './styles.css'"));
    const path = require.resolve(font);
    const css = readFileSync(path, 'utf8');
    assert.match(css, /font-weight: [12]00 900/);
    assert.doesNotMatch(css, /url\(https?:/);
    const urls = [...css.matchAll(/url\(([^)]+\.woff2)\)/g)];
    assert.ok(urls.length > 0);
    for (const [, file] of urls) {
      const fontFile = resolve(dirname(path), file);
      assert.ok(existsSync(fontFile), `Missing local font ${file}`);
      fontBytes += statSync(fontFile).size;
    }
    const pkg = JSON.parse(readFileSync(require.resolve(`${font.split('/').slice(0, 2).join('/')}/package.json`), 'utf8'));
    assert.equal(pkg.license, 'OFL-1.1');
    assert.equal(pkg.version, '5.3.0');
    assert.ok(existsSync(resolve(dirname(path), 'LICENSE')));
  }
  assert.ok(fontBytes < 5 * 1024 * 1024, 'Bundled font resources must remain below 5 MiB');
  const config = require('../webpack.renderer.cjs');
  assert.ok(config.module.rules.some((rule: { test: RegExp; type?: string }) => rule.test.test('font.woff2') && rule.type === 'asset/resource'));
});

test('font stacks resolve Chinese before the generic fallback', () => {
  const css = read('src/renderer/assets/typography.css');
  for (const kind of ['body', 'brand']) {
    const stack = css.match(new RegExp(`--oc-font-${kind}:([^;]+)`))?.[1] ?? '';
    const latinFamily = kind === 'brand' ? 'Unbounded Variable' : 'Inter Variable';
    assert.ok(stack.includes(`"${latinFamily}", "Noto Sans SC Variable"`));
    assert.ok(stack.indexOf('Microsoft YaHei UI') < stack.indexOf('sans-serif'));
    assert.ok(stack.trim().endsWith('sans-serif'));
  }
  assert.match(css, /--oc-font-display: var\(--oc-font-body\)/);
  assert.match(css, /--font-brand: var\(--oc-font-brand\)/);
  assert.doesNotMatch(css, /"Switzer"|"Sentient"/);
});

test('GT Eesti reference preview only resolves installed local font faces', () => {
  const css = read('src/renderer/assets/typography.css');
  const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match => match[1]);
  const gtFaces = faces.filter(face => face.includes('"GT Eesti Local"'));
  assert.equal(gtFaces.length, 3);
  for (const [weight, family] of [[400, 'GT Eesti Text Trial Rg'], [500, 'GT Eesti Text Trial Md'], [700, 'GT Eesti Text Trial Bd']] as const) {
    const face = gtFaces.find(face => face.includes(`font-weight: ${weight};`));
    assert.ok(face);
    assert.ok(face.includes(`src: local("${family}");`));
    assert.doesNotMatch(face, /url\(/i);
  }
  assert.match(css, /--oc-font-body: "GT Eesti Local", "Inter Variable", "Noto Sans SC Variable"/);
});
