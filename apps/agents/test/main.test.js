import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createThreadStore } from '@linktogo/maggie-agent-runner';
import { defaultDbFile, defaultTokenFile, main, onProcessSignal } from '../src/main.js';
import { installSqliteWarningFilter } from '../src/warnings.js';

async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-main-'));
  const reposFile = path.join(dir, 'repos.json');
  await writeFile(reposFile, JSON.stringify({ repos: [{ name: 'api', url: 'https://github.com/o/api.git', technologies: ['nestjs'], targets: ['claude'] }] }));
  const skillsDir = path.join(dir, 'skills');
  await mkdir(path.join(skillsDir, 'nx', 'monorepo'), { recursive: true });
  await writeFile(path.join(skillsDir, 'nx', 'monorepo', 'SKILL.md'), '---\nname: x\ndescription: d\n---\nbody');
  const tokenFile = path.join(dir, 'state', 'agents.token');
  const dbFile = path.join(dir, 'state', 'factory.db');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const args = ['--repos', reposFile, '--workspace', dir, '--skills', skillsDir, '--port', '0', '--db', dbFile, '--token-file', tokenFile];
  return { dir, args, tokenFile, dbFile, skillsDir, reposFile };
}

const quiet = () => {};
const noSignals = () => {};

async function waitFor(condition) {
  for (let i = 0; i < 50 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(condition(), 'condition not met in time');
}

test('main starts the server, writes a private token and serves /health with it', async (t) => {
  const { args, tokenFile } = await workspace(t);
  const lines = [];
  const server = await main(args, { log: (line) => lines.push(line), detect: () => ['copilot'], onSignal: noSignals, env: {} });
  t.after(() => { server.closeAllConnections(); server.close(); });

  const token = (await readFile(tokenFile, 'utf8')).trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);

  const port = server.address().port;
  assert.match(lines[0], /^loading config from .*repos\.json$/);
  assert.match(lines[1], /^ {2}1 repositories, workspace .*, skills .*skills$/);
  assert.match(lines[2], new RegExp(`agents server on http://localhost:${port} \\(token: .*agents.token\\)`));
  assert.match(lines[3], /default provider claude-cli; installed: copilot/);
  await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } });
  await waitFor(() => lines.some((line) => /^GET \/health 200 \d+ms$/.test(line)));
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 401);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(health, { providers: { available: ['copilot'], default: 'claude-cli' }, repos: ['api'], terminal: { available: true } });
});

test('main says so when no agent CLI is installed', async (t) => {
  const { args } = await workspace(t);
  const lines = [];
  const server = await main(args, { log: (line) => lines.push(line), detect: () => [], onSignal: noSignals, env: {} });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.match(lines.at(-1), /installed: none/);
});

