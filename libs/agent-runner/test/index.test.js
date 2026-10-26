import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.js';

test('the public surface is exactly what the server and the board rely on', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'AGENT_PROVIDERS', 'AgentError', 'DEFAULT_AGENT_PROVIDER', 'DEFAULT_MAX_EVENTS', 'DEFAULT_MAX_RUNS',
    'DEFAULT_TIMEOUT_MS', 'MAX_PROMPT_CHARS', 'TERMINAL', 'buildPrompt', 'commandFor', 'createRepoResolver',
    'createRunManager', 'detectProviders', 'findOnPath', 'listSkills', 'loadSkill', 'resolveProvider', 'validateModel',
  ]);
});
