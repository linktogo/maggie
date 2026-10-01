import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCiReader } from './ciReader.js';

const NOW = '2026-07-29T18:41:12.000Z';

function update(over = {}) {
  return {
    repo: 'lk-myasso', actor: 'fabien', runId: 42, status: 'completed',
    conclusion: 'failure', workflow: 'CI', branch: 'feat/x', event: 'push',
    url: 'https://github.com/linktogo/lk-myasso/actions/runs/42',
    startedAt: NOW, sentAt: NOW, ...over,
  };
}

// Builds a fake checkout that a stubbed `exec` pretends to have cloned.
async function fixture(files = { 'fabien/lk-myasso.json': update() }) {
  const root = await mkdtemp(path.join(tmpdir(), 'ci-reader-'));
  const cacheDir = path.join(root, 'ci-status');
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(cacheDir, 'updates', rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  await mkdir(path.join(cacheDir, '.git'), { recursive: true });
  return { root, cacheDir, stateFile: path.join(root, 'ci.json') };
}

function reader(over, calls = []) {
  return createCiReader({
    statusRepo: 'https://github.com/linktogo/maggie.git',
    exec: async (file, args, opts) => { calls.push({ args, opts }); return ''; },
    now: () => NOW,
    logger: { log() {}, warn() {} },
    env: {},
    ...over,
  });
}

test('tick fetches, resets and writes the state cache', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const calls = [];
  await reader({ cacheDir, stateFile }, calls).tick();
  assert.deepEqual(calls[0].args, ['fetch', '--depth', '1', 'origin', 'ci-status']);
  assert.deepEqual(calls[1].args, ['reset', '--hard', 'origin/ci-status']);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.repos['lk-myasso'].users.fabien.runId, 42);
  assert.equal(state.lastSyncError, null);
  await rm(root, { recursive: true, force: true });
});

test('the reader never runs a git command that writes to the branch', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const calls = [];
  await reader({ cacheDir, stateFile }, calls).tick();
  assert.deepEqual(calls.map((c) => c.args[0]), ['fetch', 'reset']);
  await rm(root, { recursive: true, force: true });
});

test('a first-run clone is read-only too', async () => {
  const { root, stateFile } = await fixture();
  const calls = [];
  await reader({ cacheDir: path.join(root, 'absent'), stateFile }, calls).tick();
  assert.deepEqual(calls.map((c) => c.args[0]), ['clone']);
  await rm(root, { recursive: true, force: true });
});

test('tick clones when there is no checkout yet', async () => {
  const { root, stateFile } = await fixture();
  const cacheDir = path.join(root, 'absent');
  const calls = [];
  await reader({ cacheDir, stateFile }, calls).tick();
  assert.equal(calls[0].args[0], 'clone');
  assert.ok(calls[0].args.includes('ci-status'));
  await rm(root, { recursive: true, force: true });
});

test('tick skips malformed files and keeps the good ones', async () => {
  const warnings = [];
  const { root, cacheDir, stateFile } = await fixture({
    'fabien/lk-myasso.json': update(),
    'fabien/broken.json': 'not json',
    'alice/lk-myasso.json': update({ actor: 'fabien' }),
    '.gitkeep': '',
  });
  await reader({ cacheDir, stateFile, logger: { log() {}, warn: (m) => warnings.push(m) } }).tick();
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.deepEqual(Object.keys(state.repos['lk-myasso'].users), ['fabien']);
  assert.equal(warnings.length, 2);
  await rm(root, { recursive: true, force: true });
});

test('a git failure records the error and preserves the previous state', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  await reader({ cacheDir, stateFile }).tick();
  const failing = reader({
    cacheDir, stateFile,
    exec: async () => { throw new Error('fatal: could not read from remote'); },
  });
  await failing.tick();
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.repos['lk-myasso'].users.fabien.runId, 42);
  assert.match(state.lastSyncError, /could not read from remote/);
  await rm(root, { recursive: true, force: true });
});

