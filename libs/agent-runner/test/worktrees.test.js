import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GIT_TIMEOUT_MS, createWorktreeManager, slugify } from '../src/worktrees.js';

const ID = 'th_0123456789abcdef';
const BRANCH = `factory/${ID}-fix-login`;
const WT = path.join('/wk', '.worktrees', 'api', ID);

/** Fake execFile: records calls, answers from a table of `args.join(' ')` → stdout | Error. */
function harness(table = {}, { present = true } = {}) {
  const calls = [];
  const execFile = async (cmd, args) => {
    calls.push({ cmd, args });
    const answer = table[args.join(' ')] ?? '';
    if (answer instanceof Error) throw answer;
    return { stdout: answer, stderr: '' };
  };
  const made = [];
  const logs = [];
  const manager = createWorktreeManager({
    workspace: '/wk', execFile, exists: () => present, mkdir: async (dir, opts) => { made.push([dir, opts]); }, log: (line) => logs.push(line),
  });
  return { manager, calls, made, logs, argv: () => calls.map((c) => c.args) };
}
const gitError = (stderr) => Object.assign(new Error('Command failed'), { stderr });

test('slugify keeps ascii words, strips accents, caps at 40, falls back to task', () => {
  assert.equal(slugify('Fix the Login page!'), 'fix-the-login-page');
  assert.equal(slugify('Réparer l’été'), 'reparer-l-ete');
  assert.equal(slugify('🚀 !!!'), 'task');
  assert.equal(slugify('a'.repeat(60)).length, 40);
  assert.doesNotMatch(slugify('x'.repeat(39) + ' y'), /-$/);
});

const CREATE_TABLE = { '-C /wk/api symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n' };

