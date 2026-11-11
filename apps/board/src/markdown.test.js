import { test, expect } from 'vitest';
import { renderMarkdown } from './markdown.js';

test('renders markdown', () => {
  const html = renderMarkdown('# Title\n\n**bold** and `code`');
  expect(html).toContain('<h1');
  expect(html).toContain('<strong>bold</strong>');
  expect(html).toContain('<code>code</code>');
});

test('removes scripts, event handlers and javascript: links', () => {
  const html = renderMarkdown('<script>x</script><img src=x onerror=alert(1)>[a](javascript:alert(1))');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('onerror');
  expect(html).not.toContain('javascript:');
});

test('opens links in a new tab', () => {
  const html = renderMarkdown('[maggie](https://example.com)');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
});

test('removes style elements and style attributes', () => {
  const html = renderMarkdown('<style>body{display:none}</style>hi\n\n<div style="position:fixed;inset:0">x</div>\n\n<p class="fixed inset-0" style="color:red">y</p>');
  expect(html).not.toContain('<style');
  expect(html).not.toContain('style=');
  expect(html).not.toContain('class=');
  expect(html).toContain('hi');
});

test('removes forms, inputs, buttons, images and iframes', () => {
  const html = renderMarkdown('<form action="https://evil"><input name=a><button>go</button></form>\n\n<img src="https://evil/x.png">\n\n![alt](https://evil/y.png)\n\n<iframe src="https://evil"></iframe>');
  for (const tag of ['<form', '<input', '<button', '<img', '<iframe']) expect(html).not.toContain(tag);
  expect(html).not.toContain('action=');
});

test('still renders links, tables and code blocks', () => {
  const html = renderMarkdown('[a](https://example.com "t")\n\n| h |\n|---|\n| c |\n\n```js\nconst x = 1;\n```');
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain('<table>');
  expect(html).toContain('<pre><code>');
});

test('renders nothing for a missing text', () => {
  expect(renderMarkdown(undefined)).toBe('');
});
