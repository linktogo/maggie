import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { INPUT_CHUNK_CHARS, useTerminal } from './useTerminal.js';

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

  emit(type, data) { for (const fn of this.listeners[type] ?? []) fn({ data }); }
}

const TM = 'tm_0123456789abcdef';
const OPENED = { status: 201, body: { terminal: { id: TM, repo: 'api', cwd: '/ws/api' } } };

function setup({ open = () => OPENED, input, remove, mounted = false } = {}) {
  FakeEventSource.instances = [];
  const calls = [];
  const resolvers = [];
  const fetchImpl = vi.fn((url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body && JSON.parse(init.body), keepalive: init.keepalive });
    const fallback = init.method === 'DELETE' && remove ? remove : () => ({ status: 204 });
    const reply = (url === '/api/factory/terminals' ? open : url.endsWith('/input') && input ? input : fallback)(init);
    const respond = ({ status, body = {} }) => ({ ok: status < 400, status, json: async () => body });
    if (reply === 'manual') return new Promise((resolve) => resolvers.push(() => resolve(respond({ status: 204 }))));
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(respond(reply));
  });
  const win = new EventTarget();
  const options = { fetchImpl, EventSourceImpl: FakeEventSource, win };
  if (!mounted) return { terminal: useTerminal(options), calls, resolvers, win };
  let terminal;
  const wrapper = mount(defineComponent({ setup() { terminal = useTerminal(options); return () => null; } }));
  return { terminal, calls, resolvers, win, wrapper };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const stream = () => FakeEventSource.instances.at(-1);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test('open posts the size, then follows the events of the new shell', async () => {
  const { terminal, calls } = setup();
  expect(terminal.status.value).toBe('idle');
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  expect(calls[0]).toMatchObject({ url: '/api/factory/terminals', method: 'POST', body: { repo: 'api', cols: 80, rows: 24 } });
  expect(stream().url).toBe(`/api/factory/terminals/${TM}/events`);
  expect(terminal.status.value).toBe('open');
  expect(terminal.cwd.value).toBe('/ws/api');
});

test('data events are decoded from base64 to bytes', async () => {
  const { terminal } = setup();
  const chunks = [];
  await terminal.open('api', { cols: 80, rows: 24 }, (bytes) => chunks.push(bytes));
  stream().emit('data', 'w6k=');
  expect(chunks).toEqual([new Uint8Array([0xc3, 0xa9])]);
});

test('keystrokes within 10 ms are sent in one POST', async () => {
  const { terminal, calls } = setup();
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  terminal.write('l');
  terminal.write('s');
  terminal.write('\r');
  await vi.advanceTimersByTimeAsync(10);
  expect(calls.slice(1)).toEqual([{ url: `/api/factory/terminals/${TM}/input`, method: 'POST', body: { data: 'ls\r' }, keepalive: undefined }]);
});

test('input sent while a POST is in flight follows it, in order, one request at a time', async () => {
  const { terminal, calls, resolvers } = setup({ input: () => 'manual' });
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  terminal.write('a');
  await vi.advanceTimersByTimeAsync(10);
  terminal.write('b');
  terminal.write('c');
  await vi.advanceTimersByTimeAsync(10);
  expect(calls.slice(1).map((c) => c.body.data)).toEqual(['a']);
  resolvers.shift()();
  await flush();
  expect(calls.slice(1).map((c) => c.body.data)).toEqual(['a', 'bc']);
});

test('a paste longer than the chunk size is split into ordered chunks', async () => {
  const { terminal, calls } = setup();
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  terminal.write('x'.repeat(INPUT_CHUNK_CHARS * 2 + 5));
  await vi.advanceTimersByTimeAsync(10);
  await flush();
  expect(INPUT_CHUNK_CHARS).toBe(16384);
  expect(calls.slice(1).map((c) => c.body.data.length)).toEqual([16384, 16384, 5]);
});

test('a chunk never ends between the two halves of a surrogate pair', async () => {
  const { terminal, calls } = setup();
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  terminal.write(`${'x'.repeat(INPUT_CHUNK_CHARS - 1)}😀`);
  await vi.advanceTimersByTimeAsync(10);
  await flush();
  expect(calls.slice(1).map((c) => c.body.data.length)).toEqual([16383, 2]);
});

test('resize is debounced to the last size', async () => {
  const { terminal, calls } = setup();
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  terminal.resize(100, 30);
  terminal.resize(120, 40);
  await vi.advanceTimersByTimeAsync(100);
  expect(calls.slice(1)).toEqual([{ url: `/api/factory/terminals/${TM}/resize`, method: 'POST', body: { cols: 120, rows: 40 }, keepalive: undefined }]);
});

