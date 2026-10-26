import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PROMPT_CHARS, buildPrompt } from '../src/prompt.js';

const skill = { id: 'nx/monorepo', body: 'Use affected.' };

test('a free prompt goes in as written, trimmed', () => {
  assert.equal(buildPrompt({ prompt: '  fix the bug \n' }), 'fix the bug');
});

test('a skill alone becomes an instruction to apply it', () => {
  assert.equal(
    buildPrompt({ skill }),
    'Apply the following skill to this repository.\n\nUse affected.',
  );
});

test('a skill plus a prompt keeps both, the prompt as the task', () => {
  assert.equal(
    buildPrompt({ prompt: 'only in libs/', skill }),
    'Apply the following skill to this repository.\n\nUse affected.\n\n---\n\nTask:\nonly in libs/',
  );
});

test('a run needs a prompt or a skill', () => {
  for (const input of [{}, { prompt: '   ' }, { prompt: null }]) {
    assert.throws(() => buildPrompt(input), (err) => err.code === 'invalid' && /prompt or a skill/.test(err.message));
  }
});

test('the prompt must be a string of reasonable size', () => {
  assert.throws(() => buildPrompt({ prompt: 42 }), (err) => err.code === 'invalid' && /must be a string/.test(err.message));
  assert.throws(() => buildPrompt({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }), (err) => err.code === 'invalid' && /too long/.test(err.message));
});
