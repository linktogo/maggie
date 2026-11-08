import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AgentError, createRepoResolver, createRunManager, createThreadService, createThreadStore,
} from '@linktogo/maggie-agent-runner';
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
  const store = createThreadStore({ path: ':memory:' });
  const threads = options.threads ?? createThreadService({ store, manager, repos, skillsDir, defaultProvider: 'claude-cli' });
  const server = createAgentsServer({
    token: 'secret-token',
    threads,
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
  return { call, calls, dir, port, manager, store, threads, repos };
}

test('isLoopbackHost only accepts loopback names', () => {
  for (const ok of ['localhost:4318', '127.0.0.1:4318', '[::1]:4318', 'localhost', 'LOCALHOST:4318']) assert.equal(isLoopbackHost(ok), true, ok);
  for (const bad of ['evil.example', 'evil.example:4318', '127.0.0.1.evil.example', undefined, '', 'a b', 'x@localhost', 'localhost/evil', 'localhost:']) assert.equal(isLoopbackHost(bad), false, String(bad));
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

const ID = /^th_[0-9a-f]{16}$/;
const patch = (body) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const initEvent = (sessionId) => `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId })}\n`;
const assistantText = (text) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;

// Starts a claude thread and lets its first run end, so the thread is idle and resumable.
async function idleThread(call, calls, body = { repo: 'api', prompt: 'first' }) {
  const { thread } = await (await call('/threads', post(body))).json();
  const { child } = calls[calls.length - 1];
  child.stdout.emit('data', Buffer.from(initEvent('sess-1') + assistantText('done')));
  child.emit('close', 0);
  return thread;
}

test('POST /threads starts the default provider in the checkout and answers 202 with the thread', async (t) => {
  const { call, calls, dir } = await boot(t);
  const res = await call('/threads', post({ repo: 'api', prompt: 'fix the bug' }));
  assert.equal(res.status, 202);
  const { thread } = await res.json();
  assert.match(thread.id, ID);
  assert.equal(thread.status, 'running');
  assert.equal(thread.provider, 'claude-cli');
  assert.equal(calls[0].command, 'claude');
  assert.equal(calls[0].opts.cwd, path.join(dir, 'api'));
  assert.equal(calls[0].child.input, 'fix the bug');
});

test('POST /threads honours a per-request provider, model and skill', async (t) => {
  const { call, calls } = await boot(t);
  const res = await call('/threads', post({ repo: 'web', provider: 'copilot', model: 'gpt-5', skill: 'nx/monorepo', prompt: 'only libs' }));
  assert.equal(res.status, 202);
  assert.equal(calls[0].command, 'copilot');
  assert.deepEqual(calls[0].args, ['--allow-all-tools', '--model', 'gpt-5']);
  assert.match(calls[0].child.input, /Use affected\./);
  assert.match(calls[0].child.input, /Task:\nonly libs/);
});

test('POST /threads refuses what it cannot run', async (t) => {
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
    const res = await call('/threads', init);
    assert.equal(res.status, status, JSON.stringify(init.body).slice(0, 60));
    assert.match((await res.json()).error, message);
  }
});

test('POST /threads answers 409 while the repository already has an active run', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('/threads', post({ repo: 'api', prompt: 'one' }))).status, 202);
  const second = await call('/threads', post({ repo: 'api', prompt: 'two' }));
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /already active/);
});

test('GET /threads filters by repo, status and q', async (t) => {
  const { call, calls } = await boot(t);
  const first = await idleThread(call, calls, { repo: 'api', prompt: 'fix the login' });
  const second = (await (await call('/threads', post({ repo: 'web', prompt: 'add a footer' }))).json()).thread;
  const ids = async (query) => (await (await call(`/threads${query}`)).json()).threads.map((x) => x.id);
  assert.deepEqual(await ids(''), [second.id, first.id]);
  assert.deepEqual(await ids('?repo=api'), [first.id]);
  assert.deepEqual(await ids('?status=running'), [second.id]);
  assert.deepEqual(await ids('?q=footer'), [second.id]);
  assert.deepEqual(await ids('?status=archived'), []);
  assert.deepEqual(await ids(`?before=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`), []);
});

test('GET /threads/:id returns the thread and its messages, an unknown id is a 404', async (t) => {
  const { call, calls } = await boot(t);
  const thread = await idleThread(call, calls);
  const body = await (await call(`/threads/${thread.id}`)).json();
  assert.equal(body.thread.status, 'idle');
  assert.equal(body.thread.sessionId, 'sess-1');
  assert.equal(body.messages[0].role, 'user');
  assert.ok(body.messages.some((m) => m.role === 'agent'));
  assert.equal((await call('/threads/th_0000000000000000')).status, 404);
  assert.equal((await call('/threads/not-an-id')).status, 404);
});

