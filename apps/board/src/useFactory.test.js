import { test, expect, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { useFactory } from './useFactory.js';

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    const key = `${init.method ?? 'GET'} ${url}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    const { status = 200, body = {} } = handler(init);
    return { ok: status < 400, status, json: async () => body };
  });
}

const HEALTH = { providers: { available: ['claude-cli'], default: 'claude-cli' }, repos: ['api'] };
const base = {
  'GET /api/factory/health': () => ({ body: HEALTH }),
  'GET /api/factory/skills': () => ({ body: { skills: [{ id: 'nx/monorepo' }] } }),
  'GET /api/factory/runs': () => ({ body: { runs: [{ id: 'run-1', status: 'running' }] } }),
};

function factory(routes) {
  FakeEventSource.instances = [];
  const fetchImpl = api({ ...base, ...routes });
  return { fetchImpl, ...useFactory({ fetchImpl, EventSourceImpl: FakeEventSource }) };
}

test('loads the health, the skills and the runs of the agents server', async () => {
  const f = factory({});
  await settle();
  expect(f.available.value).toBe(true);
  expect(f.health.value).toEqual(HEALTH);
  expect(f.skills.value).toEqual([{ id: 'nx/monorepo' }]);
  expect(f.runs.value).toEqual([{ id: 'run-1', status: 'running' }]);
});

test('reports the agents server as unavailable on a 503, with its reason', async () => {
  const f = factory({ 'GET /api/factory/health': () => ({ status: 503, body: { error: 'agents-unavailable', detail: 'agents server unreachable at http://127.0.0.1:4318' } }) });
  await settle();
  expect(f.available.value).toBe(false);
  expect(f.detail.value).toContain('unreachable');
});

test('reports it as unavailable when the board itself cannot be reached', async () => {
  FakeEventSource.instances = [];
  const f = useFactory({ fetchImpl: vi.fn().mockRejectedValue(new Error('network down')), EventSourceImpl: FakeEventSource });
  await settle();
  expect(f.available.value).toBe(false);
  expect(f.detail.value).toBe('network down');
});

test('start posts only the filled fields, refreshes the runs and follows the new one', async () => {
  const posted = [];
  const f = factory({
    'POST /api/factory/runs': (init) => { posted.push(JSON.parse(init.body)); return { status: 202, body: { id: 'run-2', run: { id: 'run-2', status: 'running' } } }; },
  });
  await settle();
  const run = await f.start({ repo: 'api', provider: 'copilot', model: '', prompt: 'fix it', skill: '' });
  expect(posted).toEqual([{ repo: 'api', provider: 'copilot', prompt: 'fix it' }]);
  expect(run.id).toBe('run-2');
  expect(f.followed.value).toBe('run-2');
  expect(FakeEventSource.instances.at(-1).url).toBe('/api/factory/runs/run-2/events');
});

test('start sends the model and the skill when they are set', async () => {
  const posted = [];
  const f = factory({
    'POST /api/factory/runs': (init) => { posted.push(JSON.parse(init.body)); return { status: 202, body: { id: 'run-2', run: {} } }; },
  });
  await settle();
  await f.start({ repo: 'api', provider: 'claude-cli', model: 'sonnet', prompt: '', skill: 'nx/monorepo' });
  expect(posted).toEqual([{ repo: 'api', provider: 'claude-cli', model: 'sonnet', skill: 'nx/monorepo' }]);
});

test('a refused start keeps the reason and opens no stream', async () => {
  const f = factory({ 'POST /api/factory/runs': () => ({ status: 409, body: { error: 'a run is already active on api' } }) });
  await settle();
  expect(await f.start({ repo: 'api', provider: 'claude-cli', prompt: 'x' })).toBeNull();
  expect(f.error.value).toBe('a run is already active on api');
  expect(FakeEventSource.instances).toHaveLength(0);
});

test('a start that cannot reach the board reports the network error', async () => {
  const f = factory({ 'POST /api/factory/runs': () => { throw new Error('offline'); } });
  await settle();
  expect(await f.start({ repo: 'api', provider: 'claude-cli', prompt: 'x' })).toBeNull();
  expect(f.error.value).toBe('offline');
});

test('following a run collects its output and closes the stream on the final status', async () => {
  const f = factory({});
  await settle();
  f.follow('run-1');
  const stream = FakeEventSource.instances[0];
  stream.emit('stdout', { text: 'hello' });
  stream.emit('stderr', { text: 'warn' });
  stream.emit('status', { status: 'running' });
  expect(stream.closed).toBe(false);
  stream.emit('status', { status: 'succeeded' });
  expect(f.output.value).toEqual([
    { type: 'stdout', text: 'hello' },
    { type: 'stderr', text: 'warn' },
    { type: 'status', text: 'running' },
    { type: 'status', text: 'succeeded' },
  ]);
  expect(stream.closed).toBe(true);
});

test('following another run replaces the stream and clears the output', async () => {
  const f = factory({});
  await settle();
  f.follow('run-1');
  FakeEventSource.instances[0].emit('stdout', { text: 'old' });
  f.follow('run-2');
  expect(FakeEventSource.instances[0].closed).toBe(true);
  expect(f.followed.value).toBe('run-2');
  expect(f.output.value).toEqual([]);
});

test('a dropped stream is closed rather than left to reconnect and replay the output', async () => {
  const f = factory({});
  await settle();
  f.follow('run-1');
  FakeEventSource.instances[0].onerror();
  expect(FakeEventSource.instances[0].closed).toBe(true);
});

test('cancel sends DELETE and refreshes; a failure is reported', async () => {
  const deleted = [];
  const f = factory({ 'DELETE /api/factory/runs/run-1': () => { deleted.push('run-1'); return { status: 202, body: {} }; } });
  await settle();
  await f.cancel('run-1');
  expect(deleted).toEqual(['run-1']);

  const g = factory({ 'DELETE /api/factory/runs/run-1': () => ({ status: 404, body: { error: 'unknown run: run-1' } }) });
  await settle();
  await g.cancel('run-1');
  expect(g.error.value).toBe('unknown run: run-1');
});

test('close ends the followed stream', async () => {
  const f = factory({});
  await settle();
  f.follow('run-1');
  f.close();
  expect(FakeEventSource.instances[0].closed).toBe(true);
});

test('the unavailable reason falls back to the error code, then to the HTTP status', async () => {
  const withError = factory({ 'GET /api/factory/health': () => ({ status: 503, body: { error: 'agents-unavailable' } }) });
  await settle();
  expect(withError.detail.value).toBe('agents-unavailable');

  const bare = factory({ 'GET /api/factory/health': () => ({ status: 502, body: {} }) });
  await settle();
  expect(bare.detail.value).toBe('HTTP 502');
});

test('a thrown non-Error is reported as a string', async () => {
  FakeEventSource.instances = [];
  const f = useFactory({ fetchImpl: vi.fn().mockRejectedValue('boom'), EventSourceImpl: FakeEventSource });
  await settle();
  expect(f.detail.value).toBe('boom');

  const g = factory({ 'POST /api/factory/runs': () => { throw 'offline'; }, 'DELETE /api/factory/runs/run-1': () => { throw 'gone'; } });
  await settle();
  await g.start({ repo: 'api', provider: 'claude-cli', prompt: 'x' });
  expect(g.error.value).toBe('offline');
  await g.cancel('run-1');
  expect(g.error.value).toBe('gone');
});

test('missing lists default to empty and an unreadable body to an empty object', async () => {
  const f = factory({
    'GET /api/factory/skills': () => ({ body: {} }),
    'GET /api/factory/runs': () => ({ body: {} }),
  });
  await settle();
  expect(f.skills.value).toEqual([]);
  expect(f.runs.value).toEqual([]);

  const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }));
  const g = useFactory({ fetchImpl, EventSourceImpl: FakeEventSource });
  await settle();
  expect(g.detail.value).toBe('HTTP 500');
});

test('a failed runs refresh keeps the previous list', async () => {
  let fail = false;
  const f = factory({ 'GET /api/factory/runs': () => (fail ? { status: 500, body: {} } : { body: { runs: [{ id: 'run-1' }] } }) });
  await settle();
  fail = true;
  await f.refreshRuns();
  expect(f.runs.value).toEqual([{ id: 'run-1' }]);
});

test('a refused start or cancel without a message reports the HTTP status', async () => {
  const f = factory({
    'POST /api/factory/runs': () => ({ status: 500, body: {} }),
    'DELETE /api/factory/runs/run-1': () => ({ status: 500, body: {} }),
  });
  await settle();
  await f.start({ repo: 'api', provider: 'claude-cli', prompt: 'x' });
  expect(f.error.value).toBe('HTTP 500');
  await f.cancel('run-1');
  expect(f.error.value).toBe('HTTP 500');
});

test('it defaults to the global fetch and EventSource', async () => {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('EventSource', FakeEventSource);
  try {
    FakeEventSource.instances = [];
    const f = useFactory();
    await settle();
    expect(fetchSpy).toHaveBeenCalledWith('/api/factory/health', undefined);
    f.follow('run-9');
    expect(FakeEventSource.instances[0].url).toBe('/api/factory/runs/run-9/events');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('unmounting the host component closes the stream', async () => {
  FakeEventSource.instances = [];
  let f;
  const w = mount(defineComponent({
    setup() { f = factory({}); return () => null; },
  }));
  await settle();
  f.follow('run-1');
  w.unmount();
  expect(FakeEventSource.instances[0].closed).toBe(true);
});
