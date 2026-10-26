import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRunManager } from '../src/run.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end(data) { child.input = data; } });
  child.kill = (signal) => { child.killed = signal; };
  return child;
}

function harness(options = {}) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = fakeChild();
    calls.push({ command, args, opts, child });
    return child;
  };
  const manager = createRunManager({ spawn, now: () => new Date('2026-10-26T10:00:00.000Z'), ...options });
  return { manager, calls };
}

const START = { repo: 'api', cwd: '/ws/api', provider: 'claude-cli', prompt: 'fix the bug' };

test('start spawns the provider CLI in the checkout and writes the prompt to its stdin', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  assert.equal(calls[0].command, 'claude');
  assert.deepEqual(calls[0].args, ['-p']);
  assert.equal(calls[0].opts.cwd, '/ws/api');
  assert.equal(calls[0].child.input, 'fix the bug');
  assert.deepEqual(run, {
    id: 'run-1', repo: 'api', provider: 'claude-cli', model: null, skill: null, status: 'running',
    startedAt: '2026-10-26T10:00:00.000Z', finishedAt: null, exitCode: null, error: null,
  });
});

test('start passes the model and uses the Copilot CLI for the copilot provider', () => {
  const { manager, calls } = harness();
  manager.start({ ...START, repo: 'a', model: 'sonnet' });
  manager.start({ ...START, repo: 'b', provider: 'copilot' });
  assert.deepEqual(calls[0].args, ['-p', '--model', 'sonnet']);
  assert.equal(calls[1].command, 'copilot');
  assert.deepEqual(calls[1].args, ['--allow-all-tools']);
});

test('start with a skill records it and sends the skill as the instruction', () => {
  const { manager, calls } = harness();
  const run = manager.start({ ...START, prompt: undefined, skill: { id: 'nx/monorepo', body: 'Use affected.' } });
  assert.equal(run.skill, 'nx/monorepo');
  assert.match(calls[0].child.input, /^Apply the following skill/);
  assert.match(calls[0].child.input, /Use affected\./);
});

test('start refuses a bad model or an empty request before spawning anything', () => {
  const { manager, calls } = harness();
  assert.throws(() => manager.start({ ...START, model: '--evil' }), (err) => err.code === 'invalid');
  assert.throws(() => manager.start({ ...START, prompt: '' }), (err) => err.code === 'invalid');
  assert.equal(calls.length, 0);
});

test('one active run per repository; a finished one frees it', () => {
  const { manager, calls } = harness();
  manager.start(START);
  assert.throws(() => manager.start(START), (err) => err.code === 'busy' && /already active on api/.test(err.message));
  assert.doesNotThrow(() => manager.start({ ...START, repo: 'web' }));
  calls[0].child.emit('close', 0);
  assert.doesNotThrow(() => manager.start(START));
});

test('output is published as events, and the run ends succeeded on exit code 0', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  const seen = [];
  manager.subscribe(run.id, (event) => seen.push(event));
  const { child } = calls[0];
  child.stdout.emit('data', Buffer.from('hello'));
  child.stderr.emit('data', 'warn');
  child.emit('close', 0);

  assert.deepEqual(seen.map((e) => [e.seq, e.type]), [[1, 'status'], [2, 'stdout'], [3, 'stderr'], [4, 'status']]);
  assert.deepEqual(seen[1].data, { text: 'hello' });
  assert.deepEqual(seen[3].data, { status: 'succeeded', exitCode: 0, error: null });
  assert.equal(seen[3].at, '2026-10-26T10:00:00.000Z');
  assert.deepEqual(
    [manager.get(run.id).status, manager.get(run.id).exitCode, manager.get(run.id).finishedAt],
    ['succeeded', 0, '2026-10-26T10:00:00.000Z'],
  );
});

test('a late subscriber gets the history replayed, then live events until it unsubscribes', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  calls[0].child.stdout.emit('data', 'early');
  const seen = [];
  const unsubscribe = manager.subscribe(run.id, (event) => seen.push(event.type));
  assert.deepEqual(seen, ['status', 'stdout']);
  calls[0].child.stdout.emit('data', 'live');
  unsubscribe();
  calls[0].child.stdout.emit('data', 'ignored');
  assert.deepEqual(seen, ['status', 'stdout', 'stdout']);
});

test('subscribe to an unknown run returns null', () => {
  assert.equal(harness().manager.subscribe('run-99', () => {}), null);
});

test('a non-zero exit fails the run, with the exit code in the message', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  calls[0].child.emit('close', 2);
  assert.deepEqual(
    [manager.get(run.id).status, manager.get(run.id).exitCode, manager.get(run.id).error],
    ['failed', 2, '`claude` exited with code 2'],
  );
});

