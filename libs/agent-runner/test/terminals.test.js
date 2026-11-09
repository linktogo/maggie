import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentError } from '../src/errors.js';
import { TERMINAL_LIMITS, createTerminalManager, ensureSpawnHelper } from '../src/terminals.js';

function fakePty() {
  const pty = { written: [], sizes: [], killed: false };
  pty.onData = (cb) => { pty.emitData = cb; };
  pty.onExit = (cb) => { pty.emitExit = cb; };
  pty.write = (data) => pty.written.push(data);
  pty.resize = (cols, rows) => pty.sizes.push([cols, rows]);
  pty.kill = () => { pty.killed = true; };
  return pty;
}

function harness(options = {}) {
  const spawned = [];
  const timers = [];
  const logs = [];
  let next = 0;
  const repos = {
    resolve(name) {
      if (name !== 'api' && name !== 'web') throw new AgentError('not-found', `unknown repository: ${name}`);
      return `/ws/${name}`;
    },
  };
  const manager = createTerminalManager({
    repos,
    loadPty: async () => ({
      spawn(file, args, opts) {
        const pty = fakePty();
        spawned.push({ file, args, opts, pty });
        return pty;
      },
    }),
    env: { SHELL: '/bin/zsh', HOME: '/home/me' },
    randomId: () => String(next++).padStart(16, '0'),
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
    log: (line) => logs.push(line),
    ...options,
  });
  const fire = () => timers.filter((t) => !t.cleared && !t.fired).forEach((t) => { t.fired = true; t.fn(); });
  return { manager, spawned, timers, logs, fire };
}

const OPEN = { repo: 'api', cols: 80, rows: 24 };

test('limits are the ones the spec pins', () => {
  assert.deepEqual(TERMINAL_LIMITS, { maxTerminals: 4, graceMs: 5000, bufferBytes: 65536, maxInputBytes: 65536, maxCols: 500, maxRows: 200 });
});

test('open spawns the shell in the repo with a login flag and xterm-256color', async () => {
  const { manager, spawned, logs } = harness();
  const terminal = await manager.open(OPEN);
  assert.deepEqual(terminal, { id: 'tm_0000000000000000', repo: 'api', cwd: '/ws/api' });
  assert.equal(spawned[0].file, '/bin/zsh');
  assert.deepEqual(spawned[0].args, ['-l']);
  assert.deepEqual(spawned[0].opts, {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: '/ws/api', env: { SHELL: '/bin/zsh', HOME: '/home/me' }, encoding: null,
  });
  assert.deepEqual(logs, ['[tm_0000000000000000] shell on api']);
  assert.equal(manager.size(), 1);
});

test('shell falls back to /bin/sh, and to ComSpec without -l on win32', async () => {
  const posix = harness({ env: {} });
  await posix.manager.open(OPEN);
  assert.equal(posix.spawned[0].file, '/bin/sh');

  const win = harness({ env: { ComSpec: 'C:\\Windows\\cmd.exe' }, platform: 'win32' });
  await win.manager.open(OPEN);
  assert.equal(win.spawned[0].file, 'C:\\Windows\\cmd.exe');
  assert.deepEqual(win.spawned[0].args, []);

  const bare = harness({ env: {}, platform: 'win32' });
  await bare.manager.open(OPEN);
  assert.equal(bare.spawned[0].file, 'cmd.exe');

  const explicit = harness({ shell: '/bin/bash' });
  await explicit.manager.open(OPEN);
  assert.equal(explicit.spawned[0].file, '/bin/bash');
});

test('the default id is 16 random hex digits', async () => {
  const { manager } = harness({ randomId: undefined });
  const { id } = await manager.open(OPEN);
  assert.match(id, /^tm_[0-9a-f]{16}$/);
});

test('open rejects an unknown repo with not-found', async () => {
  const { manager, spawned } = harness();
  await assert.rejects(manager.open({ ...OPEN, repo: 'nope' }), { code: 'not-found' });
  assert.equal(spawned.length, 0);
});

test('open rejects out-of-range or fractional sizes with invalid', async () => {
  const { manager, spawned } = harness();
  for (const size of [{ cols: 0, rows: 24 }, { cols: 501, rows: 24 }, { cols: 80, rows: 201 }, { cols: 1.5, rows: 24 }, { cols: '80', rows: 24 }]) {
    await assert.rejects(manager.open({ repo: 'api', ...size }), { code: 'invalid' });
  }
  assert.equal(spawned.length, 0);
});

test('the fifth open is busy while four are alive, and allowed once one exits', async () => {
  const { manager, spawned } = harness();
  for (let i = 0; i < 4; i += 1) await manager.open(OPEN);
  await assert.rejects(manager.open(OPEN), { code: 'busy' });
  spawned[0].pty.emitExit({ exitCode: 0, signal: 0 });
  await manager.open(OPEN);
  assert.equal(manager.size(), 4);
});

