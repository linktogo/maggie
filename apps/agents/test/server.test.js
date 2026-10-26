import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentError, createRepoResolver, createRunManager } from '@linktogo/maggie-agent-runner';
import { createAgentsServer, isAuthorized, isLoopbackHost } from '../src/server.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on() {}, end(data) { child.input = data; } };
  child.kill = (signal) => { child.killed = signal; };
  return child;
}

const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function boot(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-server-'));
  const skillsDir = path.join(dir, 'skills');
  await mkdir(path.join(skillsDir, 'nx', 'monorepo'), { recursive: true });
  await writeFile(path.join(skillsDir, 'nx', 'monorepo', 'SKILL.md'), '---\nname: nx-monorepo\ndescription: Keep Nx tidy\n---\n\nUse affected.\n');
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = fakeChild();
    calls.push({ command, args, opts, child });
    return child;
  };
  const manager = options.manager ?? createRunManager({ spawn });
  const repos = createRepoResolver({ repos: [{ name: 'api' }, { name: 'web' }], workspace: dir, exists: () => true });
  const server = createAgentsServer({
    token: 'secret-token',
    manager,
    repos,
    skillsDir,
    providers: { detect: () => ['claude-cli'], defaultProvider: 'claude-cli' },
    ...options.server,
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (route, init = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
    ...init,
    headers: { authorization: 'Bearer secret-token', ...(init.headers ?? {}) },
  });
  return { call, calls, dir, port, manager };
}

test('isLoopbackHost only accepts loopback names', () => {
  for (const ok of ['localhost:4318', '127.0.0.1:4318', '[::1]:4318', 'localhost']) assert.equal(isLoopbackHost(ok), true, ok);
  for (const bad of ['evil.example', 'evil.example:4318', '127.0.0.1.evil.example', undefined, '', 'a b']) assert.equal(isLoopbackHost(bad), false, String(bad));
});

test('isAuthorized wants the exact bearer token', () => {
  assert.equal(isAuthorized('Bearer secret-token', 'secret-token'), true);
  assert.equal(isAuthorized(undefined, 'secret-token'), false);
  assert.equal(isAuthorized('Basic secret-token', 'secret-token'), false);
  assert.equal(isAuthorized('Bearer secret-tokeX', 'secret-token'), false);
  assert.equal(isAuthorized('Bearer short', 'secret-token'), false);
});

test('a request without the token is refused with 401', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('/health', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const bare = await fetch(`http://127.0.0.1:${(await boot(t)).port}/health`);
  assert.equal(bare.status, 401);
});

test('a request addressed to a non-loopback Host is refused with 403 (DNS rebinding)', async (t) => {
  const { port } = await boot(t);
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/health', headers: { host: 'evil.example:4318', authorization: 'Bearer secret-token' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('a request carrying an Origin is refused unless that origin is allowed', async (t) => {
  const { call } = await boot(t);
  const refused = await call('/health', { headers: { origin: 'http://evil.example' } });
  assert.equal(refused.status, 403);

  const allowed = await boot(t, { server: { allowedOrigins: ['http://localhost:4180'] } });
  assert.equal((await allowed.call('/health', { headers: { origin: 'http://localhost:4180' } })).status, 200);
  assert.equal((await allowed.call('/health', { headers: { origin: 'http://localhost:9' } })).status, 403);
});

test('GET /health reports the providers found, the default one and the allowed repositories', async (t) => {
  const { call } = await boot(t);
  const res = await call('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    providers: { available: ['claude-cli'], default: 'claude-cli' },
    repos: ['api', 'web'],
  });
});

test('GET /skills lists the skills of the library', async (t) => {
  const { call } = await boot(t);
  assert.deepEqual(await (await call('/skills')).json(), {
    skills: [{ id: 'nx/monorepo', techno: 'nx', name: 'monorepo', description: 'Keep Nx tidy' }],
  });
});

test('POST /runs starts the default provider in the checkout and answers 202 with the run', async (t) => {
  const { call, calls, dir } = await boot(t);
  const res = await call('/runs', post({ repo: 'api', prompt: 'fix the bug' }));
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.id, 'run-1');
  assert.equal(body.run.status, 'running');
  assert.equal(body.run.provider, 'claude-cli');
  assert.equal(calls[0].command, 'claude');
  assert.equal(calls[0].opts.cwd, path.join(dir, 'api'));
  assert.equal(calls[0].child.input, 'fix the bug');
});

test('POST /runs honours a per-request provider, model and skill', async (t) => {
  const { call, calls } = await boot(t);
  const res = await call('/runs', post({ repo: 'web', provider: 'copilot', model: 'gpt-5', skill: 'nx/monorepo', prompt: 'only libs' }));
  assert.equal(res.status, 202);
  assert.equal(calls[0].command, 'copilot');
  assert.deepEqual(calls[0].args, ['--allow-all-tools', '--model', 'gpt-5']);
  assert.match(calls[0].child.input, /Use affected\./);
  assert.match(calls[0].child.input, /Task:\nonly libs/);
});

