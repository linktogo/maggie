import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { useThreads } from './useThreads.js';

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await nextTick();
    await Promise.resolve();
  }
}

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }

  close() { this.closed = true; }

  emit(type, data) { for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) }); }
}

function api(routes) {
  return vi.fn(async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url.split('?')[0]}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    const { status = 200, body = {} } = await handler(init);
    return { ok: status < 400, status, json: async () => body };
  });
}

const HEALTH = { providers: { available: ['claude-cli'], default: 'claude-cli' }, repos: ['api'] };
const running = { id: 't1', repo: 'api', provider: 'claude-cli', sessionId: 's1', status: 'running' };
const idle = { ...running, status: 'idle' };
const msg = (id, content = id) => ({ id, threadId: 't1', role: 'assistant', kind: 'text', content });

let routes;
let current;
const base = () => ({
  'GET /api/factory/health': () => ({ body: HEALTH }),
  'GET /api/factory/skills': () => ({ body: { skills: [{ id: 'nx/monorepo' }] } }),
  'GET /api/factory/projects': () => ({ body: { projects: [{ repo: 'api', threads: 1, running: 1, lastActivity: 'x' }] } }),
  'GET /api/factory/threads': () => ({ body: { threads: [idle] } }),
});

function setup(extra = {}, options = {}) {
  FakeEventSource.instances = [];
  routes = { ...base(), ...extra };
  const fetchImpl = api(routes);
  let composable;
  const wrapper = mount(defineComponent({
    setup() {
      composable = useThreads({ fetchImpl, EventSourceImpl: FakeEventSource, ...options });
      return () => null;
    },
  }));
  current = { fetchImpl, wrapper, ...composable };
  return current;
}

const calls = (f, key) => f.fetchImpl.mock.calls.filter(([url, init = {}]) => `${init.method ?? 'GET'} ${url.split('?')[0]}` === key);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { current?.wrapper.unmount(); vi.useRealTimers(); });

test('load fills health, skills and projects', async () => {
  const f = setup();
  await f.load();
  expect(f.available.value).toBe(true);
  expect(f.health.value).toEqual(HEALTH);
  expect(f.skills.value).toEqual([{ id: 'nx/monorepo' }]);
  expect(f.projects.value).toHaveLength(1);
});

test('marks the factory unavailable on 503', async () => {
  const f = setup({ 'GET /api/factory/health': () => ({ status: 503, body: { error: 'agents-unavailable', detail: 'unreachable' } }) });
  await f.load();
  expect(f.available.value).toBe(false);
  expect(f.error.value).toBe('unreachable');
});

test('marks the factory unavailable when the board cannot be reached', async () => {
  FakeEventSource.instances = [];
  let composable;
  const wrapper = mount(defineComponent({
    setup() {
      composable = useThreads({ fetchImpl: vi.fn().mockRejectedValue(new Error('network down')), EventSourceImpl: FakeEventSource });
      return () => null;
    },
  }));
  await composable.load();
  expect(composable.available.value).toBe(false);
  wrapper.unmount();
});

test('loadThreads sends the filters and queries archived threads on demand', async () => {
  const f = setup();
  await f.loadThreads({ repo: 'api', q: 'fix' });
  expect(f.threads.value).toEqual([idle]);
  expect(calls(f, 'GET /api/factory/threads')[0][0]).toBe('/api/factory/threads?repo=api&q=fix');
  await f.loadThreads({ repo: 'api', archived: true });
  expect(calls(f, 'GET /api/factory/threads')[1][0]).toBe('/api/factory/threads?repo=api&status=archived');
});