test('create fetches, reads origin/HEAD and adds the worktree', async () => {
  const { manager, argv, calls, made } = harness(CREATE_TABLE);
  const wt = await manager.create({ repo: 'api', repoDir: '/wk/api', threadId: ID, title: 'Fix login' });
  assert.deepEqual(wt, { path: WT, branch: BRANCH, base: 'origin/main' });
  assert.deepEqual(argv(), [
    ['-C', '/wk/api', 'fetch', 'origin'],
    ['-C', '/wk/api', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    ['-C', '/wk/api', 'worktree', 'add', '-b', BRANCH, WT, 'origin/main'],
  ]);
  assert.ok(calls.every((c) => c.cmd === 'git'));
  assert.deepEqual(made, [[path.dirname(WT), { recursive: true }]]);
});

test('create: fetch failure → AgentError git with git stderr', async () => {
  const { manager } = harness({ '-C /wk/api fetch origin': gitError('fatal: no remote\n') });
  await assert.rejects(
    manager.create({ repo: 'api', repoDir: '/wk/api', threadId: ID, title: 't' }),
    (err) => err.code === 'git' && /git fetch failed: fatal: no remote$/.test(err.message),
  );
});

test('create: an error without stderr falls back to its message', async () => {
  const { manager } = harness({ '-C /wk/api fetch origin': new Error('spawn git ENOENT') });
  await assert.rejects(
    manager.create({ repo: 'api', repoDir: '/wk/api', threadId: ID, title: 't' }),
    (err) => err.code === 'git' && /git fetch failed: spawn git ENOENT/.test(err.message),
  );
});

test('create: missing origin/HEAD → invalid mentioning git remote set-head origin -a', async () => {
  const { manager, argv } = harness({ '-C /wk/api symbolic-ref --short refs/remotes/origin/HEAD': gitError('fatal: ref not found') });
  await assert.rejects(
    manager.create({ repo: 'api', repoDir: '/wk/api', threadId: ID, title: 't' }),
    (err) => err.code === 'invalid' && /api has no origin\/HEAD/.test(err.message) && /git remote set-head origin -a/.test(err.message),
  );
  assert.equal(argv().length, 2);
});

test('create: worktree add failure → AgentError git', async () => {
  const { manager } = harness({
    ...CREATE_TABLE,
    [`-C /wk/api worktree add -b ${BRANCH} ${WT} origin/main`]: gitError('fatal: already exists'),
  });
  await assert.rejects(
    manager.create({ repo: 'api', repoDir: '/wk/api', threadId: ID, title: 'Fix login' }),
    (err) => err.code === 'git' && err.message === 'fatal: already exists',
  );
});

test('status: dirty when porcelain is not empty, ahead from rev-list --count', async () => {
  const { manager, argv } = harness({ [`-C ${WT} status --porcelain`]: ' M a.js\n', [`-C ${WT} rev-list --count origin/main..HEAD`]: '2\n' });
  assert.deepEqual(await manager.status({ path: WT, base: 'origin/main' }), { exists: true, dirty: true, ahead: 2 });
  assert.deepEqual(argv(), [['-C', WT, 'status', '--porcelain'], ['-C', WT, 'rev-list', '--count', 'origin/main..HEAD']]);
});

test('status: a clean worktree is not dirty', async () => {
  const { manager } = harness({ [`-C ${WT} rev-list --count origin/main..HEAD`]: '0' });
  assert.deepEqual(await manager.status({ path: WT, base: 'origin/main' }), { exists: true, dirty: false, ahead: 0 });
});

test('status: missing directory → { exists: false, dirty: false, ahead: 0 } without calling git', async () => {
  const { manager, calls } = harness({}, { present: false });
  assert.deepEqual(await manager.status({ path: WT, base: 'origin/main' }), { exists: false, dirty: false, ahead: 0 });
  assert.equal(calls.length, 0);
});

const REMOVE = { repoDir: '/wk/api', path: WT, branch: BRANCH, base: 'origin/main' };
const AHEAD = (n) => ({ [`-C /wk/api rev-list --count origin/main..${BRANCH}`]: String(n) });

test('remove: dirty without force → dirty, nothing removed', async () => {
  const { manager, argv } = harness({ [`-C ${WT} status --porcelain`]: '?? new.js' });
  await assert.rejects(manager.remove(REMOVE), (err) => err.code === 'dirty' && /uncommitted changes/.test(err.message));
  assert.deepEqual(argv(), [['-C', WT, 'status', '--porcelain']]);
});

test('remove: clean worktree without force is removed, then the empty branch deleted', async () => {
  const { manager, argv } = harness(AHEAD(0));
  assert.deepEqual(await manager.remove(REMOVE), { branchKept: false });
  assert.deepEqual(argv(), [
    ['-C', WT, 'status', '--porcelain'],
    ['-C', '/wk/api', 'worktree', 'remove', WT],
    ['-C', '/wk/api', 'rev-list', '--count', `origin/main..${BRANCH}`],
    ['-C', '/wk/api', 'branch', '-D', BRANCH],
  ]);
});

test('remove: force passes --force and skips the dirty check; ahead 0 deletes the branch → branchKept false', async () => {
  const { manager, argv } = harness({ [`-C ${WT} status --porcelain`]: ' M a.js', ...AHEAD(0) });
  assert.deepEqual(await manager.remove({ ...REMOVE, force: true }), { branchKept: false });
  assert.deepEqual(argv()[0], ['-C', '/wk/api', 'worktree', 'remove', '--force', WT]);
  assert.deepEqual(argv().at(-1), ['-C', '/wk/api', 'branch', '-D', BRANCH]);
});

test('remove: ahead > 0 keeps the branch → branchKept true', async () => {
  const { manager, argv } = harness(AHEAD(3));
  assert.deepEqual(await manager.remove(REMOVE), { branchKept: true });
  assert.ok(!argv().some((args) => args.includes('branch')));
});

test('remove: missing directory → worktree prune, then branch rule', async () => {
  const { manager, argv } = harness(AHEAD(0), { present: false });
  assert.deepEqual(await manager.remove(REMOVE), { branchKept: false });
  assert.deepEqual(argv(), [
    ['-C', '/wk/api', 'worktree', 'prune'],
    ['-C', '/wk/api', 'rev-list', '--count', `origin/main..${BRANCH}`],
    ['-C', '/wk/api', 'branch', '-D', BRANCH],
  ]);
});

test('remove: a branch already deleted (rev-list fails) is not fatal → branchKept true, logged', async () => {
  const { manager, argv, logs } = harness({ [`-C /wk/api rev-list --count origin/main..${BRANCH}`]: gitError('fatal: bad revision') });
  assert.deepEqual(await manager.remove(REMOVE), { branchKept: true });
  assert.ok(!argv().some((args) => args.includes('branch')));
  assert.deepEqual(logs, [`worktree ${WT}: branch ${BRANCH} kept: fatal: bad revision`]);
});

test('remove: branch -D failure is not fatal → branchKept true, logged', async () => {
  const { manager, logs } = harness({ ...AHEAD(0), [`-C /wk/api branch -D ${BRANCH}`]: gitError('error: branch is checked out') });
  assert.deepEqual(await manager.remove(REMOVE), { branchKept: true });
  assert.match(logs[0], /branch is checked out/);
});

test('remove: a worktree remove failure stays fatal', async () => {
  const { manager, argv } = harness({ [`-C /wk/api worktree remove ${WT}`]: gitError('fatal: locked') });
  await assert.rejects(manager.remove(REMOVE), (err) => err.code === 'git' && err.message === 'fatal: locked');
  assert.ok(!argv().some((args) => args.includes('rev-list')));
});

/** execFile whose calls stay pending until released, to observe ordering. */
function gated() {
  const log = [];
  const pending = [];
  const execFile = (cmd, args) => new Promise((resolve) => {
    log.push(`${args[1]} ${args[2]}`);
    pending.push(() => resolve({ stdout: args.includes('symbolic-ref') ? 'origin/main' : '', stderr: '' }));
  });
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) {
      while (pending.length) pending.shift()();
      await new Promise((r) => setImmediate(r));
    }
  };
  const manager = createWorktreeManager({ workspace: '/wk', execFile, exists: () => true, mkdir: async () => {} });
  return { manager, log, pending, flush };
}

