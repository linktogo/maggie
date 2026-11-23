import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockMarkers, mergeBlock, readBlock, removeBlock, renderBlock } from '../src/block.js';

const { begin, end } = blockMarkers('skills');

test('renderBlock wraps the content in the markers', () => {
  assert.equal(renderBlock('skills', '  body \n'), `${begin}\n\nbody\n\n${end}`);
});

test('mergeBlock creates the file when there is none, or when it is blank', () => {
  assert.equal(mergeBlock(null, 'skills', 'body'), `${begin}\n\nbody\n\n${end}\n`);
  assert.equal(mergeBlock(' \n', 'skills', 'body'), `${begin}\n\nbody\n\n${end}\n`);
});

test('mergeBlock appends the block after hand-written content', () => {
  assert.equal(mergeBlock('# Team rules\n\nBe nice.\n\n', 'skills', 'body'), `# Team rules\n\nBe nice.\n\n${begin}\n\nbody\n\n${end}\n`);
});

test('mergeBlock replaces an existing block in place and keeps what surrounds it', () => {
  const existing = `# Top\n\n<!-- maggie:begin skills — older wording -->\nold\n${end}\n\n# Bottom\n`;
  assert.equal(mergeBlock(existing, 'skills', 'new'), `# Top\n\n${begin}\n\nnew\n\n${end}\n\n# Bottom\n`);
});

test('an unterminated block is an error, not a silent overwrite', () => {
  assert.throws(() => mergeBlock(`${begin}\nno end`, 'skills', 'x'), /unterminated maggie block "skills"/);
  assert.throws(() => readBlock('<!-- maggie:begin skills never closed', 'skills'), /unterminated/);
});

test('removeBlock drops the block and keeps the rest', () => {
  assert.equal(removeBlock(`# Top\n\n${begin}\n\nx\n\n${end}\n\n# Bottom\n`, 'skills'), '# Top\n\n# Bottom\n');
  assert.equal(removeBlock(`# Top\n\n${begin}\nx\n${end}\n`, 'skills'), '# Top\n');
});

test('removeBlock returns an empty string when the block was the whole file', () => {
  assert.equal(removeBlock(`${begin}\n\nx\n\n${end}\n`, 'skills'), '');
});

test('removeBlock leaves a file without the block alone', () => {
  assert.equal(removeBlock('# Hand-written\n', 'skills'), '# Hand-written\n');
});

test('readBlock returns the block content, or null', () => {
  assert.equal(readBlock(mergeBlock('# x', 'skills', 'body'), 'skills'), 'body');
  assert.equal(readBlock('# no block', 'skills'), null);
  assert.equal(readBlock(null, 'skills'), null);
});