test('open loads a thread and follows its events while running', async () => {
  const f = setup({ 'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [msg('m1')] } }) });
  await f.open('t1');
  expect(f.thread.value).toEqual(running);
  expect(f.messages.value).toHaveLength(1);
  // The stream replays what was stored after the last message held, then goes live.
  expect(FakeEventSource.instances[0].url).toBe('/api/factory/threads/t1/events?after=m1');
  FakeEventSource.instances[0].emit('message', msg('m2'));
  expect(f.messages.value.map((m) => m.id)).toEqual(['m1', 'm2']);
});

test('open does not follow an idle thread', async () => {
  const f = setup({ 'GET /api/factory/threads/t1': () => ({ body: { thread: idle, messages: [] } }) });
  await f.open('t1');
  expect(FakeEventSource.instances).toHaveLength(0);
});

test('a streamed message already loaded is not duplicated', async () => {
  const f = setup({ 'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [msg('m1')] } }) });
  await f.open('t1');
  FakeEventSource.instances[0].emit('message', msg('m1'));
  expect(f.messages.value).toHaveLength(1);
});

test('the stream closes on idle and the lists refresh', async () => {
  let state = running;
  const f = setup({ 'GET /api/factory/threads/t1': () => ({ body: { thread: state, messages: [] } }) });
  await f.open('t1');
  state = idle;
  FakeEventSource.instances[0].emit('status', { status: 'running' });
  expect(FakeEventSource.instances[0].closed).toBe(false);
  FakeEventSource.instances[0].emit('status', { status: 'idle' });
  await settle();
  expect(FakeEventSource.instances[0].closed).toBe(true);
  expect(f.thread.value.status).toBe('idle');
  expect(calls(f, 'GET /api/factory/projects')).toHaveLength(1);
  expect(calls(f, 'GET /api/factory/threads')).toHaveLength(1);
});

test('a dropped stream reloads the thread instead of replaying it', async () => {
  const f = setup({ 'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [msg('m1')] } }) });
  await f.open('t1');
  const first = FakeEventSource.instances[0];
  first.onerror();
  await vi.advanceTimersByTimeAsync(1000);
  expect(first.closed).toBe(true);
  expect(calls(f, 'GET /api/factory/threads/t1')).toHaveLength(2);
  expect(FakeEventSource.instances).toHaveLength(2);
  expect(f.messages.value).toHaveLength(1);
});

test('reply posts the prompt and follows the new run', async () => {
  const posted = [];
  const f = setup({
    'GET /api/factory/threads/t1': () => ({ body: { thread: idle, messages: [] } }),
    'POST /api/factory/threads/t1/messages': (init) => { posted.push(JSON.parse(init.body)); return { status: 202, body: { thread: running } }; },
  });
  await f.open('t1');
  expect(await f.reply('go on')).toBe(true);
  expect(posted).toEqual([{ prompt: 'go on' }]);
  expect(f.thread.value.status).toBe('running');
  expect(FakeEventSource.instances).toHaveLength(1);
  expect(f.busy.value).toBe(false);
});

const stored = (id, role, kind, content) => ({ id, threadId: 't1', role, kind, content });

test('a thread with no message yet follows from after=0', async () => {
  const f = setup({ 'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [] } }) });
  await f.open('t1');
  expect(FakeEventSource.instances[0].url).toBe('/api/factory/threads/t1/events?after=0');
});

test('your own reply, stored before the stream connected, is shown from the replay', async () => {
  const first = stored(1, 'user', 'text', 'fix it');
  const mine = stored(2, 'user', 'text', 'go on');
  const f = setup({
    'GET /api/factory/threads/t1': () => ({ body: { thread: idle, messages: [first] } }),
    'POST /api/factory/threads/t1/messages': () => ({ status: 202, body: { thread: running } }),
  });
  await f.open('t1');
  await f.reply('go on');
  const stream = FakeEventSource.instances[0];
  expect(stream.url).toBe('/api/factory/threads/t1/events?after=1');
  stream.emit('message', mine);
  stream.emit('message', mine);
  expect(f.messages.value.map((m) => m.content)).toEqual(['fix it', 'go on']);
});

test('a reply that fails at once shows its error and outcome, and the final state comes from the server', async () => {
  const first = stored(1, 'user', 'text', 'fix it');
  const after = [
    first,
    stored(2, 'user', 'text', 'go on'),
    stored(3, 'system', 'error', 'spawn claude ENOENT'),
    stored(4, 'system', 'status', { outcome: 'failed', error: 'Could not run claude' }),
  ];
  let messages = [first];
  const f = setup({
    'GET /api/factory/threads/t1': () => ({ body: { thread: idle, messages } }),
    // The run failed before the 202 went out: the thread is already settled.
    'POST /api/factory/threads/t1/messages': () => { messages = after; return { status: 202, body: { thread: idle } }; },
  });
  await f.open('t1');
  await f.reply('go on');
  const stream = FakeEventSource.instances[0];
  for (const m of after.slice(1)) stream.emit('message', m);
  expect(f.messages.value.map((m) => m.kind)).toEqual(['text', 'text', 'error', 'status']);
  stream.emit('status', { status: 'idle' });
  await settle();
  expect(stream.closed).toBe(true);
  expect(f.messages.value).toEqual(after);
  expect(f.messages.value.at(-1).content.outcome).toBe('failed');
});

test('the refresh after a run reloads the messages, even those the stream missed', async () => {
  let messages = [stored(1, 'user', 'text', 'fix it')];
  const f = setup({ 'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages } }) });
  await f.open('t1');
  messages = [...messages, stored(2, 'agent', 'text', 'done'), stored(3, 'system', 'status', { outcome: 'succeeded' })];
  FakeEventSource.instances[0].emit('status', { status: 'idle' });
  await settle();
  expect(f.messages.value.map((m) => m.id)).toEqual([1, 2, 3]);
});

test('a 409 sets error and keeps the thread idle', async () => {
  const f = setup({
    'GET /api/factory/threads/t1': () => ({ body: { thread: idle, messages: [] } }),
    'POST /api/factory/threads/t1/messages': () => ({ status: 409, body: { error: 'thread is busy' } }),
  });
  await f.open('t1');
  expect(await f.reply('x')).toBe(false);
  expect(f.error.value).toBe('thread is busy');
  expect(f.thread.value.status).toBe('idle');
  expect(FakeEventSource.instances).toHaveLength(0);
});

test('an error without a body falls back to the HTTP status', async () => {
  const f = setup({
    'GET /api/factory/threads/t1': () => ({ body: { thread: idle, messages: [] } }),
    'POST /api/factory/threads/t1/messages': () => ({ status: 500 }),
  });
  await f.open('t1');
  await f.reply('x');
  expect(f.error.value).toBe('HTTP 500');
});

test('create posts the filled fields, opens the thread and returns it', async () => {
  const posted = [];
  const f = setup({
    'POST /api/factory/threads': (init) => { posted.push(JSON.parse(init.body)); return { status: 202, body: { thread: running } }; },
    'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [msg('m0')] } }),
  });
  const created = await f.create({ repo: 'api', provider: 'claude-cli', model: '', prompt: 'hi', skill: undefined });
  expect(posted).toEqual([{ repo: 'api', provider: 'claude-cli', prompt: 'hi' }]);
  expect(created).toEqual(running);
  expect(f.thread.value).toEqual(running);
  expect(FakeEventSource.instances).toHaveLength(1);
});

test('create returns null and sets error on failure', async () => {
  const f = setup({ 'POST /api/factory/threads': () => ({ status: 400, body: { error: 'unknown repo' } }) });
  expect(await f.create({ repo: 'zz' })).toBeNull();
  expect(f.error.value).toBe('unknown repo');
});

test('stop cancels the run and keeps following it', async () => {
  const f = setup({
    'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [] } }),
    'DELETE /api/factory/threads/t1/run': () => ({ status: 202, body: { thread: running } }),
  });
  await f.open('t1');
  await f.stop();
  expect(calls(f, 'DELETE /api/factory/threads/t1/run')).toHaveLength(1);
  expect(FakeEventSource.instances[0].closed).toBe(false);
});

test('archive and restore patch the status and refresh the lists', async () => {
  const bodies = [];
  const f = setup({
    'GET /api/factory/threads/t1': () => ({ body: { thread: idle, messages: [] } }),
    'PATCH /api/factory/threads/t1': (init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return { body: { thread: { ...idle, status: body.status } } };
    },
  });
  await f.open('t1');
  await f.archive('t1');
  expect(f.thread.value.status).toBe('archived');
  await f.restore('t1');
  expect(f.thread.value.status).toBe('idle');
  expect(bodies).toEqual([{ status: 'archived' }, { status: 'idle' }]);
  expect(calls(f, 'GET /api/factory/projects')).toHaveLength(2);
});

test('remove on the open thread clears it and closes the stream', async () => {
  const f = setup({
    'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [msg('m1')] } }),
    'DELETE /api/factory/threads/t1': () => ({ status: 204 }),
  });
  await f.open('t1');
  await f.remove('t1');
  expect(f.thread.value).toBeNull();
  expect(f.messages.value).toEqual([]);
  expect(FakeEventSource.instances[0].closed).toBe(true);
  expect(f.error.value).toBeNull();
});

test('resumable is false for copilot, without a session, or while running', async () => {
  let state = idle;
  const f = setup({ 'GET /api/factory/threads/t1': () => ({ body: { thread: state, messages: [] } }) });
  expect(f.resumable.value).toBe(false);
  await f.open('t1');
  expect(f.resumable.value).toBe(true);
  state = { ...idle, provider: 'copilot' };
  await f.open('t1');
  expect(f.resumable.value).toBe(false);
  state = { ...idle, sessionId: null };
  await f.open('t1');
  expect(f.resumable.value).toBe(false);
  state = running;
  await f.open('t1');
  expect(f.resumable.value).toBe(false);
});

test('polls projects only while the page is visible, and stops on unmount', async () => {
  const doc = { visibilityState: 'visible' };
  const f = setup({}, { pollMs: 1000, doc });
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls(f, 'GET /api/factory/projects')).toHaveLength(1);
  doc.visibilityState = 'hidden';
  await vi.advanceTimersByTimeAsync(2000);
  expect(calls(f, 'GET /api/factory/projects')).toHaveLength(1);
  doc.visibilityState = 'visible';
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls(f, 'GET /api/factory/projects')).toHaveLength(2);
  f.wrapper.unmount();
  await vi.advanceTimersByTimeAsync(5000);
  expect(calls(f, 'GET /api/factory/projects')).toHaveLength(2);
});

test('unmounting closes the stream', async () => {
  const f = setup({ 'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [] } }) });
  await f.open('t1');
  f.wrapper.unmount();
  expect(FakeEventSource.instances[0].closed).toBe(true);
});

const errorAndReload = async (f, index) => {
  FakeEventSource.instances[index].onerror();
  await vi.advanceTimersByTimeAsync(1000);
  void f;
};

test('a stream that keeps failing reloads 3 times, 1s apart, then gives up', async () => {
  const f = setup({ 'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [] } }) });
  await f.open('t1');
  FakeEventSource.instances[0].onerror();
  await vi.advanceTimersByTimeAsync(999);
  expect(calls(f, 'GET /api/factory/threads/t1')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls(f, 'GET /api/factory/threads/t1')).toHaveLength(2);
  await errorAndReload(f, 1);
  await errorAndReload(f, 2);
  expect(calls(f, 'GET /api/factory/threads/t1')).toHaveLength(4);
  FakeEventSource.instances[3].onerror();
  await vi.advanceTimersByTimeAsync(5000);
  expect(calls(f, 'GET /api/factory/threads/t1')).toHaveLength(4);
  expect(f.error.value).toBe('lost the connection to the agents server');
});

test('a received event resets the reload counter', async () => {
  const f = setup({ 'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [] } }) });
  await f.open('t1');
  await errorAndReload(f, 0);
  await errorAndReload(f, 1);
  FakeEventSource.instances[2].emit('message', msg('m1'));
  await errorAndReload(f, 2);
  await errorAndReload(f, 3);
  await errorAndReload(f, 4);
  expect(f.error.value).toBeNull();
  expect(calls(f, 'GET /api/factory/threads/t1')).toHaveLength(6);
});

test('switching threads cancels a pending reload', async () => {
  const f = setup({
    'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [] } }),
    'GET /api/factory/threads/t2': () => ({ body: { thread: { ...idle, id: 't2' }, messages: [] } }),
  });
  await f.open('t1');
  FakeEventSource.instances[0].onerror();
  await f.open('t2');
  await vi.advanceTimersByTimeAsync(3000);
  expect(calls(f, 'GET /api/factory/threads/t1')).toHaveLength(1);
  expect(f.thread.value.id).toBe('t2');
});

test('unmounting cancels a pending reload', async () => {
  const f = setup({ 'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [] } }) });
  await f.open('t1');
  FakeEventSource.instances[0].onerror();
  f.wrapper.unmount();
  await vi.advanceTimersByTimeAsync(3000);
  expect(calls(f, 'GET /api/factory/threads/t1')).toHaveLength(1);
});

test('a reply resolving after another thread was opened leaves that thread current', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const t2 = { ...idle, id: 't2' };
  const f = setup({
    'GET /api/factory/threads/t1': () => ({ body: { thread: idle, messages: [msg('a1')] } }),
    'GET /api/factory/threads/t2': () => ({ body: { thread: t2, messages: [msg('b1')] } }),
    'POST /api/factory/threads/t1/messages': async () => { await gate; return { status: 202, body: { thread: running } }; },
  });
  await f.open('t1');
  const pending = f.reply('x');
  await f.open('t2');
  release();
  await pending;
  expect(f.thread.value.id).toBe('t2');
  expect(f.messages.value.map((m) => m.id)).toEqual(['b1']);
  expect(FakeEventSource.instances).toHaveLength(0);
});

test('an open resolving after a reply does not replace its stream', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let slow = false;
  const f = setup({
    'GET /api/factory/threads/t1': async () => {
      if (slow) await gate;
      return { body: { thread: idle, messages: [] } };
    },
    'POST /api/factory/threads/t1/messages': () => ({ status: 202, body: { thread: running } }),
  });
  await f.open('t1');
  slow = true;
  const staleOpen = f.open('t1');
  await f.reply('x');
  release();
  await staleOpen;
  expect(f.thread.value.status).toBe('running');
  expect(FakeEventSource.instances).toHaveLength(1);
  expect(FakeEventSource.instances[0].closed).toBe(false);
});

test('a pending open of a removed thread cannot resurrect it', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let slow = false;
  const f = setup({
    'GET /api/factory/threads/t1': async () => {
      if (slow) await gate;
      return { body: { thread: idle, messages: [] } };
    },
    'DELETE /api/factory/threads/t1': () => ({ status: 204 }),
  });
  await f.open('t1');
  slow = true;
  const staleOpen = f.open('t1');
  await f.remove('t1');
  release();
  await staleOpen;
  expect(f.thread.value).toBeNull();
});

test('a create resolving after another thread was opened leaves that thread current', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const t2 = { ...idle, id: 't2' };
  const f = setup({
    'POST /api/factory/threads': async () => { await gate; return { status: 202, body: { thread: running } }; },
    'GET /api/factory/threads/t1': () => ({ body: { thread: running, messages: [] } }),
    'GET /api/factory/threads/t2': () => ({ body: { thread: t2, messages: [] } }),
  });
  const pending = f.create({ repo: 'api' });
  await f.open('t2');
  release();
  expect((await pending).id).toBe('t1');
  expect(f.thread.value.id).toBe('t2');
});

test('create sends the worktree flag only when asked', async () => {
  const posted = [];
  const f = setup({
    'POST /api/factory/threads': (init) => { posted.push(JSON.parse(init.body)); return { status: 202, body: { thread: idle } }; },
    'GET /api/factory/threads/t1': () => ({ body: { thread: idle, messages: [] } }),
  });
  await f.create({ repo: 'api', worktree: true });
  await f.create({ repo: 'api', worktree: false });
  expect(posted).toEqual([{ repo: 'api', worktree: true }, { repo: 'api' }]);
});

test('a failure with a detail shows the error code and the detail', async () => {
  const f = setup({
    'POST /api/factory/threads': () => ({ status: 502, body: { error: 'git-failed', detail: 'git fetch failed: offline' } }),
  });
  expect(await f.create({ repo: 'api', worktree: true })).toBeNull();
  expect(f.error.value).toBe('git-failed: git fetch failed: offline');
});

test('removeWorktree deletes, reloads the open thread and the list, then reports branchKept', async () => {
  const withWt = { ...idle, worktree: { path: '/p', branch: 'b', base: 'origin/main' } };
  let removed = false;
  const f = setup({
    'GET /api/factory/threads/t1': () => ({ body: { thread: removed ? idle : withWt, messages: [] } }),
    'DELETE /api/factory/threads/t1/worktree': () => { removed = true; return { body: { thread: idle, branchKept: true } }; },
  });
  await f.open('t1');
  expect(f.thread.value.worktree).toBeTruthy();
  expect(await f.removeWorktree('t1')).toEqual({ ok: true, branchKept: true });
  expect(f.thread.value.worktree).toBeUndefined();
  expect(calls(f, 'DELETE /api/factory/threads/t1/worktree')[0][0]).toBe('/api/factory/threads/t1/worktree');
});

test('removeWorktree on a thread that is not open only refreshes the list', async () => {
  const f = setup({ 'DELETE /api/factory/threads/t9/worktree': () => ({ body: { thread: idle, branchKept: false } }) });
  expect(await f.removeWorktree('t9')).toEqual({ ok: true, branchKept: false });
  expect(calls(f, 'GET /api/factory/threads/t9')).toHaveLength(0);
});

test('a dirty worktree answers dirty without an error, and force retries with ?force=1', async () => {
  let dirty = true;
  const f = setup({
    'DELETE /api/factory/threads/t1/worktree': () => (dirty
      ? { status: 409, body: { error: 'worktree-dirty', detail: 'M a.js' } }
      : { body: { thread: idle, branchKept: false } }),
  });
  expect(await f.removeWorktree('t1')).toEqual({ ok: false, dirty: true });
  expect(f.error.value).toBeNull();
  dirty = false;
  expect(await f.removeWorktree('t1', { force: true })).toEqual({ ok: true, branchKept: false });
  expect(calls(f, 'DELETE /api/factory/threads/t1/worktree').map(([url]) => url)).toEqual([
    '/api/factory/threads/t1/worktree',
    '/api/factory/threads/t1/worktree?force=1',
  ]);
});

test('other worktree removal failures set the error and are not dirty', async () => {
  const f = setup({
    'DELETE /api/factory/threads/t1/worktree': () => ({ status: 409, body: { error: 'a run is active' } }),
    'DELETE /api/factory/threads/t2/worktree': () => ({ status: 502, body: { error: 'git-failed' } }),
  });
  expect(await f.removeWorktree('t1')).toEqual({ ok: false, dirty: false });
  expect(f.error.value).toBe('a run is active');
  expect(await f.removeWorktree('t2')).toEqual({ ok: false, dirty: false });
  expect(f.error.value).toBe('git-failed');
});

test('remove reports dirty on a dirty worktree and passes force', async () => {
  let dirty = true;
  const f = setup({
    'DELETE /api/factory/threads/t1': () => (dirty ? { status: 409, body: { error: 'worktree-dirty' } } : { status: 204 }),
  });
  expect(await f.remove('t1')).toEqual({ ok: false, dirty: true });
  dirty = false;
  expect(await f.remove('t1', { force: true })).toEqual({ ok: true, branchKept: undefined });
  expect(calls(f, 'DELETE /api/factory/threads/t1').at(-1)[0]).toBe('/api/factory/threads/t1?force=1');
});