test('data is broadcast as Buffers; string chunks are converted from utf8', async () => {
  const { manager, spawned } = harness();
  const { id } = await manager.open(OPEN);
  const events = [];
  manager.subscribe(id, (event) => events.push(event));
  spawned[0].pty.emitData(Buffer.from([0xc3]));
  spawned[0].pty.emitData('é');
  assert.deepEqual(events, [
    { type: 'data', data: Buffer.from([0xc3]) },
    { type: 'data', data: Buffer.from('é') },
  ]);
});

test('a late subscriber gets the last 64 KiB replayed first', async () => {
  const { manager, spawned } = harness();
  const { id } = await manager.open(OPEN);
  const output = Buffer.alloc(70_000);
  for (let i = 0; i < output.length; i += 1) output[i] = i % 251;
  spawned[0].pty.emitData(output.subarray(0, 40_000));
  spawned[0].pty.emitData(output.subarray(40_000));
  const events = [];
  manager.subscribe(id, (event) => events.push(event));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, output.subarray(70_000 - 65_536));
});

test('exit before any subscriber is replayed to the first one', async () => {
  const { manager, spawned, logs } = harness();
  const { id } = await manager.open(OPEN);
  spawned[0].pty.emitData('bad shell\r\n');
  spawned[0].pty.emitExit({ exitCode: 127, signal: 0 });
  assert.equal(manager.size(), 0);
  assert.deepEqual(logs.at(-1), `[${id}] exited 127`);
  const events = [];
  manager.subscribe(id, (event) => events.push(event));
  assert.deepEqual(events, [
    { type: 'data', data: Buffer.from('bad shell\r\n') },
    { type: 'exit', code: 127, signal: null },
  ]);
  assert.throws(() => manager.write(id, 'ls\r'), { code: 'not-found' });
});

test('a signal exit is reported with its signal number', async () => {
  const { manager, spawned } = harness();
  const { id } = await manager.open(OPEN);
  const events = [];
  manager.subscribe(id, (event) => events.push(event));
  spawned[0].pty.emitExit({ exitCode: 0, signal: 15 });
  assert.deepEqual(events, [{ type: 'exit', code: 0, signal: 15 }]);
});

test('an exited terminal can be subscribed once only', async () => {
  const { manager, spawned } = harness();
  const { id } = await manager.open(OPEN);
  spawned[0].pty.emitExit({ exitCode: 0, signal: 0 });
  const unsubscribe = manager.subscribe(id, () => {});
  unsubscribe();
  assert.throws(() => manager.subscribe(id, () => {}), { code: 'not-found' });
});

test('subscribe to an unknown id throws not-found', () => {
  const { manager } = harness();
  assert.throws(() => manager.subscribe('tm_ffffffffffffffff', () => {}), { code: 'not-found' });
});

test('the last unsubscribe kills after graceMs unless someone resubscribes', async () => {
  const { manager, spawned, timers, fire } = harness();
  const { id } = await manager.open(OPEN);
  const first = manager.subscribe(id, () => {});
  assert.equal(timers[0].cleared, true); // the open-time timer
  first();
  assert.equal(timers.at(-1).ms, 5000);
  const second = manager.subscribe(id, () => {});
  fire();
  assert.equal(spawned[0].pty.killed, false);
  second();
  second(); // idempotent
  fire();
  assert.equal(spawned[0].pty.killed, true);
});

test('a terminal never subscribed is killed after graceMs', async () => {
  const { manager, spawned, timers, fire } = harness();
  await manager.open(OPEN);
  assert.equal(timers[0].ms, 5000);
  fire();
  assert.equal(spawned[0].pty.killed, true);
});

test('a grace timer firing after exit does nothing', async () => {
  const { manager, spawned, fire } = harness();
  await manager.open(OPEN);
  spawned[0].pty.emitExit({ exitCode: 0, signal: 0 });
  fire();
  assert.equal(spawned[0].pty.killed, false);
});

test('write and resize reach the pty', async () => {
  const { manager, spawned } = harness();
  const { id } = await manager.open(OPEN);
  manager.write(id, 'ls\r');
  manager.resize(id, 120, 40);
  assert.deepEqual(spawned[0].pty.written, ['ls\r']);
  assert.deepEqual(spawned[0].pty.sizes, [[120, 40]]);
  assert.throws(() => manager.resize(id, 0, 40), { code: 'invalid' });
});

test('write rejects more than 64 KiB of utf8 and non-strings', async () => {
  const { manager } = harness();
  const { id } = await manager.open(OPEN);
  assert.throws(() => manager.write(id, 'é'.repeat(32_769)), { code: 'too-large' });
  assert.throws(() => manager.write(id, 42), { code: 'invalid' });
  manager.write(id, 'é'.repeat(32_768));
});