test('POST /runs refuses what it cannot run', async (t) => {
  const { call } = await boot(t, { server: { bodyLimit: 200 } });
  const cases = [
    [post({ prompt: 'x' }), 400, /repo is required/],
    [post({ repo: 'api' }), 400, /prompt or a skill/],
    [post({ repo: 'api', prompt: 'x', provider: 'claude' }), 400, /unknown provider/],
    [post({ repo: 'api', prompt: 'x', model: '--evil' }), 400, /invalid model/],
    [post({ repo: 'api', skill: '../etc/passwd' }), 400, /invalid skill/],
    [post({ repo: 'nope', prompt: 'x' }), 404, /unknown repository/],
    [post({ repo: 'api', skill: 'nx/absent' }), 404, /unknown skill/],
    [{ method: 'POST', body: '{not json' }, 400, /invalid JSON/],
    [post({ repo: 'api', prompt: 'x'.repeat(500) }), 413, /too large/],
  ];
  for (const [init, status, message] of cases) {
    const res = await call('/runs', init);
    assert.equal(res.status, status, JSON.stringify(init.body).slice(0, 60));
    assert.match((await res.json()).error, message);
  }
});

test('POST /runs answers 409 while the repository already has an active run', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('/runs', post({ repo: 'api', prompt: 'one' }))).status, 202);
  const second = await call('/runs', post({ repo: 'api', prompt: 'two' }));
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /already active/);
});

test('GET /runs lists the runs, GET /runs/:id returns one, an unknown id is a 404', async (t) => {
  const { call } = await boot(t);
  await call('/runs', post({ repo: 'api', prompt: 'one' }));
  await call('/runs', post({ repo: 'web', prompt: 'two' }));
  assert.deepEqual((await (await call('/runs')).json()).runs.map((r) => r.id), ['run-2', 'run-1']);
  assert.equal((await (await call('/runs/run-1')).json()).run.repo, 'api');
  assert.equal((await call('/runs/run-99')).status, 404);
});

test('DELETE /runs/:id asks the CLI to stop and answers 202', async (t) => {
  const { call, calls } = await boot(t);
  await call('/runs', post({ repo: 'api', prompt: 'one' }));
  const res = await call('/runs/run-1', { method: 'DELETE' });
  assert.equal(res.status, 202);
  assert.equal(calls[0].child.killed, 'SIGTERM');
  assert.equal((await call('/runs/run-99', { method: 'DELETE' })).status, 404);
});

test('GET /runs/:id/events streams the output as SSE and ends with the final status', async (t) => {
  const { call, calls } = await boot(t);
  await call('/runs', post({ repo: 'api', prompt: 'go' }));
  const res = await call('/runs/run-1/events');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const { child } = calls[0];
  child.stdout.emit('data', Buffer.from('hello'));
  child.stderr.emit('data', Buffer.from('warn'));
  child.emit('close', 0);

  const text = await res.text();
  assert.match(text, /event: status\ndata: \{"status":"running"/);
  assert.match(text, /id: 2\nevent: stdout\ndata: \{"text":"hello","at":"/);
  assert.match(text, /event: stderr\ndata: \{"text":"warn"/);
  assert.match(text, /event: status\ndata: \{"status":"succeeded","exitCode":0/);
});

test('a client that connects after the run ended gets the whole history, then the stream closes', async (t) => {
  const { call, calls } = await boot(t);
  await call('/runs', post({ repo: 'api', prompt: 'go' }));
  calls[0].child.stdout.emit('data', 'all done');
  calls[0].child.emit('close', 0);
  const text = await (await call('/runs/run-1/events')).text();
  assert.match(text, /"text":"all done"/);
  assert.match(text, /"status":"succeeded"/);
});

test('events of an unknown run are a 404, and a dropped client does not break the run', async (t) => {
  const { call, calls } = await boot(t);
  assert.equal((await call('/runs/run-99/events')).status, 404);

  await call('/runs', post({ repo: 'api', prompt: 'go' }));
  const controller = new AbortController();
  await call('/runs/run-1/events', { signal: controller.signal });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.doesNotThrow(() => calls[0].child.stdout.emit('data', 'nobody is listening'));
  assert.equal((await call('/runs/run-1')).status, 200);
});

test('unknown routes and methods are a 404', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/runs', { method: 'PUT' })).status, 404);
  assert.equal((await call('/runs/run-1', { method: 'POST' })).status, 404);
});

test('an unexpected failure is a 500 carrying its message', async (t) => {
  const manager = { start() { throw new Error('boom'); }, get: () => null, list: () => [], cancel: () => null, subscribe: () => null };
  const { call } = await boot(t, { manager });
  const res = await call('/runs', post({ repo: 'api', prompt: 'x' }));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'boom' });
});

test('an AgentError with a code the server does not know is a 500, not a crash', async (t) => {
  const manager = { start() { throw new AgentError('mystery', 'odd failure'); }, get: () => null, list: () => [], cancel: () => null, subscribe: () => null };
  const { call } = await boot(t, { manager });
  const res = await call('/runs', post({ repo: 'api', prompt: 'x' }));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'odd failure' });
});