test('POST /threads/:id/messages resumes the thread', async (t) => {
  const { call, calls } = await boot(t);
  const thread = await idleThread(call, calls);
  const res = await call(`/threads/${thread.id}/messages`, post({ prompt: 'and again' }));
  assert.equal(res.status, 202);
  assert.equal((await res.json()).thread.status, 'running');
  assert.ok(calls[1].args.includes('--resume'));
  assert.ok(calls[1].args.includes('sess-1'));
  assert.equal(calls[1].child.input, 'and again');
});

test('POST /threads/:id/messages refuses a Copilot thread, a running thread and a body over the limit', async (t) => {
  const { call, calls } = await boot(t, { server: { bodyLimit: 200 } });
  const copilot = await idleThread(call, calls, { repo: 'web', provider: 'copilot', prompt: 'hi' });
  const refused = await call(`/threads/${copilot.id}/messages`, post({ prompt: 'more' }));
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /cannot be resumed/);

  const claude = await idleThread(call, calls);
  assert.equal((await call(`/threads/${claude.id}/messages`, post({ prompt: 'go' }))).status, 202);
  const busy = await call(`/threads/${claude.id}/messages`, post({ prompt: 'again' }));
  assert.equal(busy.status, 409);

  const big = await call(`/threads/${claude.id}/messages`, post({ prompt: 'x'.repeat(500) }));
  assert.equal(big.status, 413);
  assert.equal((await call('/threads/th_0000000000000000/messages', post({ prompt: 'x' }))).status, 404);
});

test('a thread whose repo left the allowlist can be read but not resumed', async (t) => {
  const { call, calls, repos } = await boot(t);
  const thread = await idleThread(call, calls);
  repos.resolve = (name) => { throw new AgentError('not-found', `unknown repository: ${name}`); };
  assert.equal((await call(`/threads/${thread.id}`)).status, 200);
  assert.equal((await call(`/threads/${thread.id}/messages`, post({ prompt: 'again' }))).status, 404);
});

