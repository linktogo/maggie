import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentError } from '../src/errors.js';

test('AgentError carries a machine-readable code next to its message', () => {
  const err = new AgentError('busy', 'a run is already active on api');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'AgentError');
  assert.equal(err.code, 'busy');
  assert.equal(err.message, 'a run is already active on api');
});
