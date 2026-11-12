import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planInstall } from '../src/installers.js';

const onlyMarker = (workDir, marker) => async (p) => p === path.join(workDir, marker);

test('node project resolves to pnpm install --prefer-offline by default', async () => {
  const plan = await planInstall('/w/app', {
    exists: onlyMarker('/w/app', 'package.json'),
    platform: 'linux',
  });
  assert.deepEqual(plan, {
    name: 'node', label: 'pnpm', command: 'pnpm', args: ['install', '--prefer-offline'],
  });
});

test('node project uses --offline in strict mode', async () => {
  const plan = await planInstall('/w/app', {
    exists: onlyMarker('/w/app', 'package.json'),
    platform: 'linux',
    offline: true,
  });
  assert.deepEqual(plan.args, ['install', '--offline']);
});

test('maven project resolves to dependency:go-offline with the system mvn', async () => {
  const plan = await planInstall('/w/app', {
    exists: onlyMarker('/w/app', 'pom.xml'),
    platform: 'linux',
  });
  assert.deepEqual(plan, {
    name: 'maven', label: 'mvn', command: 'mvn', args: ['dependency:go-offline'],
  });
});

test('maven project uses -o in strict offline mode', async () => {
  const plan = await planInstall('/w/app', {
    exists: onlyMarker('/w/app', 'pom.xml'),
    platform: 'linux',
    offline: true,
  });
  assert.deepEqual(plan.args, ['-o', 'dependency:go-offline']);
});

test('maven project prefers the repo wrapper when present', async () => {
  const wrapper = path.join('/w/app', 'mvnw');
  const exists = async (p) => p === path.join('/w/app', 'pom.xml') || p === wrapper;
  const plan = await planInstall('/w/app', { exists, platform: 'linux' });
  assert.equal(plan.command, wrapper);
});

test('no recognised marker yields null', async () => {
  const plan = await planInstall('/w/app', { exists: async () => false, platform: 'linux' });
  assert.equal(plan, null);
});

test('platform and offline default when omitted', async () => {
  const plan = await planInstall('/w/app', { exists: onlyMarker('/w/app', 'package.json') });
  const expectedPnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  assert.equal(plan.command, expectedPnpm);
  assert.deepEqual(plan.args, ['install', '--prefer-offline']);
});