test('an unreadable updates/ directory is treated as a failure, not an empty branch', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('running as root: chmod does not restrict root, so this would be vacuous');
    return;
  }
  const { root, cacheDir, stateFile } = await fixture();
  const r = reader({ cacheDir, stateFile });
  await r.tick();
  const before = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(before.repos['lk-myasso'].users.fabien.runId, 42);
  assert.equal(before.lastSyncError, null);

  const updatesRoot = path.join(cacheDir, 'updates');
  await chmod(updatesRoot, 0o000);
  try {
    await r.tick();
  } finally {
    // Restore permissions before rm cleans up, or the cleanup itself fails.
    await chmod(updatesRoot, 0o755);
  }

  const after = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(after.repos['lk-myasso'].users.fabien.runId, 42, 'previous cache must survive an EACCES on updates/');
  assert.match(after.lastSyncError, /EACCES|EPERM/);
  await rm(root, { recursive: true, force: true });
});

test('any readdir failure other than a missing entry is recorded as a sync error, not an empty state', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const r = reader({ cacheDir, stateFile });
  await r.tick();
  const before = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(before.repos['lk-myasso'].users.fabien.runId, 42);

  const denied = reader({
    cacheDir, stateFile,
    readdirImpl: async () => {
      const err = new Error('EACCES: permission denied, scandir');
      err.code = 'EACCES';
      throw err;
    },
  });
  await denied.tick();
  const after = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(after.repos['lk-myasso'].users.fabien.runId, 42, 'previous cache must survive a readdir failure');
  assert.match(after.lastSyncError, /EACCES/);
  await rm(root, { recursive: true, force: true });
});

test('a secondary failure writing the sync error does not reject tick(), and the lock is still released', async () => {
  const { root, cacheDir } = await fixture();
  // Point stateFile at a path whose directory cannot be created (a file sits
  // where a directory needs to go), so both the initial sync (git failure)
  // and the catch block's own recovery I/O (readState/writeState) fail.
  const brokenStateFile = path.join(cacheDir, 'not-a-dir-file', 'nested', 'ci.json');
  await writeFile(path.join(cacheDir, 'not-a-dir-file'), 'i am a file, not a directory');
  const execCalls = [];
  const brittle = reader({
    cacheDir, stateFile: brokenStateFile,
    exec: async (file, args) => { execCalls.push(args); throw new Error('fatal: could not read from remote'); },
  });
  await assert.doesNotReject(() => brittle.tick());
  assert.equal(execCalls.length, 1, 'the first (double-fault) tick must have run once');
  // Fire the *same* reader again: if `finally` had not reset `running`, this
  // would be swallowed by the in-flight guard and exec would never be
  // called a second time.
  await assert.doesNotReject(() => brittle.tick());
  assert.equal(execCalls.length, 2, 'a following tick on the same reader must still run, proving `running` was reset');
  await rm(root, { recursive: true, force: true });
});

test('the token never reaches the recorded error message', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const failing = reader({
    cacheDir, stateFile, token: 'ghp_supersecret',
    exec: async () => { throw new Error('failed to clone https://x-access-token:ghp_supersecret@github.com/x.git'); },
  });
  await failing.tick();
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.ok(!state.lastSyncError.includes('ghp_supersecret'));
  assert.match(state.lastSyncError, /\*\*\*/);
  await rm(root, { recursive: true, force: true });
});

test('a second tick is ignored while the first is still running', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  let started = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const r = reader({
    cacheDir, stateFile,
    exec: async () => { started += 1; await gate; return ''; },
  });
  const first = r.tick();
  await r.tick();
  // The truly concurrent second call must not have started any git command
  // while the first tick is still in flight.
  assert.equal(started, 1);
  release();
  await first;
  // A single completed tick legitimately issues two sequential git calls
  // (fetch then reset, see the first test above), so `started` lands on 2 —
  // not because a second tick ran, but because the one real tick does two
  // git commands. What this test guards is that it stops at 2, not 3+.
  assert.equal(started, 2);
  await rm(root, { recursive: true, force: true });
});

