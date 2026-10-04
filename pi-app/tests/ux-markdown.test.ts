import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { MessagePartPrimitive, TextMessagePartProvider } from '@assistant-ui/react';
import { MarkdownText } from '../src/renderer/MarkdownText';

const render = (text: string, running = false) => renderToStaticMarkup(createElement(MarkdownText, { type: 'text', text, status: { type: running ? 'running' : 'complete' } }));
const noActiveContent = (html: string) => assert.doesNotMatch(html, /<(?:a|img|script|iframe|object|embed|svg|style|link|form|button)\b|\s(?:href|src|srcset|on\w+|formaction|action|style)=/i);

test('UX markdown reproduces default assistant-ui literal stars while the assistant override renders bold', () => {
  const original = '昨晚的 **恢复感** 可以先记录下来。';
  const plain = renderToStaticMarkup(createElement(TextMessagePartProvider, { text: original }, createElement(MessagePartPrimitive.Text, { smooth: false })));
  assert.match(plain, /\*\*恢复感\*\*/); assert.doesNotMatch(plain, /<strong>/);
  const rich = render(original);
  assert.match(rich, /<strong>恢复感<\/strong>/); assert.doesNotMatch(rich, /\*\*/);
});

test('UX markdown renders headings, paragraphs, emphasis, ordered and nested unordered lists', () => {
  const html = render('# Synthetic summary\n\nFirst paragraph with **bold** and *emphasis*.\n\nSecond paragraph.\n\n## Synthetic next step\n\n1. First item\n2. Second item\n   - Nested item\n\n> Synthetic note');
  for (const element of ['h1', 'h2', 'p', 'strong', 'em', 'ol', 'ul', 'li', 'blockquote']) assert.match(html, new RegExp(`<${element}(?:>| )`));
  assert.match(html, /<p>Second paragraph\.<\/p>/);
});

test('UX markdown handles Chinese and English lists without changing their factual text', () => {
  for (const phrase of ['实际睡眠大约 6–7 小时', 'Sleep was about 6–7 hours']) {
    const html = render(`- **${phrase}**\n- Synthetic other item`);
    assert.ok(html.includes(`<strong>${phrase}</strong>`));
    assert.equal((html.match(/<li>/g) ?? []).length, 2);
  }
});

test('UX markdown renders fenced and inline code as escaped text with preserved indentation', () => {
  const html = render('Use `**literal**` as text.\n\n```html\n  <script>synthetic()</script>\n  **still literal**\n```');
  assert.match(html, /<code>\*\*literal\*\*<\/code>/);
  assert.match(html, /<pre><code class="language-html">  &lt;script&gt;synthetic\(\)&lt;\/script&gt;/);
  assert.match(html, /  \*\*still literal\*\*/); noActiveContent(html);
});

test('UX markdown supports GFM tables, strikethrough, and inert task checkboxes', () => {
  const html = render('| Synthetic field | Value |\n| --- | --- |\n| Sleep | 7 hours |\n\n~~Old note~~\n\n- [x] Recorded\n- [ ] Pending');
  assert.match(html, /<table>/); assert.match(html, /<th>Synthetic field<\/th>/);
  assert.match(html, /<del>Old note<\/del>/);
  const inputs = [...html.matchAll(/<input\b[^>]*>/g)]; assert.equal(inputs.length, 2);
  for (const input of inputs) { assert.match(input[0], /type="checkbox"/); assert.match(input[0], /disabled=""/); }
  noActiveContent(html);
});

for (const markdown of [
  '[Synthetic source](https://example.invalid/source)',
  'https://example.invalid/source',
  '<https://example.invalid/source>',
  '[Synthetic mail](mailto:synthetic@example.invalid)',
  '[Synthetic file](file:///C:/synthetic.txt)',
  '[Synthetic dangerous link](javascript:synthetic)',
  '[Synthetic encoded scheme](jav&#x61;script:synthetic)',
  '[Synthetic data](data:text/html,synthetic)',
  '[Synthetic local path](/settings)',
  '[Synthetic reference][source]\n\n[source]: https://example.invalid',
  '![Synthetic image alt](https://example.invalid/tracker.png)',
  '![Synthetic local image](file:///C:/synthetic.png)',
]) test(`UX markdown cannot navigate or load resources: ${markdown.slice(0, 60)}`, () => {
  const html = render(markdown);
  noActiveContent(html);
  assert.match(html, /Synthetic|example\.invalid/);
});

for (const markdown of [
  '<script src="https://example.invalid/script.js">synthetic()</script>',
  '<img src="https://example.invalid/pixel" onerror="synthetic()">',
  '<iframe src="https://example.invalid"></iframe>',
  '<style>body { display:none }</style>\n\nSynthetic text',
  '<svg onload="synthetic()"><a href="javascript:synthetic">Synthetic</a></svg>',
  '<form action="https://example.invalid"><button>Send</button></form>',
]) test(`UX markdown ignores raw HTML without execution: ${markdown.slice(0, 60)}`, () => noActiveContent(render(markdown)));

test('UX markdown accepts every incomplete streaming prefix and renders the completed snapshot', () => {
  const complete = '## Synthetic summary\n\n**恢复感** matters.\n\n- Synthetic first\n- Synthetic second\n\n```txt\n  synthetic code\n```';
  for (let end = 0; end <= complete.length; end++) assert.doesNotThrow(() => noActiveContent(render(complete.slice(0, end), true)));
  const html = render(complete);
  assert.match(html, /<strong>恢复感<\/strong>/); assert.match(html, /<pre><code class="language-txt">  synthetic code/);
  assert.equal(render(''), '<div class="markdown-text"></div>');
});

test('UX markdown keeps ordinary angle comparisons, ampersands and Unicode readable', () => {
  const html = render('Synthetic 6 < 7 and 8 > 7. A & B. 中文 🌙');
  assert.match(html, /6 &lt; 7 and 8 &gt; 7/); assert.match(html, /A &amp; B/); assert.match(html, /中文 🌙/);
});