test('write, resize and kill on an unknown id throw not-found', () => {
  const { manager } = harness();
  assert.throws(() => manager.write('tm_ffffffffffffffff', 'x'), { code: 'not-found' });
  assert.throws(() => manager.resize('tm_ffffffffffffffff', 80, 24), { code: 'not-found' });
  assert.throws(() => manager.kill('tm_ffffffffffffffff'), { code: 'not-found' });
});

test('kill kills the pty', async () => {
  const { manager, spawned } = harness();
  const { id } = await manager.open(OPEN);
  manager.kill(id);
  assert.equal(spawned[0].pty.killed, true);
});

test('killAll kills every live pty', async () => {
  const { manager, spawned } = harness();
  await manager.open(OPEN);
  await manager.open({ ...OPEN, repo: 'web' });
  spawned[1].pty.emitExit({ exitCode: 0, signal: 0 });
  manager.killAll();
  assert.equal(spawned[0].pty.killed, true);
  assert.equal(spawned[1].pty.killed, false);
});

test('available loads the module once and reports ok', async () => {
  let loads = 0;
  const { manager } = harness({ loadPty: async () => { loads += 1; return { spawn() {} }; } });
  assert.deepEqual(await manager.available(), { ok: true });
  assert.deepEqual(await manager.available(), { ok: true });
  assert.equal(loads, 1);
});

test('available reports the load error reason and open throws unavailable', async () => {
  const { manager } = harness({ loadPty: async () => { throw new Error('no prebuilt'); } });
  assert.deepEqual(await manager.available(), { ok: false, reason: 'no prebuilt' });
  await assert.rejects(manager.open(OPEN), { code: 'unavailable', message: 'no prebuilt' });
});

test('the default loader loads the real node-pty', async () => {
  const { manager } = harness({ loadPty: undefined });
  assert.deepEqual(await manager.available(), { ok: true });
});

test('the default log is silent', async () => {
  const { manager } = harness({ log: undefined });
  await manager.open(OPEN);
});

function fakeFs(modes) {
  const chmods = [];
  return {
    chmods,
    fs: {
      stat: async (file) => {
        if (!(file in modes)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { mode: modes[file] };
      },
      chmod: async (file, mode) => { chmods.push([file, mode]); },
    },
  };
}

const resolve = () => '/nm/node-pty/package.json';

test('ensureSpawnHelper restores the execute bit a prebuilt spawn-helper lost on install', async () => {
  const { fs, chmods } = fakeFs({ '/nm/node-pty/prebuilds/darwin-arm64/spawn-helper': 0o100644 });
  await ensureSpawnHelper({ platform: 'darwin', arch: 'arm64', resolve, fs });
  assert.deepEqual(chmods, [['/nm/node-pty/prebuilds/darwin-arm64/spawn-helper', 0o100755]]);
});

test('ensureSpawnHelper leaves an executable helper alone and skips missing layouts', async () => {
  const { fs, chmods } = fakeFs({ '/nm/node-pty/build/Release/spawn-helper': 0o100755 });
  await ensureSpawnHelper({ platform: 'linux', arch: 'x64', resolve, fs });
  assert.deepEqual(chmods, []);
});

test('ensureSpawnHelper does nothing on Windows', async () => {
  const { fs, chmods } = fakeFs({});
  await ensureSpawnHelper({ platform: 'win32', arch: 'x64', resolve: () => { throw new Error('not called'); }, fs });
  assert.deepEqual(chmods, []);
});

test('the real helper is executable once the default loader ran', async () => {
  const { manager } = harness({ loadPty: undefined });
  await manager.available();
  const { statSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  const root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  for (const dir of [path.join(root, 'prebuilds', `${process.platform}-${process.arch}`), path.join(root, 'build', 'Release')]) {
    try {
      assert.equal(statSync(path.join(dir, 'spawn-helper')).mode & 0o111, 0o111);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
});

test('a grace-killed terminal is removed once its shell exits', async () => {
  const { manager, spawned, fire } = harness();
  const { id } = await manager.open(OPEN);
  const unsubscribe = manager.subscribe(id, () => {});
  unsubscribe();
  spawned[0].pty.kill = () => spawned[0].pty.emitExit({ exitCode: 0, signal: 1 });
  fire();
  assert.equal(manager.size(), 0);
  assert.throws(() => manager.subscribe(id, () => {}), { code: 'not-found' });
});

test('nothing reaches a subscriber after the exit it was sent', async () => {
  const { manager, spawned } = harness();
  const { id } = await manager.open(OPEN);
  const events = [];
  manager.subscribe(id, (event) => events.push(event.type));
  spawned[0].pty.emitExit({ exitCode: 0, signal: 0 });
  spawned[0].pty.emitData('late');
  assert.deepEqual(events, ['exit']);
});