test('create and remove are serialized per repoDir; a failure does not break the chain', async () => {
  const { manager, log, pending, flush } = gated();
  const a = manager.create({ repo: 'api', repoDir: '/wk/api', threadId: 'th_aaaaaaaaaaaaaaaa', title: 'a' });
  const b = manager.create({ repo: 'api', repoDir: '/wk/api', threadId: 'th_bbbbbbbbbbbbbbbb', title: 'b' });
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.length, 1); // b waits for a
  await flush();
  await Promise.all([a, b]);
  // a's three git calls all come before b's
  assert.deepEqual(log, Array(2).fill(['/wk/api fetch', '/wk/api symbolic-ref', '/wk/api worktree']).flat());

  const failing = harness({ '-C /wk/api fetch origin': gitError('down') });
  const first = failing.manager.create({ repo: 'api', repoDir: '/wk/api', threadId: ID, title: 't' });
  const second = failing.manager.remove(REMOVE);
  await assert.rejects(first, /down/);
  assert.deepEqual(await second, { branchKept: true });
});

test('operations on different repoDirs may interleave', async () => {
  const { manager, pending, flush } = gated();
  const a = manager.create({ repo: 'api', repoDir: '/wk/api', threadId: 'th_aaaaaaaaaaaaaaaa', title: 'a' });
  const b = manager.create({ repo: 'web', repoDir: '/wk/web', threadId: 'th_bbbbbbbbbbbbbbbb', title: 'b' });
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.length, 2); // both fetches in flight at once
  await flush();
  await Promise.all([a, b]);
});

test('every git call is non-interactive and bounded by a timeout', async () => {
  const seen = [];
  const execFile = async (cmd, args, opts) => { seen.push(opts); return { stdout: args.includes('symbolic-ref') ? 'origin/main' : '0', stderr: '' }; };
  const run = async (timeoutMs) => {
    seen.length = 0;
    const manager = createWorktreeManager({ workspace: '/wk', execFile, exists: () => true, mkdir: async () => {}, timeoutMs });
    await manager.create({ repo: 'api', repoDir: '/wk/api', threadId: ID, title: 't' });
    await manager.status({ path: WT, base: 'origin/main' });
    await manager.remove({ ...REMOVE, force: true });
  };
  await run(undefined);
  assert.ok(seen.length >= 8);
  for (const opts of seen) {
    assert.equal(opts.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(opts.timeout, GIT_TIMEOUT_MS);
  }
  assert.equal(GIT_TIMEOUT_MS, 60_000);
  await run(5);
  assert.ok(seen.every((opts) => opts.timeout === 5));
});

test('an unparsable rev-list count never deletes a branch: it is kept and logged', async () => {
  for (const out of ['', 'NaN', '-1', '1.5', 'fatal']) {
    const { manager, argv, logs } = harness(AHEAD(out));
    assert.deepEqual(await manager.remove(REMOVE), { branchKept: true });
    assert.ok(!argv().some((args) => args.includes('branch')));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /unexpected rev-list output/);
  }
  const { manager } = harness({ [`-C ${WT} rev-list --count origin/main..HEAD`]: 'x' });
  await assert.rejects(manager.status({ path: WT, base: 'origin/main' }), /unexpected rev-list output: x/);
});

test('the real execFile, existsSync and mkdir are the defaults', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agent-wt-'));
  const manager = createWorktreeManager({ workspace });
  assert.deepEqual(await manager.status({ path: path.join(workspace, 'gone'), base: 'origin/main' }), { exists: false, dirty: false, ahead: 0 });
  const withDirs = createWorktreeManager({ workspace, execFile: async () => ({ stdout: 'origin/main', stderr: '' }) });
  await withDirs.create({ repo: 'api', repoDir: '/x', threadId: ID, title: 't' });
  assert.ok(existsSync(path.join(workspace, '.worktrees', 'api')));
  // the default log is a silent no-op
  const quiet = createWorktreeManager({ workspace, execFile: async () => ({ stdout: '', stderr: '' }), exists: () => false });
  assert.deepEqual(await quiet.remove(REMOVE), { branchKept: true });
  await rm(workspace, { recursive: true, force: true });
});