test('input and resize before the shell is open are dropped', async () => {
  const { terminal, calls } = setup();
  terminal.write('ls');
  terminal.resize(100, 30);
  await vi.advanceTimersByTimeAsync(100);
  expect(calls).toEqual([]);
});

test('a second open while opening or open is ignored', async () => {
  const { terminal, calls } = setup();
  const first = terminal.open('api', { cols: 80, rows: 24 }, () => {});
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  await first;
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  expect(FakeEventSource.instances).toHaveLength(1);
});

test('exit sets exited with its code and closes the stream', async () => {
  const { terminal } = setup();
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  stream().emit('exit', '{"code":127,"signal":null}');
  expect(terminal.status.value).toBe('exited');
  expect(terminal.exitCode.value).toBe(127);
  expect(stream().closed).toBe(true);
});

test('a stream error sets disconnected without reconnecting', async () => {
  const { terminal } = setup();
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  stream().onerror();
  expect(terminal.status.value).toBe('disconnected');
  expect(stream().closed).toBe(true);
  expect(FakeEventSource.instances).toHaveLength(1);
});

test('a refused open sets error with the server message, or the detail of a 503', async () => {
  const refused = setup({ open: () => ({ status: 404, body: { error: 'unknown repository: x' } }) });
  await refused.terminal.open('x', { cols: 80, rows: 24 }, () => {});
  expect(refused.terminal.status.value).toBe('error');
  expect(refused.terminal.error.value).toBe('unknown repository: x');
  expect(FakeEventSource.instances).toHaveLength(0);

  const unavailable = setup({ open: () => ({ status: 503, body: { error: 'terminal-unavailable', detail: 'no prebuilt' } }) });
  await unavailable.terminal.open('api', { cols: 80, rows: 24 }, () => {});
  expect(unavailable.terminal.error.value).toBe('no prebuilt');

  const bare = setup({ open: () => ({ status: 500 }) });
  await bare.terminal.open('api', { cols: 80, rows: 24 }, () => {});
  expect(bare.terminal.error.value).toBe('HTTP 500');
});

test('an unreachable board sets error with the network message', async () => {
  const { terminal } = setup({ open: () => new Error('Failed to fetch') });
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  expect(terminal.status.value).toBe('error');
  expect(terminal.error.value).toBe('Failed to fetch');
});

test('a failed input POST sets error and keeps the shell open', async () => {
  const { terminal } = setup({ input: () => new Error('Failed to fetch') });
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  terminal.write('ls');
  await vi.advanceTimersByTimeAsync(10);
  await flush();
  expect(terminal.error.value).toBe('Failed to fetch');
  expect(terminal.status.value).toBe('open');
});

test('close sends DELETE with keepalive and stops the stream', async () => {
  const { terminal, calls } = setup();
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  terminal.write('ls');
  terminal.resize(100, 30);
  await terminal.close();
  await vi.advanceTimersByTimeAsync(100);
  expect(calls.slice(1)).toEqual([{ url: `/api/factory/terminals/${TM}`, method: 'DELETE', body: undefined, keepalive: true }]);
  expect(stream().closed).toBe(true);
  expect(terminal.status.value).toBe('idle');
  await terminal.close();
  expect(calls).toHaveLength(2);
});

test('close survives a failed DELETE', async () => {
  const { terminal, calls } = setup({ remove: () => new Error('Failed to fetch') });
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  await expect(terminal.close()).resolves.toBeUndefined();
  expect(calls.at(-1).method).toBe('DELETE');
  expect(terminal.status.value).toBe('idle');
});

test('an exited shell can be opened again', async () => {
  const { terminal, calls } = setup();
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  stream().emit('exit', '{"code":0,"signal":null}');
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  expect(terminal.status.value).toBe('open');
});

test('pagehide closes the shell', async () => {
  const { terminal, calls, win } = setup();
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  win.dispatchEvent(new Event('pagehide'));
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', keepalive: true });
});

test('unmounting the component closes the shell and stops listening to pagehide', async () => {
  const { terminal, calls, win, wrapper } = setup({ mounted: true });
  await terminal.open('api', { cols: 80, rows: 24 }, () => {});
  wrapper.unmount();
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', keepalive: true });
  win.dispatchEvent(new Event('pagehide'));
  expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
});
