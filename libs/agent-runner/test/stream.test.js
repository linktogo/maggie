import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStreamParser, summarizeTool } from '../src/stream.js';

const fixture = await readFile(new URL('./fixtures/claude-stream.jsonl', import.meta.url), 'utf8');

const expected = [
  { kind: 'session', sessionId: 'sess-1' },
  { kind: 'text', content: 'I will fix it.' },
  { kind: 'step', content: { tool: 'Edit', summary: 'src/a.js', input: { file_path: 'src/a.js', old_string: 'a', new_string: 'b' } } },
  { kind: 'text', content: 'Done.' },
  { kind: 'result', sessionId: 'sess-1', costUsd: 0.08, durationMs: 72000, isError: false },
];

test('parses a whole claude stream into session, text, step and result', () => {
  const parser = createStreamParser('claude-cli');
  assert.deepEqual([...parser.push(fixture), ...parser.end()], expected);
});

test('reassembles a line split across chunks', () => {
  const parser = createStreamParser('claude-cli');
  const out = [];
  for (let i = 0; i < fixture.length; i += 7) out.push(...parser.push(fixture.slice(i, i + 7)));
  out.push(...parser.end());
  assert.deepEqual(out, expected);
});

test('keeps a non-ASCII line intact when the split falls inside it', () => {
  const line = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'café ✓' }] } })}\n`;
  const cut = line.indexOf('é') + 0;
  const parser = createStreamParser('claude-cli');
  assert.deepEqual(parser.push(line.slice(0, cut)), []);
  assert.deepEqual(parser.push(line.slice(cut)), [{ kind: 'text', content: 'café ✓' }]);
});

test('keeps an unparsable line as text', () => {
  assert.deepEqual(createStreamParser('claude-cli').push('not json\n'), [{ kind: 'text', content: 'not json' }]);
});

test('ignores blank lines, unknown event types and non-object JSON', () => {
  const parser = createStreamParser('claude-cli');
  assert.deepEqual(parser.push('  \n{"type":"mystery"}\n{"type":"user"}\n42\nnull\n'), []);
});

test('tolerates sparse events', () => {
  const parser = createStreamParser('claude-cli');
  const out = parser.push([
    '{"type":"system","subtype":"hook"}',
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant"}',
    '{"type":"assistant","message":{"content":[{"type":"thinking"},{"type":"tool_use","name":"Bash"}]}}',
    '{"type":"result"}',
    '',
  ].join('\n'));
  assert.deepEqual(out, [
    { kind: 'session', sessionId: null },
    { kind: 'step', content: { tool: 'Bash', summary: '', input: {} } },
    { kind: 'result', sessionId: null, costUsd: null, durationMs: null, isError: false },
  ]);
});

test('skips malformed assistant content instead of throwing', () => {
  const parser = createStreamParser('claude-cli');
  const out = parser.push([
    '{"type":"assistant","message":{"content":"not an array"}}',
    '{"type":"assistant","message":{"content":[null,42,{"type":"text","text":null},{"type":"text","text":{"a":1}},{"type":"text","text":"ok"}]}}',
    '',
  ].join('\n'));
  assert.deepEqual(out, [{ kind: 'text', content: 'ok' }]);
});

test('flushes an unterminated last line on end', () => {
  const parser = createStreamParser('claude-cli');
  assert.deepEqual(parser.push('tail'), []);
  assert.deepEqual(parser.end(), [{ kind: 'text', content: 'tail' }]);
  assert.deepEqual(parser.end(), []);
});

test('passes copilot output through as text', () => {
  const parser = createStreamParser('copilot');
  assert.deepEqual(parser.push('hello\nwor'), [{ kind: 'text', content: 'hello\nwor' }]);
  assert.deepEqual(parser.end(), []);
});

test('summarizeTool picks the first meaningful field and caps it at 120 characters', () => {
  assert.equal(summarizeTool('Edit', { file_path: 'a.js', command: 'x' }), 'a.js');
  assert.equal(summarizeTool('Bash', { command: 'ls' }), 'ls');
  assert.equal(summarizeTool('Grep', { pattern: 'foo' }), 'foo');
  assert.equal(summarizeTool('WebFetch', { url: 'http://x' }), 'http://x');
  assert.equal(summarizeTool('Task', { description: 'dig' }), 'dig');
  assert.equal(summarizeTool('Other', { other: 1 }), '');
  assert.equal(summarizeTool('Other', undefined), '');
  assert.equal(summarizeTool('Bash', { command: 'x'.repeat(200) }).length, 120);
});
