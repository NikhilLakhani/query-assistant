import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnswerMarkdown, safeLink } from './Markdown';

test('Markdown renders structure and incomplete code blocks without enabling raw HTML', () => {
  const html = renderToStaticMarkup(
    <AnswerMarkdown
      content={'**Bold**\n\n- one\n- two\n\n```js\n<script>alert(1)</script>'}
    />,
  );
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<pre><code/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});
test('Markdown removes raw active HTML and all images; only safe HTTPS links remain', () => {
  const html = renderToStaticMarkup(
    <AnswerMarkdown
      content={
        '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n![pixel](https://example.com/pixel)\n\n[bad](javascript:alert) [data](data:text/html,hi) [relative](/api/admin) [good](https://example.com/docs)'
      }
    />,
  );
  assert.ok(!/<script|<img|onerror|href="(?:javascript|data|\/api)/.test(html));
  assert.match(html, /href="https:\/\/example.com\/docs"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /referrerPolicy="no-referrer"/);
  for (const value of [
    'javascript:alert(1)',
    '//example.com',
    '/api/auth/logout',
    'data:text/html,x',
    'https://user:pass@example.com',
    'https://example.com\n.evil',
    'mailto:a@example.com',
  ])
    assert.equal(safeLink(value), '');
});
