import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pnpmCommand, launchCommand, mavenCommand } from '../src/platform.js';

test('pnpmCommand uses the .cmd shim on Windows', () => {
  assert.equal(pnpmCommand('win32'), 'pnpm.cmd');
});

test('pnpmCommand uses plain pnpm on POSIX platforms', () => {
  assert.equal(pnpmCommand('linux'), 'pnpm');
  assert.equal(pnpmCommand('darwin'), 'pnpm');
});

test('pnpmCommand defaults to the current platform', () => {
  const expected = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  assert.equal(pnpmCommand(), expected);
});

test('launchCommand quotes the path and cds on POSIX for claude', () => {
  assert.equal(launchCommand('claude', '/work/oc spaces', 'linux'), 'cd "/work/oc spaces" && claude');
});

test('launchCommand uses cd /d on Windows to allow drive changes', () => {
  assert.equal(launchCommand('claude', 'D:\\work\\oc', 'win32'), 'cd /d "D:\\work\\oc" && claude');
});

test('launchCommand passes the quoted dir straight to vscode', () => {
  assert.equal(launchCommand('vscode', '/work/oc', 'linux'), 'code "/work/oc"');
  assert.equal(launchCommand('vscode', 'C:\\work\\oc', 'win32'), 'code "C:\\work\\oc"');
});

test('launchCommand defaults to the current platform', () => {
  const expected = process.platform === 'win32'
    ? 'cd /d "/x" && claude'
    : 'cd "/x" && claude';
  assert.equal(launchCommand('claude', '/x'), expected);
});

test('mavenCommand prefers the repo wrapper when present (POSIX)', async () => {
  const wrapper = path.join('/work/app', 'mvnw');
  const cmd = await mavenCommand('/work/app', {
    exists: async (p) => p === wrapper,
    platform: 'linux',
  });
  assert.equal(cmd, wrapper);
});

test('mavenCommand prefers the .cmd wrapper on Windows', async () => {
  const wrapper = path.join('/work/app', 'mvnw.cmd');
  const cmd = await mavenCommand('/work/app', {
    exists: async (p) => p === wrapper,
    platform: 'win32',
  });
  assert.equal(cmd, wrapper);
});

test('mavenCommand falls back to system mvn on POSIX', async () => {
  const cmd = await mavenCommand('/work/app', { exists: async () => false, platform: 'linux' });
  assert.equal(cmd, 'mvn');
});

test('mavenCommand falls back to mvn.cmd on Windows', async () => {
  const cmd = await mavenCommand('/work/app', { exists: async () => false, platform: 'win32' });
  assert.equal(cmd, 'mvn.cmd');
});

test('mavenCommand defaults to the current platform', async () => {
  const expected = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
  const cmd = await mavenCommand('/work/app', { exists: async () => false });
  assert.equal(cmd, expected);
});
