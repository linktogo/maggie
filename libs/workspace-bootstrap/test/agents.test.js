import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, DEFAULT_AGENT, agentSpec } from '../src/agents.js';

test('the registry exposes claude and copilot, with claude as the default', () => {
  assert.deepEqual(AGENTS, ['claude', 'copilot']);
  assert.equal(DEFAULT_AGENT, 'claude');
  assert.equal(agentSpec().id, 'claude');
});

test('each agent knows where its settings file lives', () => {
  assert.deepEqual(agentSpec('claude').settingsFile, ['.claude', 'settings.local.json']);
  assert.deepEqual(agentSpec('copilot').settingsFile, ['.github', 'copilot', 'settings.local.json']);
});

test('flattenHooks reads each agent-specific hook shape back to { event: command }', () => {
  const claude = agentSpec('claude');
  const claudeHooks = claude.hookSettings('a', '/b.json', { command: 'cli' }).hooks;
  assert.equal(
    claude.flattenHooks(claudeHooks).Stop,
    claudeHooks.Stop[0].hooks[0].command,
  );
  assert.equal(claude.flattenHooks(undefined).Stop, undefined);

  const copilot = agentSpec('copilot');
  const copilotHooks = copilot.hookSettings('a', '/b.json', { command: 'cli' }).hooks;
  assert.equal(
    copilot.flattenHooks(copilotHooks).agentStop,
    copilotHooks.agentStop[0].command,
  );
});

test('an unknown agent is rejected by name', () => {
  assert.throws(() => agentSpec('cursor'), /Unknown agent "cursor" \(known: claude, copilot\)/);
});
