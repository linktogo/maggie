import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.js';

test('the public surface is exactly what the server and the board rely on', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'AGENT_PROVIDERS', 'AgentError', 'DEFAULT_AGENT_PROVIDER', 'DEFAULT_KILL_GRACE_MS', 'DEFAULT_MAX_EVENTS', 'DEFAULT_MAX_OUTPUT_CHARS', 'DEFAULT_MAX_RUNS',
    'DEFAULT_TIMEOUT_MS', 'MAX_MESSAGE_CHARS', 'MAX_PROMPT_CHARS', 'TERMINAL', 'TERMINAL_LIMITS', 'buildPrompt', 'claudeStateFile', 'commandFor', 'createRepoResolver',
    'createRunManager', 'createStreamParser', 'createTerminalManager', 'createThreadService', 'createThreadStore', 'detectProviders', 'findOnPath', 'listSkills', 'loadSkill', 'resolveProvider', 'summarizeTool', 'trustDirectories', 'validateModel', 'validateSessionId',
  ]);
});