test('the default provider comes from --provider, else MAGGIE_AGENT_PROVIDER, else claude-cli', async (t) => {
  const { args } = await workspace(t);
  const boot = async (extra, env) => {
    const server = await main([...args, ...extra], { log: quiet, detect: () => [], onSignal: noSignals, env });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const token = (await readFile(args[args.indexOf('--token-file') + 1], 'utf8')).trim();
    const health = await (await fetch(`http://127.0.0.1:${server.address().port}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
    return health.providers.default;
  };
  assert.equal(await boot([], { MAGGIE_AGENT_PROVIDER: 'copilot' }), 'copilot');
  assert.equal(await boot(['--provider', 'claude-cli'], { MAGGIE_AGENT_PROVIDER: 'copilot' }), 'claude-cli');
  assert.equal(await boot([], {}), 'claude-cli');
});

test('the token and the skills default to ~/.maggie/agents.token and the repository skills', async (t) => {
  const { dir, reposFile } = await workspace(t);
  const home = path.join(dir, 'home');
  const server = await main(['--repos', reposFile, '--workspace', dir, '--port', '0'], { log: quiet, detect: () => [], onSignal: noSignals, env: {}, home });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal(defaultTokenFile(home), path.join(home, '.maggie', 'agents.token'));
  assert.ok(existsSync(defaultTokenFile(home)));
  const token = (await readFile(defaultTokenFile(home), 'utf8')).trim();
  const skills = await (await fetch(`http://127.0.0.1:${server.address().port}/skills`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.ok(skills.skills.some((skill) => skill.id.includes('/')));
});

test('main needs --repos, a known provider and an existing skills directory', async (t) => {
  const { args, tokenFile } = await workspace(t);
  const without = (flag) => { const i = args.indexOf(flag); return [...args.slice(0, i), ...args.slice(i + 2)]; };
  await assert.rejects(main(without('--repos'), { log: quiet, onSignal: noSignals, env: {} }), /Missing required --repos/);
  await assert.rejects(main([...args, '--provider', 'claude'], { log: quiet, onSignal: noSignals, env: {} }), /unknown provider: claude/);
  await assert.rejects(main([...without('--skills'), '--skills', '/nonexistent/skills'], { log: quiet, onSignal: noSignals, env: {} }), /Skills directory not found/);
  assert.equal(existsSync(tokenFile), false, 'a refused start must not leave a token behind');
});

test('main can load the repos from a config repository via --config-repo', async (t) => {
  const { args, tokenFile } = await workspace(t);
  const rest = args.slice(2);
  const calls = [];
  const loadConfigFromRepo = async (url, opts) => {
    calls.push([url, opts]);
    return { repos: [{ name: 'shared', url: 'https://github.com/o/shared.git', technologies: ['nestjs'], targets: ['claude'] }] };
  };
  const server = await main(['--config-repo', 'https://github.com/o/cfg.git', '--config-file', 'x.json', ...rest], { log: quiet, detect: () => [], env: {}, onSignal: noSignals, loadConfigFromRepo });
  t.after(() => server.close());
  assert.deepEqual(calls, [['https://github.com/o/cfg.git', { configFile: 'x.json' }]]);
  assert.ok(existsSync(tokenFile));
});

test('SIGINT/SIGTERM close the server and remove the token', async (t) => {
  const { args, tokenFile } = await workspace(t);
  let handler;
  const server = await main(args, { log: quiet, detect: () => [], env: {}, onSignal: (signals, fn) => { assert.deepEqual(signals, ['SIGINT', 'SIGTERM']); handler = fn; } });
  assert.ok(existsSync(tokenFile));
  handler();
  await once(server, 'close');
  await waitFor(() => !existsSync(tokenFile));
});

test('a port that is already taken fails the start and leaves the existing token file untouched', async (t) => {
  const { args, tokenFile } = await workspace(t);
  await mkdir(path.dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, 'running-instance-token\n');
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const port = String(blocker.address().port);
  const taken = [...args.slice(0, args.indexOf('--port') + 1), port, ...args.slice(args.indexOf('--port') + 2)];
  await assert.rejects(main(taken, { log: quiet, detect: () => [], onSignal: noSignals, env: {} }), (err) => err.code === 'EADDRINUSE');
  assert.equal(await readFile(tokenFile, 'utf8'), 'running-instance-token\n');
});

test('a failed token write closes the server and rethrows', async (t) => {
  const { args, dir } = await workspace(t);
  const blocked = path.join(dir, 'blocked');
  await writeFile(blocked, 'a file, not a directory');
  const bad = [...args.slice(0, args.indexOf('--token-file') + 1), path.join(blocked, 'agents.token')];
  await assert.rejects(main(bad, { log: quiet, detect: () => [], onSignal: noSignals, env: {} }), (err) => err.code === 'ENOTDIR');
});

test('a stale token file is replaced by a private one with the new token', async (t) => {
  const { args, tokenFile } = await workspace(t);
  await mkdir(path.dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, 'stale\n', { mode: 0o644 });
  await chmod(tokenFile, 0o644);
  const server = await main(args, { log: quiet, detect: () => [], onSignal: noSignals, env: {} });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.match((await readFile(tokenFile, 'utf8')).trim(), /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
});

test('invalid --port and --timeout are refused before any token is written', async (t) => {
  const { args, tokenFile } = await workspace(t);
  const withOpt = (flag, value) => [...args, `${flag}=${value}`];
  const refuse = (flag, value, message) => assert.rejects(main(withOpt(flag, value), { log: quiet, onSignal: noSignals, env: {} }), message);
  for (const value of ['abc', '', '-1', '65536', '1.5']) await refuse('--port', value, new RegExp(`Invalid --port: ${value}`));
  for (const value of ['abc', '0', '-5', 'Infinity', '0.0']) await refuse('--timeout', value, new RegExp(`Invalid --timeout: ${value} \\(seconds, > 0\\)`));
  assert.equal(existsSync(tokenFile), false);
});

test('onProcessSignal registers the handler once per signal', () => {
  const proc = new EventEmitter();
  let calls = 0;
  onProcessSignal(['SIGINT', 'SIGTERM'], () => { calls += 1; }, proc);
  proc.emit('SIGINT');
  proc.emit('SIGINT');
  proc.emit('SIGTERM');
  assert.equal(calls, 2);
});

test('--trust-repos marks the checked-out repositories as trusted for Claude Code, and says so', async (t) => {
  const { dir, args } = await workspace(t);
  const home = path.join(dir, 'home');
  await mkdir(home);
  await mkdir(path.join(dir, 'api'));
  await writeFile(path.join(dir, 'repos2.json'), JSON.stringify({ repos: [
    { name: 'api', url: 'https://github.com/o/api.git', technologies: ['nestjs'], targets: ['claude'] },
    { name: 'ghost', url: 'https://github.com/o/ghost.git', technologies: ['nestjs'], targets: ['claude'] },
  ] }));
  const lines = [];
  const rest = args.slice(2);
  const server = await main(['--repos', path.join(dir, 'repos2.json'), '--trust-repos', ...rest], { log: (line) => lines.push(line), detect: () => [], env: {}, onSignal: noSignals, home });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const state = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(state, { projects: { [path.join(dir, 'api')]: { hasTrustDialogAccepted: true } } });
  assert.ok(lines.includes(`  trusted for Claude Code: ${path.join(dir, 'api')}`));
});

test('without --trust-repos the Claude Code state is never touched', async (t) => {
  const { dir, args } = await workspace(t);
  const home = path.join(dir, 'home');
  await mkdir(home);
  const server = await main(args, { log: quiet, detect: () => [], env: {}, onSignal: noSignals, home });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal(existsSync(path.join(home, '.claude.json')), false);
});

async function bearer(server, tokenFile) {
  const token = (await readFile(tokenFile, 'utf8')).trim();
  return { headers: { authorization: `Bearer ${token}` }, base: `http://127.0.0.1:${server.address().port}` };
}

test('the thread routes are wired to the store: /projects and /threads answer in the real server', async (t) => {
  const { args, tokenFile } = await workspace(t);
  const server = await main(args, { log: quiet, detect: () => [], env: {}, onSignal: noSignals });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { headers, base } = await bearer(server, tokenFile);
  const projects = await fetch(`${base}/projects`, { headers });
  assert.equal(projects.status, 200);
  assert.equal((await projects.json()).projects[0].repo, 'api');
  const threads = await fetch(`${base}/threads`, { headers });
  assert.equal(threads.status, 200);
  assert.deepEqual((await threads.json()).threads, []);
  const refused = await fetch(`${base}/threads`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'nope', message: 'hi' }) });
  assert.equal(refused.status, 404);
});

test('opens the database given with --db and recovers interrupted threads', async (t) => {
  const { args, dbFile, tokenFile } = await workspace(t);
  await mkdir(path.dirname(dbFile), { recursive: true });
  const seed = createThreadStore({ path: dbFile });
  const thread = seed.createThread({ repo: 'api', provider: 'claude-cli', title: 'half done' });
  seed.close();
  const lines = [];
  const server = await main(args, { log: (line) => lines.push(line), detect: () => [], env: {}, onSignal: noSignals });
  assert.ok(lines.includes('  recovered 1 interrupted thread(s)'));
  const { headers, base } = await bearer(server, tokenFile);
  const found = await (await fetch(`${base}/threads/${thread.id}`, { headers })).json();
  assert.notEqual(found.thread.status, 'running');
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

test('a start that cannot bind its port leaves the running threads of the live instance alone', async (t) => {
  const { args, dbFile } = await workspace(t);
  await mkdir(path.dirname(dbFile), { recursive: true });
  const seed = createThreadStore({ path: dbFile });
  const thread = seed.createThread({ repo: 'api', provider: 'claude-cli', title: 'still running elsewhere' });
  seed.close();
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const lines = [];
  const taken = [...args, '--port', String(blocker.address().port)];
  await assert.rejects(main(taken, { log: (line) => lines.push(line), detect: () => [], env: {}, onSignal: noSignals }), (err) => err.code === 'EADDRINUSE');
  assert.equal(lines.some((line) => /recovered/.test(line)), false);
  const check = createThreadStore({ path: dbFile });
  t.after(() => check.close());
  assert.equal(check.getThread(thread.id).status, 'running');
  assert.deepEqual(check.listMessages(thread.id), []);
});

test('the database file is private (0600), even when it already existed with wider rights', { skip: process.platform === 'win32' }, async (t) => {
  const { args, dbFile } = await workspace(t);
  const server = await main(args, { log: quiet, detect: () => [], env: {}, onSignal: noSignals });
  const mode = (await stat(dbFile)).mode & 0o777;
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
  assert.equal(mode, 0o600);
  await chmod(dbFile, 0o644);
  const again = await main(args, { log: quiet, detect: () => [], env: {}, onSignal: noSignals });
  t.after(() => { again.closeAllConnections(); again.close(); });
  assert.equal((await stat(dbFile)).mode & 0o777, 0o600);
});

test('says nothing about recovery when no thread was interrupted', async (t) => {
  const { args } = await workspace(t);
  const lines = [];
  const server = await main(args, { log: (line) => lines.push(line), detect: () => [], env: {}, onSignal: noSignals });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal(lines.some((line) => /recovered/.test(line)), false);
});

test('defaults the database to ~/.maggie/factory.db, in a private directory', async (t) => {
  const { dir, reposFile } = await workspace(t);
  const home = path.join(dir, 'home');
  assert.equal(defaultDbFile(home), path.join(home, '.maggie', 'factory.db'));
  const server = await main(['--repos', reposFile, '--workspace', dir, '--port', '0'], { log: quiet, detect: () => [], onSignal: noSignals, env: {}, home });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.ok(existsSync(defaultDbFile(home)));
  if (process.platform !== 'win32') assert.equal((await stat(path.dirname(defaultDbFile(home)))).mode & 0o777, 0o700);
});

test('refuses to start when the database cannot be opened', async (t) => {
  const { args, tokenFile } = await workspace(t);
  const openStore = () => { throw new Error('disk on fire'); };
  await assert.rejects(main(args, { log: quiet, detect: () => [], env: {}, onSignal: noSignals, openStore }), /Could not open the factory database .*factory\.db: disk on fire/);
  assert.equal(existsSync(tokenFile), false);
});

test('closes the database when the server stops, and when the start fails', async (t) => {
  const { args } = await workspace(t);
  let closed = 0;
  const openStore = (opts) => {
    const store = createThreadStore(opts);
    return { ...store, close() { closed += 1; store.close(); } };
  };
  const server = await main(args, { log: quiet, detect: () => [], env: {}, onSignal: noSignals, openStore });
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
  assert.equal(closed, 1);

  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const taken = [...args, '--port', String(blocker.address().port)];
  await assert.rejects(main(taken, { log: quiet, detect: () => [], env: {}, onSignal: noSignals, openStore }), (err) => err.code === 'EADDRINUSE');
  assert.equal(closed, 2);
});

test('the warning filter drops only SQLite experimental warnings', () => {
  const proc = new EventEmitter();
  const printed = [];
  proc.on('warning', () => printed.push('default listener'));
  installSqliteWarningFilter(proc, (line) => printed.push(line));
  proc.emit('warning', Object.assign(new Error('SQLite is an experimental feature and might change at any time'), { name: 'ExperimentalWarning' }));
  proc.emit('warning', Object.assign(new Error('Fetch is experimental'), { name: 'ExperimentalWarning' }));
  proc.emit('warning', Object.assign(new Error('SQLite note'), { name: 'DeprecationWarning' }));
  assert.deepEqual(printed, ['ExperimentalWarning: Fetch is experimental', 'DeprecationWarning: SQLite note']);
  assert.equal(proc.listenerCount('warning'), 1);
});

test('the warning filter defaults to process and console.error', (t) => {
  const printed = [];
  t.mock.method(console, 'error', (line) => printed.push(line));
  const before = process.listeners('warning');
  t.after(() => { process.removeAllListeners('warning'); for (const l of before) process.on('warning', l); });
  installSqliteWarningFilter();
  process.emit('warning', Object.assign(new Error('x'), { name: 'Warning' }));
  assert.deepEqual(printed, ['Warning: x']);
});

function fakeTerminals() {
  const fake = { options: null, killed: 0 };
  fake.create = (options) => {
    fake.options = options;
    return { available: async () => ({ ok: true }), killAll: () => { fake.killed += 1; } };
  };
  return fake;
}

async function health(server, tokenFile) {
  const token = (await readFile(tokenFile, 'utf8')).trim();
  return (await fetch(`http://127.0.0.1:${server.address().port}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
}

test('the terminal manager gets the repo resolver and the log, and serves the console', async (t) => {
  const { args, tokenFile, dir } = await workspace(t);
  const terminals = fakeTerminals();
  const server = await main(args, { log: quiet, detect: () => [], onSignal: noSignals, env: {}, createTerminals: terminals.create });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal(terminals.options.log, quiet);
  assert.throws(() => terminals.options.repos.resolve('api'), /not checked out/);
  await mkdir(path.join(dir, 'api'));
  assert.equal(terminals.options.repos.resolve('api'), path.join(dir, 'api'));
  assert.deepEqual((await health(server, tokenFile)).terminal, { available: true });
});

test('--no-terminal disables the console and says so', async (t) => {
  const { args, tokenFile } = await workspace(t);
  const terminals = fakeTerminals();
  const lines = [];
  const server = await main([...args, '--no-terminal'], { log: (line) => lines.push(line), detect: () => [], onSignal: noSignals, env: {}, createTerminals: terminals.create });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal(terminals.options, null);
  assert.ok(lines.includes('  console disabled (--no-terminal)'));
  assert.deepEqual((await health(server, tokenFile)).terminal, { available: false, reason: 'disabled' });
});

test('SIGINT/SIGTERM kill every open console', async (t) => {
  const { args } = await workspace(t);
  const terminals = fakeTerminals();
  let handler;
  const server = await main(args, { log: quiet, detect: () => [], env: {}, createTerminals: terminals.create, onSignal: (signals, fn) => { handler = fn; } });
  handler();
  await once(server, 'close');
  assert.equal(terminals.killed, 1);
});
