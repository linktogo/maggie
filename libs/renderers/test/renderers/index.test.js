import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRenderer, knownTargets } from '../../src/renderers/index.js';

test('knownTargets lists all four platforms', () => {
  assert.deepEqual(knownTargets().sort(), ['claude', 'copilot', 'cursor', 'windsurf']);
});

test('getRenderer returns the matching renderer', () => {
  assert.equal(getRenderer('claude').id, 'claude');
});

test('getRenderer throws on unknown target', () => {
  assert.throws(() => getRenderer('nope'), /Unknown target: nope/);
});