test('a CLI killed by a signal fails the run with an unknown exit code', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  calls[0].child.emit('close', null);
  assert.equal(manager.get(run.id).error, '`claude` exited with code unknown');
});

test('a CLI that cannot be started fails the run with an explicit message, once', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  calls[0].child.emit('error', new Error('spawn claude ENOENT'));
  calls[0].child.emit('close', -2);
  assert.equal(manager.get(run.id).status, 'failed');
  assert.equal(manager.get(run.id).error, 'Could not run `claude`: spawn claude ENOENT');
  assert.equal(manager.get(run.id).exitCode, null);
});

test('a spawn that throws fails the run instead of leaving the repository locked', () => {
  const manager = createRunManager({ spawn: () => { throw new Error('bad cwd'); } });
  const run = manager.start(START);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'Could not run `claude`: bad cwd');
  assert.doesNotThrow(() => manager.start(START));
});

test('cancel asks the CLI to stop; the run is cancelled once it has exited', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  assert.equal(manager.cancel(run.id).status, 'running');
  assert.equal(calls[0].child.killed, 'SIGTERM');
  calls[0].child.emit('close', null);
  assert.equal(manager.get(run.id).status, 'cancelled');
});

test('cancel of an unknown run is refused; of a finished one it is a no-op', () => {
  const { manager, calls } = harness();
  assert.throws(() => manager.cancel('run-99'), (err) => err.code === 'not-found');
  const run = manager.start(START);
  calls[0].child.emit('close', 0);
  assert.equal(manager.cancel(run.id).status, 'succeeded');
  assert.equal(calls[0].child.killed, undefined);
});

test('a run that exceeds the timeout is killed and ends timed-out', async () => {
  const { manager, calls } = harness({ timeoutMs: 20 });
  const run = manager.start(START);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls[0].child.killed, 'SIGTERM');
  calls[0].child.emit('close', null);
  assert.equal(manager.get(run.id).status, 'timed-out');
  assert.match(manager.get(run.id).error, /timed out after/);
});

test('only the most recent events are kept, sequence numbers keep counting', () => {
  const { manager, calls } = harness({ maxEvents: 3 });
  const run = manager.start(START);
  for (const text of ['a', 'b', 'c', 'd', 'e']) calls[0].child.stdout.emit('data', text);
  const seqs = [];
  manager.subscribe(run.id, (event) => seqs.push(event.seq));
  assert.deepEqual(seqs, [4, 5, 6]);
});

test('finished runs are pruned oldest first once maxRuns is exceeded', () => {
  const { manager, calls } = harness({ maxRuns: 2 });
  manager.start({ ...START, repo: 'a' });
  calls[0].child.emit('close', 0);
  manager.start({ ...START, repo: 'b' });
  calls[1].child.emit('close', 0);
  manager.start({ ...START, repo: 'c' });
  assert.deepEqual(manager.list().map((r) => r.id), ['run-3', 'run-2']);
});

test('active runs are never pruned', () => {
  const { manager } = harness({ maxRuns: 1 });
  manager.start({ ...START, repo: 'a' });
  manager.start({ ...START, repo: 'b' });
  assert.equal(manager.list().length, 2);
});

test('list is newest first and get returns null for an unknown run', () => {
  const { manager } = harness();
  manager.start({ ...START, repo: 'a' });
  manager.start({ ...START, repo: 'b' });
  assert.deepEqual(manager.list().map((r) => r.id), ['run-2', 'run-1']);
  assert.equal(manager.get('run-99'), null);
});

test('an EPIPE on the CLI stdin is ignored: the exit code decides the outcome', () => {
  const { manager, calls } = harness();
  const run = manager.start(START);
  assert.doesNotThrow(() => calls[0].child.stdin.emit('error', new Error('write EPIPE')));
  assert.equal(manager.get(run.id).status, 'running');
  calls[0].child.emit('close', 1);
  assert.equal(manager.get(run.id).status, 'failed');
});

test('the real child_process.spawn is used by default', async () => {
  // An empty PATH makes `claude` unspawnable: hermetic, and it proves the ENOENT message end to end.
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const manager = createRunManager({ timeoutMs: 5000 });
    const run = manager.start({ repo: 'x', cwd: process.cwd(), provider: 'claude-cli', prompt: 'hi' });
    await new Promise((resolve) => {
      const check = () => (manager.get(run.id).status === 'running' ? setTimeout(check, 20) : resolve());
      check();
    });
    assert.equal(manager.get(run.id).status, 'failed');
    assert.match(manager.get(run.id).error, /Could not run `claude`/);
  } finally {
    process.env.PATH = savedPath;
  }
});
