import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookSettings, installHooks } from '../src/hooks.js';
import path from 'node:path';

test('hookSettings maps the four events to their commands', () => {
  const s = hookSettings('oc-be', '/ws/.maggie/board.json', { command: 'node /a/bin/workspace.js' });
  const cmd = (e) => s.hooks[e][0].hooks[0].command;
  assert.equal(s.hooks.UserPromptSubmit[0].matcher, undefined);
  assert.equal(cmd('UserPromptSubmit'),
    'node /a/bin/workspace.js status oc-be inprogress --board /ws/.maggie/board.json --event UserPromptSubmit');
  assert.equal(s.hooks.Notification[0].matcher, 'permission_prompt|idle_prompt');
  assert.equal(cmd('Notification'),
    'node /a/bin/workspace.js status oc-be question --board /ws/.maggie/board.json --event Notification');
  assert.equal(cmd('Stop'),
    'node /a/bin/workspace.js status oc-be question --board /ws/.maggie/board.json --event Stop');
  assert.equal(s.hooks.Stop[0].hooks[0].type, 'command');
  assert.equal(s.hooks.SessionEnd[0].matcher, undefined);
  assert.equal(cmd('SessionEnd'), 'node /a/bin/workspace.js session-end oc-be --board /ws/.maggie/board.json');
});

test('hookSettings appends --worktree to status commands but not session-end when a worktree is given', () => {
  const s = hookSettings('oc-be', '/b.json', { command: 'maggie-workspace', worktree: 'feat/login' });
  const cmd = (e) => s.hooks[e][0].hooks[0].command;
  assert.equal(cmd('UserPromptSubmit'),
    'maggie-workspace status oc-be inprogress --board /b.json --event UserPromptSubmit --worktree feat/login');
  assert.equal(cmd('Stop'),
    'maggie-workspace status oc-be question --board /b.json --event Stop --worktree feat/login');
  assert.equal(cmd('SessionEnd'), 'maggie-workspace session-end oc-be --board /b.json');
});

test('hookSettings omits the worktree flag when no worktree is given', () => {
  const s = hookSettings('a', '/b.json');
  assert.ok(!s.hooks.Stop[0].hooks[0].command.includes('--worktree'));
});

test('installHooks forwards the worktree flag into the written commands', async () => {
  let written;
  await installHooks('/ws/a', 'a', '/b.json', {
    command: 'maggie-workspace',
    worktree: 'feat/login',
    read: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; },
    write: async (_f, data) => { written = JSON.parse(data); },
    ensureDir: async () => {},
  });
  assert.match(written.hooks.UserPromptSubmit[0].hooks[0].command, /--worktree feat\/login$/);
});

test('hookSettings defaults the command to maggie-workspace', () => {
  const s = hookSettings('a', '/b.json');
  assert.match(s.hooks.Stop[0].hooks[0].command, /^maggie-workspace status a question /);
  assert.match(s.hooks.SessionEnd[0].hooks[0].command, /^maggie-workspace session-end a /);
});

test('installHooks writes a fresh settings.local.json when none exists', async () => {
  const writes = [];
  const res = await installHooks('/ws/oc-be', 'oc-be', '/b.json', {
    command: 'maggie-workspace',
    read: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; },
    write: async (file, data) => writes.push({ file, data }),
    ensureDir: async () => {},
  });
  assert.equal(res.file, path.join('/ws/oc-be', '.claude', 'settings.local.json'));
  assert.equal(writes.length, 1);
  assert.ok(JSON.parse(writes[0].data).hooks.Stop);
  assert.ok(JSON.parse(writes[0].data).hooks.SessionEnd);
});

test('installHooks merges hooks while preserving existing unrelated settings', async () => {
  let written;
  await installHooks('/ws/a', 'a', '/b.json', {
    read: async () => JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: { PreToolUse: ['keep'] } }),
    write: async (_f, data) => { written = JSON.parse(data); },
    ensureDir: async () => {},
  });
  assert.deepEqual(written.permissions, { allow: ['Bash'] });
  assert.deepEqual(written.hooks.PreToolUse, ['keep']);
  assert.ok(written.hooks.UserPromptSubmit);
});

test('installHooks rethrows non-ENOENT read errors', async () => {
  await assert.rejects(() => installHooks('/ws/a', 'a', '/b.json', {
    read: async () => { const e = new Error('boom'); e.code = 'EACCES'; throw e; },
    write: async () => {}, ensureDir: async () => {},
  }), /boom/);
});
