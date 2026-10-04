import React from 'react';
import type { TextMessagePartComponent } from '@assistant-ui/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Assistant output is untrusted. Keep rich text, but give it no navigation,
// remote resource loading, raw HTML, or executable component surface.
const elements = ['p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'img', 'input', 'sup', 'section'];
const components: Components = {
  a: ({ children }) => <span className="markdown-reference">{children}</span>,
  img: ({ alt }) => alt ? <span className="markdown-image-description">{alt}</span> : null,
  input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} disabled readOnly tabIndex={-1} />,
};
const noResourceUrl = () => undefined;

/** Use only for assistant text: MessagePrimitive.Parts components={{ Text: MarkdownText }}.
 * Parsing each current text snapshot also handles incomplete streaming Markdown;
 * no synthetic closing delimiters or guessed assistant text are persisted. */
export const MarkdownText: TextMessagePartComponent = ({ text }) => <div className="markdown-text">
  <ReactMarkdown remarkPlugins={[remarkGfm]} allowedElements={elements} skipHtml
    urlTransform={noResourceUrl} components={components}>{text}</ReactMarkdown>
</div>;
