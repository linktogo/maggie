import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGitHooks, HOOKS_PATH } from './install-git-hooks.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-git-hooks.js');

test('inside a git checkout, core.hooksPath is pointed at .githooks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hooks-'));
  execFileSync('git', ['init', '-q', root]);
  const logs = [];
  assert.equal(installGitHooks({ cwd: root, log: (m) => logs.push(m) }), true);
  assert.equal(execFileSync('git', ['-C', root, 'config', 'core.hooksPath'], { encoding: 'utf8' }).trim(), HOOKS_PATH);
  assert.match(logs[0], /core\.hooksPath set to \.githooks/);
  await rm(root, { recursive: true, force: true });
});

test('outside a git checkout (or without git) it does nothing and does not fail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hooks-'));
  const calls = [];
  const exec = (file, args) => { calls.push(args); throw new Error('not a git repository'); };
  assert.equal(installGitHooks({ cwd: root, exec, log: () => assert.fail('nothing to log') }), false);
  assert.equal(calls.length, 1);
  await rm(root, { recursive: true, force: true });
});

test('run as a script it installs the hooks in the current checkout', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hooks-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync(process.execPath, [SCRIPT], { cwd: root, stdio: 'ignore' });
  assert.equal(execFileSync('git', ['-C', root, 'config', 'core.hooksPath'], { encoding: 'utf8' }).trim(), HOOKS_PATH);
  await rm(root, { recursive: true, force: true });
});
