import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { USAGE, main } from './maggie.js';

// Fakes recording what the launcher starts and with which arguments.
function setup() {
  const calls = [];
  const agents = new EventEmitter();
  const logs = [];
  const exits = [];
  const signals = [];
  const deps = {
    runBoard: async (args, opts) => { calls.push(['board', args, opts]); },
    runServer: async (args) => { calls.push(['server', args]); return agents; },
    runSync: async (args) => { calls.push(['sync', args]); },
    runWorkspace: async (args) => { calls.push(['workspace', args]); },
    log: (line) => logs.push(line),
    proc: { once: (signal, handler) => signals.push([signal, handler]), exit: (code) => exits.push(code) },
  };
  return { calls, agents, logs, exits, signals, deps };
}

test('--help prints the usage and starts nothing', async () => {
  const { calls, logs, deps } = setup();
  await main(['--help'], deps);
  await main(['-h'], deps);
  assert.deepEqual(logs, [USAGE, USAGE]);
  assert.deepEqual(calls, []);
});

test('sync and workspace run their command with the remaining arguments', async () => {
  const { calls, deps } = setup();
  await main(['sync', '--dry-run', '--config', 'a.json'], deps);
  await main(['workspace', '--workspace', 'wk'], deps);
  assert.deepEqual(calls, [['sync', ['--dry-run', '--config', 'a.json']], ['workspace', ['--workspace', 'wk']]]);
});

test('--board starts the board only, with every argument as given', async () => {
  const { calls, deps } = setup();
  await main(['--board', '--port', '5000', '--board=/tmp/b.json'], deps);
  assert.deepEqual(calls, [['board', ['--port', '5000', '--board=/tmp/b.json'], undefined]]);
});

test('--board with a value stays the board file, not the mode', async () => {
  const { calls, deps } = setup();
  await main(['--server', '--board', 'b.json'], deps);
  assert.deepEqual(calls, [['server', ['--board', 'b.json']]]);
});

test('--server starts the server only, with every argument as given', async () => {
  const { calls, deps } = setup();
  await main(['--server', '--repos', 'repos.json', '--port', '5001', '--trust-repos'], deps);
  assert.deepEqual(calls, [['server', ['--repos', 'repos.json', '--port', '5001', '--trust-repos']]]);
});

test('with no mode both start, the server first, and each gets its own options', async () => {
  const { calls, deps } = setup();
  await main([
    '--config-repo', 'https://x/y.git', '--config-file=c.json', '--port', '5000', '--ci-interval=30',
    '--provider', 'claude', '--no-terminal', '--allow-origin', 'http://a', '--allow-origin', 'http://b',
  ], deps);
  assert.deepEqual(calls.map(([name]) => name), ['server', 'board']);
  assert.deepEqual(calls[0][1], [
    '--config-repo', 'https://x/y.git', '--config-file', 'c.json',
    '--provider', 'claude', '--no-terminal', '--allow-origin', 'http://a', '--allow-origin', 'http://b',
  ]);
  assert.deepEqual(calls[1][1], ['--config-repo', 'https://x/y.git', '--config-file', 'c.json', '--port', '5000', '--ci-interval', '30']);
});

test('--board --server together is the same as neither', async () => {
  const { calls, deps } = setup();
  await main(['--board', '--server', '--repos', 'r.json'], deps);
  assert.deepEqual(calls.map(([name]) => name), ['server', 'board']);
  assert.deepEqual(calls[0][1], ['--repos', 'r.json']);
  assert.deepEqual(calls[1][1], []);
});

test('with both running, --server-port is the server\'s port and the board is pointed at it', async () => {
  const { calls, deps } = setup();
  await main(['--repos', 'r.json', '--server-port', '5100', '--token-file', '/t/agents.token'], deps);
  assert.deepEqual(calls[0][1], ['--repos', 'r.json', '--port', '5100', '--token-file', '/t/agents.token']);
  assert.deepEqual(calls[1][1], ['--agents-url', 'http://127.0.0.1:5100', '--agents-token-file', '/t/agents.token']);
});

test('an explicit board address or token file is not overridden', async () => {
  const { calls, deps } = setup();
  await main([
    '--server-port', '5100', '--agents-url', 'http://127.0.0.1:9', '--token-file', '/t', '--agents-token-file', '/u',
  ], deps);
  assert.deepEqual(calls[1][1], ['--agents-url', 'http://127.0.0.1:9', '--agents-token-file', '/u']);
});

test('Ctrl-C waits for the server to close before the process exits', async () => {
  const { calls, agents, exits, signals, deps } = setup();
  await main([], deps);
  const { proc } = calls[1][2];
  const handler = () => {};
  proc.once('SIGINT', handler);
  assert.deepEqual(signals, [['SIGINT', handler]]);
  const exited = proc.exit(0);
  await Promise.resolve();
  assert.deepEqual(exits, []);
  agents.emit('close');
  await exited;
  assert.deepEqual(exits, [0]);
});

test('an unknown option or a missing value is refused before anything starts', async () => {
  const { calls, deps } = setup();
  await assert.rejects(() => main(['--nope'], deps), /Unknown option: --nope/);
  await assert.rejects(() => main(['positional'], deps), /Unknown option: positional/);
  await assert.rejects(() => main(['--constructor'], deps), /Unknown option: --constructor/);
  await assert.rejects(() => main(['--port'], deps), /Missing value for --port/);
  assert.deepEqual(calls, []);
});
