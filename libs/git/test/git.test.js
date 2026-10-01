import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clone, createRepo } from '../src/git.js';

async function makeBareRemote() {
  const root = await mkdtemp(path.join(tmpdir(), 'git-'));
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '--bare', bare]);
  execFileSync('git', ['clone', bare, seed]);
  execFileSync('git', ['-C', seed, 'config', 'user.email', 't@t.dev']);
  execFileSync('git', ['-C', seed, 'config', 'user.name', 'T']);
  await writeFile(path.join(seed, 'README.md'), '# seed\n');
  execFileSync('git', ['-C', seed, 'add', '.']);
  execFileSync('git', ['-C', seed, 'commit', '-m', 'init']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'HEAD:main']);
  return { root, bare };
}

function configure(dir) {
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.dev']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
}

test('clone + checkoutBranch + commitAll + push round-trips through a bare remote', async () => {
  const { root, bare } = await makeBareRemote();
  const dest = path.join(root, 'work');
  const repo = await clone(bare, dest);
  configure(dest);
  await repo.checkoutBranch('maggie/update-skills');
  await writeFile(path.join(dest, 'new.txt'), 'hello\n');
  assert.equal(await repo.hasChanges(), true);
  await repo.commitAll('chore: sync');
  await repo.push('maggie/update-skills');

  const verify = path.join(root, 'verify');
  execFileSync('git', ['clone', '--branch', 'maggie/update-skills', bare, verify]);
  assert.equal(await readFile(path.join(verify, 'new.txt'), 'utf8'), 'hello\n');
});

test('hasChanges is false on a clean clone', async () => {
  const { root, bare } = await makeBareRemote();
  const dest = path.join(root, 'work');
  const repo = await clone(bare, dest);
  configure(dest);
  assert.equal(await repo.hasChanges(), false);
});

test('clone passes --depth when a depth is given, and omits it otherwise', async () => {
  const calls = [];
  const exec = async (file, args) => { calls.push(args); return ''; };
  await clone('url', '/dest', { exec, depth: 1 });
  await clone('url', '/dest', { exec });
  assert.deepEqual(calls[0], ['clone', '--depth', '1', '--', 'url', '/dest']);
  assert.deepEqual(calls[1], ['clone', '--', 'url', '/dest']);
});

test('createPR invokes gh with title and body', async () => {
  const calls = [];
  const repo = createRepo('/somewhere', {
    exec: async (file, args) => {
      calls.push({ file, args });
      return '';
    },
  });
  await repo.createPR('My title', 'My body');
  assert.deepEqual(calls[0], {
    file: 'gh',
    args: ['pr', 'create', '--title', 'My title', '--body', 'My body'],
  });
});

test('push omits -f by default and includes it when force is set', async () => {
  const calls = [];
  const repo = createRepo('/somewhere', {
    exec: async (file, args) => { calls.push(args); return ''; },
  });
  await repo.push('ci-status');
  await repo.push('maggie/update-skills', { force: true });
  assert.deepEqual(calls[0], ['push', '-u', 'origin', 'ci-status']);
  assert.deepEqual(calls[1], ['push', '-f', '-u', 'origin', 'maggie/update-skills']);
});

test('clone passes --branch --single-branch when a branch is given', async () => {
  const calls = [];
  const exec = async (file, args) => { calls.push(args); return ''; };
  await clone('url', '/dest', { exec, depth: 1, branch: 'ci-status' });
  assert.deepEqual(calls[0], ['clone', '--depth', '1', '--branch', 'ci-status', '--single-branch', '--', 'url', '/dest']);
});

test('fetchReset re-points the checkout at the remote branch', async () => {
  const calls = [];
  const repo = createRepo('/somewhere', { exec: async (file, args) => { calls.push(args); return ''; } });
  await repo.fetchReset('ci-status');
  assert.deepEqual(calls, [
    ['fetch', 'origin', 'ci-status'],
    ['reset', '--hard', 'origin/ci-status'],
  ]);
});

test('fetchReset discards a local-only commit and matches what a concurrent pusher landed', async () => {
  const { root, bare } = await makeBareRemote();

  // Our clone: makes a local commit that never gets pushed. The bare remote's
  // HEAD is unborn (makeBareRemote pushes to "main" without setting HEAD), so
  // each clone must check out "main" explicitly to land on the seeded history
  // rather than an empty, unrelated branch.
  const dest = path.join(root, 'work');
  const repo = await clone(bare, dest);
  configure(dest);
  execFileSync('git', ['-C', dest, 'checkout', 'main']);
  await writeFile(path.join(dest, 'mine.txt'), 'mine\n');
  await repo.commitAll('chore: local only');
  const localLog = execFileSync('git', ['-C', dest, 'log', '--oneline']).toString();
  assert.match(localLog, /local only/);

  // A concurrent pusher lands different content on the same branch first.
  const other = path.join(root, 'other');
  const otherRepo = await clone(bare, other);
  configure(other);
  execFileSync('git', ['-C', other, 'checkout', 'main']);
  await writeFile(path.join(other, 'theirs.txt'), 'theirs\n');
  await otherRepo.commitAll('chore: pushed by someone else');
  await otherRepo.push('main');

  await repo.fetchReset('main');

  const logAfterReset = execFileSync('git', ['-C', dest, 'log', '--oneline']).toString();
  assert.doesNotMatch(logAfterReset, /local only/);
  assert.match(logAfterReset, /pushed by someone else/);
  await assert.rejects(readFile(path.join(dest, 'mine.txt'), 'utf8'));
  assert.equal(await readFile(path.join(dest, 'theirs.txt'), 'utf8'), 'theirs\n');
});

test('configureIdentity sets the local committer', async () => {
  const calls = [];
  const repo = createRepo('/somewhere', { exec: async (file, args) => { calls.push(args); return ''; } });
  await repo.configureIdentity('maggie[bot]', 'bot@example.com');
  assert.deepEqual(calls, [
    ['config', 'user.name', 'maggie[bot]'],
    ['config', 'user.email', 'bot@example.com'],
  ]);
});
