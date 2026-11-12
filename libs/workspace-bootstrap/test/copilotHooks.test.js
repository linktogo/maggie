import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  COPILOT_SETTINGS_FILE, copilotHookSettings, flattenCopilotHooks, installCopilotHooks,
} from '../src/copilotHooks.js';

test('copilotHookSettings maps every Copilot lifecycle event to its command', () => {
  const s = copilotHookSettings('oc-be', '/ws/.maggie/board.json', { command: 'node /a/bin/workspace.js' });
  const cmd = (e) => s.hooks[e][0].command;
  assert.equal(cmd('sessionStart'),
    'node /a/bin/workspace.js messages oc-be --board /ws/.maggie/board.json --agent copilot');
  assert.equal(cmd('userPromptSubmitted'),
    'node /a/bin/workspace.js status oc-be inprogress --board /ws/.maggie/board.json --event userPromptSubmitted --agent copilot');
  assert.equal(cmd('notification'),
    'node /a/bin/workspace.js status oc-be question --board /ws/.maggie/board.json --event notification --agent copilot');
  assert.equal(cmd('agentStop'),
    'node /a/bin/workspace.js status oc-be question --board /ws/.maggie/board.json --event agentStop --agent copilot');
  assert.equal(cmd('sessionEnd'),
    'node /a/bin/workspace.js session-end oc-be --board /ws/.maggie/board.json --agent copilot');
  assert.equal(s.hooks.agentStop[0].type, 'command');
});

test('copilotHookSettings matches only the notification types that mean "blocked on a human"', () => {
  const s = copilotHookSettings('a', '/b.json');
  assert.equal(s.hooks.notification[0].matcher, 'permission_prompt|elicitation_dialog|agent_idle');
  assert.equal(s.hooks.agentStop[0].matcher, undefined);
  assert.equal(s.hooks.sessionStart[0].matcher, undefined);
});

test('copilotHookSettings defaults the command to maggie-workspace', () => {
  const s = copilotHookSettings('a', '/b.json');
  assert.match(s.hooks.agentStop[0].command, /^maggie-workspace status a question /);
});

test('copilotHookSettings appends --worktree to status commands only', () => {
  const s = copilotHookSettings('a', '/b.json', { worktree: 'feat/login' });
  const cmd = (e) => s.hooks[e][0].command;
  assert.match(cmd('userPromptSubmitted'), /--worktree feat\/login$/);
  assert.match(cmd('notification'), /--worktree feat\/login$/);
  assert.match(cmd('agentStop'), /--worktree feat\/login$/);
  assert.ok(!cmd('sessionEnd').includes('--worktree'));
  assert.ok(!cmd('sessionStart').includes('--worktree'));
});

test('copilotHookSettings omits the worktree flag when no worktree is given', () => {
  assert.ok(!copilotHookSettings('a', '/b.json').hooks.agentStop[0].command.includes('--worktree'));
});

test('flattenCopilotHooks reads the commands back, and tolerates a missing hooks block', () => {
  const { hooks } = copilotHookSettings('a', '/b.json');
  assert.equal(flattenCopilotHooks(hooks).agentStop, hooks.agentStop[0].command);
  assert.deepEqual(flattenCopilotHooks(undefined), {
    sessionStart: undefined, userPromptSubmitted: undefined,
    notification: undefined, agentStop: undefined, sessionEnd: undefined,
  });
});

test('installCopilotHooks writes a fresh .github/copilot/settings.local.json when none exists', async () => {
  const writes = [];
  const dirs = [];
  const res = await installCopilotHooks('/ws/oc-be', 'oc-be', '/b.json', {
    command: 'maggie-workspace',
    read: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; },
    write: async (file, data) => writes.push({ file, data }),
    ensureDir: async (dir) => dirs.push(dir),
  });
  assert.equal(res.file, path.join('/ws/oc-be', ...COPILOT_SETTINGS_FILE));
  assert.equal(dirs[0], path.join('/ws/oc-be', '.github', 'copilot'));
  assert.equal(writes.length, 1);
  assert.ok(JSON.parse(writes[0].data).hooks.agentStop);
});

test('installCopilotHooks merges hooks while preserving existing unrelated settings', async () => {
  let written;
  await installCopilotHooks('/ws/a', 'a', '/b.json', {
    read: async () => JSON.stringify({ disableAllHooks: false, hooks: { preToolUse: ['keep'] } }),
    write: async (_f, data) => { written = JSON.parse(data); },
    ensureDir: async () => {},
  });
  assert.equal(written.disableAllHooks, false);
  assert.deepEqual(written.hooks.preToolUse, ['keep']);
  assert.ok(written.hooks.userPromptSubmitted);
});

test('installCopilotHooks forwards the worktree flag into the written commands', async () => {
  let written;
  await installCopilotHooks('/ws/a', 'a', '/b.json', {
    worktree: 'feat/login',
    read: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; },
    write: async (_f, data) => { written = JSON.parse(data); },
    ensureDir: async () => {},
  });
  assert.match(written.hooks.userPromptSubmitted[0].command, /--worktree feat\/login$/);
});

test('installCopilotHooks rethrows non-ENOENT read errors', async () => {
  await assert.rejects(() => installCopilotHooks('/ws/a', 'a', '/b.json', {
    read: async () => { const e = new Error('boom'); e.code = 'EACCES'; throw e; },
    write: async () => {}, ensureDir: async () => {},
  }), /boom/);
});