test('read resolves each repo state and reports repos with no contributor', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const r = reader({ cacheDir, stateFile });
  await r.tick();
  const payload = await r.read(['lk-myasso', 'lk-mind']);
  assert.equal(payload.repos['lk-myasso'].users.fabien.state, 'failure');
  assert.deepEqual(payload.repos['lk-mind'], { users: {} });
  await rm(root, { recursive: true, force: true });
});

test('read falls back to the state keys when no repo list is given', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const r = reader({ cacheDir, stateFile });
  await r.tick();
  assert.deepEqual(Object.keys((await r.read()).repos), ['lk-myasso']);
  await rm(root, { recursive: true, force: true });
});

test('an unconfigured reader runs no git and marks everything unavailable', async () => {
  const calls = [];
  const r = reader({ statusRepo: null, cacheDir: '/nope', stateFile: '/nope/ci.json' }, calls);
  await r.tick();
  const payload = await r.read(['lk-myasso']);
  assert.equal(calls.length, 0);
  assert.deepEqual(payload.repos['lk-myasso'], { users: {}, unavailable: 'status repo not configured' });
});

test('read tolerates a missing cache file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ci-reader-'));
  const r = reader({ cacheDir: path.join(root, 'c'), stateFile: path.join(root, 'ci.json') });
  assert.deepEqual((await r.read(['lk-mind'])).repos, { 'lk-mind': { users: {} } });
  await rm(root, { recursive: true, force: true });
});

test('the token travels as a scoped extraheader through the environment, never in the clone URL', async () => {
  const { root, stateFile } = await fixture();
  const calls = [];
  await reader({ cacheDir: path.join(root, 'absent'), stateFile, token: 'ghp_supersecret' }, calls).tick();
  const [clone] = calls;
  assert.ok(!clone.args.join(' ').includes('ghp_supersecret'));
  assert.deepEqual(clone.args.slice(-3), ['--', 'https://github.com/linktogo/maggie.git', path.join(root, 'absent')]);
  assert.equal(clone.opts.env.GIT_CONFIG_COUNT, '1');
  assert.equal(clone.opts.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  const expected = Buffer.from('x-access-token:ghp_supersecret').toString('base64');
  assert.equal(clone.opts.env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${expected}`);
  assert.equal(clone.opts.env.GIT_TERMINAL_PROMPT, '0');
  await rm(root, { recursive: true, force: true });
});

test('fetch reuses the same credentials and keeps its cwd; a non-URL remote gets an unscoped header', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const calls = [];
  await reader({ cacheDir, stateFile, token: 't', statusRepo: 'git@github.com:linktogo/maggie.git' }, calls).tick();
  const [fetchCall, resetCall] = calls;
  assert.equal(fetchCall.opts.cwd, cacheDir);
  assert.equal(fetchCall.opts.env.GIT_CONFIG_KEY_0, 'http.extraheader');
  assert.equal(resetCall.opts.env, undefined);
  await rm(root, { recursive: true, force: true });
});

test('without a token git gets no credential header but still never prompts', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const calls = [];
  await reader({ cacheDir, stateFile }, calls).tick();
  assert.equal(calls[0].opts.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(calls[0].opts.env.GIT_TERMINAL_PROMPT, '0');
  await rm(root, { recursive: true, force: true });
});

test('the credential header is appended after GIT_CONFIG_* entries already in the environment', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const calls = [];
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'bot', PATH: '/bin' };
  await reader({ cacheDir, stateFile, token: 't', env }, calls).tick();
  const got = calls[0].opts.env;
  assert.equal(got.GIT_CONFIG_COUNT, '2');
  assert.equal(got.GIT_CONFIG_KEY_0, 'user.name');
  assert.equal(got.GIT_CONFIG_KEY_1, 'http.https://github.com/.extraheader');
  assert.equal(got.PATH, '/bin');
  assert.deepEqual(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'bot', PATH: '/bin' }, 'the caller\'s env is not mutated');
  await rm(root, { recursive: true, force: true });
});