test('GET /threads/:id/events replays nothing, streams new messages, then ends on idle', async (t) => {
  const { call, calls } = await boot(t);
  const { thread } = await (await call('/threads', post({ repo: 'api', prompt: 'go' }))).json();
  const res = await call(`/threads/${thread.id}/events`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const { child } = calls[0];
  child.stdout.emit('data', Buffer.from(initEvent('sess-1') + assistantText('hello')));
  child.emit('close', 0);

  const text = await res.text();
  assert.doesNotMatch(text, /"role":"user"/);
  assert.match(text, /event: message\ndata: \{[^\n]*"role":"agent"[^\n]*"hello"/);
  assert.match(text, /event: message\ndata: \{[^\n]*"kind":"status"/);
  assert.ok(text.endsWith('event: status\ndata: {"status":"idle"}\n\n'));
});

test("an idle thread's stream sends its status and ends", async (t) => {
  const { call, calls } = await boot(t);
  const thread = await idleThread(call, calls);
  const text = await (await call(`/threads/${thread.id}/events`)).text();
  assert.equal(text, 'event: status\ndata: {"status":"idle"}\n\n');
});

test('GET /threads/:id/events?after=<id> replays the stored messages past that id, then goes live', async (t) => {
  const { call, calls } = await boot(t);
  const { thread } = await (await call('/threads', post({ repo: 'api', prompt: 'go' }))).json();
  const { child } = calls[0];
  child.stdout.emit('data', Buffer.from(initEvent('sess-1') + assistantText('early')));
  const { messages } = await (await call(`/threads/${thread.id}`)).json();
  const res = await call(`/threads/${thread.id}/events?after=${messages[0].id}`);
  assert.equal(res.status, 200);
  child.stdout.emit('data', Buffer.from(assistantText('late')));
  child.emit('close', 0);

  const text = await res.text();
  // The user message (id 1) is not replayed, the one stored before the connection is, then the live ones.
  assert.doesNotMatch(text, /"role":"user"/);
  const order = [...text.matchAll(/"text","content":"(early|late)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['early', 'late']);
  assert.equal(text.match(/"content":"early"/g).length, 1);
  assert.ok(text.endsWith('event: status\ndata: {"status":"idle"}\n\n'));
});

test("an idle thread's stream with after=0 replays its whole backlog, then its status, and ends", async (t) => {
  const { call, calls } = await boot(t);
  const thread = await idleThread(call, calls);
  const text = await (await call(`/threads/${thread.id}/events?after=0`)).text();
  const events = [...text.matchAll(/event: (\w+)\n/g)].map((m) => m[1]);
  assert.equal(events.at(-1), 'status');
  assert.ok(events.filter((e) => e === 'message').length >= 3);
  assert.match(text, /^event: message\ndata: \{[^\n]*"role":"user"/);
  assert.ok(text.endsWith('event: status\ndata: {"status":"idle"}\n\n'));
});

test('an after that is not a non-negative integer is a 400', async (t) => {
  const { call, calls } = await boot(t);
  const thread = await idleThread(call, calls);
  for (const after of ['-1', 'abc', '1.5', '']) {
    const res = await call(`/threads/${thread.id}/events?after=${after}`);
    assert.equal(res.status, 400, after);
    assert.match((await res.json()).error, /after/);
  }
});

test('POST /threads/:id/messages with a JSON null body is a 400', async (t) => {
  const { call, calls } = await boot(t);
  const thread = await idleThread(call, calls);
  const res = await call(`/threads/${thread.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /prompt is required/);
});

test('events of an unknown thread are a 404, and a dropped client does not break the run', async (t) => {
  const { call, calls } = await boot(t);
  assert.equal((await call('/threads/th_0000000000000000/events')).status, 404);

  const { thread } = await (await call('/threads', post({ repo: 'api', prompt: 'go' }))).json();
  const controller = new AbortController();
  await call(`/threads/${thread.id}/events`, { signal: controller.signal });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.doesNotThrow(() => calls[0].child.stdout.emit('data', Buffer.from(assistantText('nobody is listening'))));
  assert.equal((await call(`/threads/${thread.id}`)).status, 200);
});

test('DELETE /threads/:id/run stops the run, and is a 404 with no active run', async (t) => {
  const { call, calls } = await boot(t);
  const { thread } = await (await call('/threads', post({ repo: 'api', prompt: 'go' }))).json();
  const res = await call(`/threads/${thread.id}/run`, { method: 'DELETE' });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).thread.id, thread.id);
  assert.equal(calls[0].child.killed, 'SIGTERM');
  calls[0].child.emit('close', null);
  assert.equal((await call(`/threads/${thread.id}/run`, { method: 'DELETE' })).status, 404);
  assert.equal((await call('/threads/th_0000000000000000/run', { method: 'DELETE' })).status, 404);
});

test('PATCH archives and restores a thread, refuses other bodies and a running thread', async (t) => {
  const { call, calls } = await boot(t);
  const thread = await idleThread(call, calls);
  const url = `/threads/${thread.id}`;
  assert.equal((await (await call(url, patch({ status: 'archived' }))).json()).thread.status, 'archived');
  assert.deepEqual((await (await call('/threads')).json()).threads, []);
  const restored = await call(url, patch({ status: 'idle' }));
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).thread.status, 'idle');

  for (const body of [{ status: 'running' }, { status: 'idle', title: 'x' }, {}, null, 'idle']) {
    assert.equal((await call(url, patch(body))).status, 400, JSON.stringify(body));
  }

  const { thread: running } = await (await call('/threads', post({ repo: 'web', prompt: 'go' }))).json();
  assert.equal((await call(`/threads/${running.id}`, patch({ status: 'archived' }))).status, 409);
});

test('DELETE /threads/:id removes the thread, and is a 409 while it runs', async (t) => {
  const { call, calls } = await boot(t);
  const thread = await idleThread(call, calls);
  const gone = await call(`/threads/${thread.id}`, { method: 'DELETE' });
  assert.equal(gone.status, 204);
  assert.equal(await gone.text(), '');
  assert.equal((await call(`/threads/${thread.id}`)).status, 404);

  const { thread: running } = await (await call('/threads', post({ repo: 'web', prompt: 'go' }))).json();
  assert.equal((await call(`/threads/${running.id}`, { method: 'DELETE' })).status, 409);
});

test('GET /projects lists allowlisted repos with counts', async (t) => {
  const { call, calls } = await boot(t);
  await idleThread(call, calls);
  await call('/threads', post({ repo: 'web', prompt: 'go' }));
  const { projects } = await (await call('/projects')).json();
  assert.deepEqual(projects.map(({ repo, threads, running }) => ({ repo, threads, running })), [
    { repo: 'api', threads: 1, running: 0 },
    { repo: 'web', threads: 1, running: 1 },
  ]);
});

test('the legacy /runs routes are gone', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('/runs')).status, 404);
  assert.equal((await call('/runs', post({ repo: 'api', prompt: 'x' }))).status, 404);
  assert.equal((await call('/runs/run-1')).status, 404);
});

test('unknown routes and methods are a 404', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/threads', { method: 'PUT' })).status, 404);
  assert.equal((await call('/threads/th_0000000000000000', { method: 'POST' })).status, 404);
  assert.equal((await call('/threads/th_0000000000000000/run', { method: 'GET' })).status, 404);
  assert.equal((await call('/projects', { method: 'POST' })).status, 404);
});

const failing = (error) => ({ start() { throw error; } });

test('an unexpected failure is a 500 carrying its message', async (t) => {
  const { call } = await boot(t, { threads: failing(new Error('boom')) });
  const res = await call('/threads', post({ repo: 'api', prompt: 'x' }));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'boom' });
});

test('an AgentError with a code the server does not know is a 500, not a crash', async (t) => {
  const { call } = await boot(t, { threads: failing(new AgentError('mystery', 'odd failure')) });
  const res = await call('/threads', post({ repo: 'api', prompt: 'x' }));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'odd failure' });
});

test('the server logs each request and narrates each thread on its console', async (t) => {
  const lines = [];
  const { call, calls } = await boot(t, { server: { log: (line) => lines.push(line) } });
  const first = (await (await call('/threads', post({ repo: 'web', provider: 'copilot', model: 'gpt-5', skill: 'nx/monorepo', prompt: 'go' }))).json()).thread;
  const second = (await (await call('/threads', post({ repo: 'api', prompt: 'go' }))).json()).thread;
  calls[0].child.emit('close', 2);
  calls[1].child.stdout.emit('data', Buffer.from(initEvent('sess-1')));
  calls[1].child.emit('close', 0);
  assert.equal((await call('/nope')).status, 404);

  assert.ok(lines.includes(`[${first.id}] started on web with copilot (gpt-5), skill nx/monorepo`));
  assert.ok(lines.includes(`[${second.id}] started on api with claude-cli`));
  assert.ok(lines.includes(`[${first.id}] failed`));
  assert.ok(lines.includes(`[${second.id}] idle`));
  assert.ok(lines.some((line) => /^POST \/threads 202 \d+ms$/.test(line)));
  assert.ok(lines.some((line) => /^GET \/nope 404 \d+ms$/.test(line)));
});

test('a resumed thread is narrated once per status, not once per run so far', async (t) => {
  const lines = [];
  const { call, calls } = await boot(t, { server: { log: (line) => lines.push(line) } });
  const thread = await idleThread(call, calls);
  await call(`/threads/${thread.id}/messages`, post({ prompt: 'more' }));
  calls[1].child.emit('close', 0);
  assert.equal(lines.filter((line) => line === `[${thread.id}] idle`).length, 2);
});

test('an unexpected failure is logged with its stack', async (t) => {
  const lines = [];
  const { call } = await boot(t, { threads: failing(new Error('boom')), server: { log: (line) => lines.push(line) } });
  await call('/threads', post({ repo: 'api', prompt: 'x' }));
  assert.ok(lines.some((line) => line.startsWith('error on POST /threads: Error: boom\n')));
});

test('a run that cannot spawn leaves a failed thread, answers 202 and is logged', async (t) => {
  const lines = [];
  const manager = createRunManager({ spawn() { throw new Error('EINVAL'); } });
  const { call } = await boot(t, { manager, server: { log: (line) => lines.push(line) } });
  const res = await call('/threads', post({ repo: 'api', prompt: 'go' }));
  assert.equal(res.status, 202);
  const { thread } = await res.json();
  assert.equal(thread.status, 'failed');
  assert.ok(lines.includes(`[${thread.id}] failed`));
});

test('a resumed run that cannot spawn answers 202 with the thread settled and is logged', async (t) => {
  const lines = [];
  let broken = false;
  const calls = [];
  const manager = createRunManager({
    spawn(command, args, opts) {
      if (broken) throw new Error('EINVAL');
      const child = fakeChild();
      calls.push({ command, args, opts, child });
      return child;
    },
  });
  const { call } = await boot(t, { manager, server: { log: (line) => lines.push(line) } });
  const thread = await idleThread(call, calls);
  broken = true;
  const res = await call(`/threads/${thread.id}/messages`, post({ prompt: 'more' }));
  assert.equal(res.status, 202);
  assert.equal((await res.json()).thread.status, 'idle');
  assert.equal(lines.filter((line) => line === `[${thread.id}] idle`).length, 2);
});
