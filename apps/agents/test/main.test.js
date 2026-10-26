import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultTokenFile, main, onProcessSignal } from '../src/main.js';

async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-main-'));
  const reposFile = path.join(dir, 'repos.json');
  await writeFile(reposFile, JSON.stringify({ repos: [{ name: 'api', url: 'https://github.com/o/api.git', technologies: ['nestjs'], targets: ['claude'] }] }));
  const skillsDir = path.join(dir, 'skills');
  await mkdir(path.join(skillsDir, 'nx', 'monorepo'), { recursive: true });
  await writeFile(path.join(skillsDir, 'nx', 'monorepo', 'SKILL.md'), '---\nname: x\ndescription: d\n---\nbody');
  const tokenFile = path.join(dir, 'state', 'agents.token');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const args = ['--repos', reposFile, '--workspace', dir, '--skills', skillsDir, '--port', '0', '--token-file', tokenFile];
  return { dir, args, tokenFile, skillsDir, reposFile };
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
  assert.match(lines[0], new RegExp(`agents server on http://localhost:${port} \\(token: .*agents.token\\)`));
  assert.match(lines[1], /default provider claude-cli; installed: copilot/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 401);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(health, { providers: { available: ['copilot'], default: 'claude-cli' }, repos: ['api'] });
});

test('main says so when no agent CLI is installed', async (t) => {
  const { args } = await workspace(t);
  const lines = [];
  const server = await main(args, { log: (line) => lines.push(line), detect: () => [], onSignal: noSignals, env: {} });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.match(lines[1], /installed: none/);
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

test('SIGINT/SIGTERM close the server and remove the token', async (t) => {
  const { args, tokenFile } = await workspace(t);
  let handler;
  const server = await main(args, { log: quiet, detect: () => [], env: {}, onSignal: (signals, fn) => { assert.deepEqual(signals, ['SIGINT', 'SIGTERM']); handler = fn; } });
  assert.ok(existsSync(tokenFile));
  handler();
  await once(server, 'close');
  await waitFor(() => !existsSync(tokenFile));
});

test('a port that is already taken fails the start and leaves no token behind', async (t) => {
  const { args, tokenFile } = await workspace(t);
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const port = String(blocker.address().port);
  const taken = [...args.slice(0, args.indexOf('--port') + 1), port, ...args.slice(args.indexOf('--port') + 2)];
  await assert.rejects(main(taken, { log: quiet, detect: () => [], onSignal: noSignals, env: {} }), (err) => err.code === 'EADDRINUSE');
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
