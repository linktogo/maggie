import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRepoResolver } from '../src/repos.js';

const repos = [{ name: 'api' }, { name: 'pinned', path: '/abs/pinned' }, { name: 'ghost' }];
const exists = (dir) => dir !== path.join('/ws', 'ghost');

test('names lists the allowlisted repositories', () => {
  assert.deepEqual(createRepoResolver({ repos, workspace: '/ws', exists }).names(), ['api', 'pinned', 'ghost']);
});

test('a repository resolves to its pinned path, else to <workspace>/<name>', () => {
  const resolver = createRepoResolver({ repos, workspace: '/ws', exists });
  assert.equal(resolver.resolve('api'), path.join('/ws', 'api'));
  assert.equal(resolver.resolve('pinned'), path.resolve('/abs/pinned'));
});

test('a repository outside the allowlist is refused, however it is spelled', () => {
  const resolver = createRepoResolver({ repos, workspace: '/ws', exists });
  for (const name of ['nope', '../etc', '/etc/passwd']) {
    assert.throws(() => resolver.resolve(name), (err) => err.code === 'not-found' && /unknown repository/.test(err.message));
  }
});

test('an allowlisted repository that is not checked out is reported as such', () => {
  const resolver = createRepoResolver({ repos, workspace: '/ws', exists });
  assert.throws(() => resolver.resolve('ghost'), (err) => err.code === 'not-found' && /not checked out/.test(err.message));
});

test('the checkout is looked up on disk by default', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agent-repos-'));
  await mkdir(path.join(workspace, 'api'));
  const resolver = createRepoResolver({ repos: [{ name: 'api' }, { name: 'web' }], workspace });
  assert.equal(resolver.resolve('api'), path.join(workspace, 'api'));
  assert.throws(() => resolver.resolve('web'), /not checked out/);
  await rm(workspace, { recursive: true, force: true });
});
