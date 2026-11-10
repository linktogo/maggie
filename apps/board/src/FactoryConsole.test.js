import { test, expect, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import FactoryConsole from './FactoryConsole.vue';
import { mode } from './theme.js';

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = {};
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }

  close() { this.closed = true; }

  emit(type, data) { for (const fn of this.listeners[type] ?? []) fn({ data }); }
}

class FakeResizeObserver {
  static instances = [];

  constructor(callback) { this.callback = callback; FakeResizeObserver.instances.push(this); }

  observe(el) { this.el = el; }

  disconnect() { this.disconnected = true; }
}

function fakeTerm() {
  const term = { written: [], themes: [], cols: 80, rows: 24, fits: 0, cleared: 0 };
  term.onData = (cb) => { term.type = cb; };
  term.write = (bytes) => term.written.push(bytes);
  term.fit = () => { term.fits += 1; };
  term.setTheme = (theme) => term.themes.push(theme);
  term.clear = () => { term.cleared += 1; };
  term.focus = () => { term.focused = true; };
  term.dispose = () => { term.disposed = true; };
  return term;
}

const TM = 'tm_0123456789abcdef';
let calls;
let term;

function setup({ open = () => ({ status: 201, body: { terminal: { id: TM, repo: 'api', cwd: '/ws/api' } } }) } = {}) {
  FakeEventSource.instances = [];
  FakeResizeObserver.instances = [];
  calls = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body && JSON.parse(init.body) });
    const { status, body = {} } = url === '/api/factory/terminals' ? open() : { status: 204 };
    return { ok: status < 400, status, json: async () => body };
  });
  const terminalFactory = vi.fn((el, theme) => { term = fakeTerm(); term.el = el; term.initialTheme = theme; return term; });
  return mount(FactoryConsole, {
    props: { thread: 'th_1', fetchImpl, EventSourceImpl: FakeEventSource, terminalFactory, ResizeObserverImpl: FakeResizeObserver },
    attachTo: document.body,
  });
}

beforeEach(() => {
  document.documentElement.style.setProperty('--color-surface', '#ffffff');
  document.documentElement.style.setProperty('--color-ink', '#222222');
  document.documentElement.style.setProperty('--color-accent', '#3f51b5');
  document.documentElement.style.setProperty('--color-accent-soft', '#e8eaf6');
});

test('mounting opens a shell sized from the fitted terminal', async () => {
  const wrapper = setup();
  await flushPromises();
  expect(term.el).toBe(wrapper.find('[data-test="factory-console-screen"]').element);
  expect(term.fits).toBe(1);
  expect(calls[0]).toMatchObject({ url: '/api/factory/terminals', method: 'POST', body: { thread: 'th_1', cols: 80, rows: 24 } });
  expect(FakeEventSource.instances[0].url).toBe(`/api/factory/terminals/${TM}/events`);
  wrapper.unmount();
});

test('the theme comes from the CSS tokens and follows a mode change', async () => {
  const wrapper = setup();
  await flushPromises();
  expect(term.initialTheme).toEqual({ background: '#ffffff', foreground: '#222222', cursor: '#3f51b5', selectionBackground: '#e8eaf6' });
  document.documentElement.style.setProperty('--color-surface', '#1e1e1e');
  mode.value = mode.value === 'dark' ? 'light' : 'dark';
  await nextTick();
  await nextTick();
  expect(term.themes.at(-1)).toMatchObject({ background: '#1e1e1e' });
  wrapper.unmount();
});

test('pty bytes are written to the terminal and keystrokes reach the shell', async () => {
  vi.useFakeTimers();
  const wrapper = setup();
  await flushPromises();
  FakeEventSource.instances[0].emit('data', 'JCA=');
  expect(term.written).toEqual([new Uint8Array([0x24, 0x20])]);
  term.type('ls\r');
  await vi.advanceTimersByTimeAsync(10);
  expect(calls.at(-1)).toMatchObject({ url: `/api/factory/terminals/${TM}/input`, body: { data: 'ls\r' } });
  wrapper.unmount();
  vi.useRealTimers();
});

test('a container resize refits and sends the new size', async () => {
  vi.useFakeTimers();
  const wrapper = setup();
  await flushPromises();
  term.cols = 120;
  term.rows = 40;
  FakeResizeObserver.instances[0].callback();
  expect(term.fits).toBe(2);
  await vi.advanceTimersByTimeAsync(100);
  expect(calls.at(-1)).toMatchObject({ url: `/api/factory/terminals/${TM}/resize`, body: { cols: 120, rows: 40 } });
  wrapper.unmount();
  vi.useRealTimers();
});

test('the header shows the cwd once open, and an opening message before', async () => {
  const wrapper = setup();
  await nextTick();
  expect(wrapper.find('[data-test="factory-console-status"]').text()).toBe('Opening a shell…');
  await flushPromises();
  expect(wrapper.find('[data-test="factory-console-cwd"]').text()).toBe('/ws/api');
  expect(wrapper.find('[data-test="factory-console-status"]').exists()).toBe(false);
  wrapper.unmount();
});

test('exited shows the code and a reopen button that opens a new shell', async () => {
  const wrapper = setup();
  await flushPromises();
  FakeEventSource.instances[0].emit('exit', '{"code":127,"signal":null}');
  await nextTick();
  expect(wrapper.find('[data-test="factory-console-status"]').text()).toBe('Process exited (code 127).');
  await wrapper.find('[data-test="factory-console-reopen"]').trigger('click');
  await flushPromises();
  expect(term.cleared).toBe(1);
  expect(calls.filter((c) => c.url === '/api/factory/terminals')).toHaveLength(2);
  expect(wrapper.find('[data-test="factory-console-reopen"]').exists()).toBe(false);
  wrapper.unmount();
});

test('disconnected shows the same button', async () => {
  const wrapper = setup();
  await flushPromises();
  FakeEventSource.instances[0].onerror();
  await nextTick();
  expect(wrapper.find('[data-test="factory-console-status"]').text()).toBe('Disconnected from the shell.');
  expect(wrapper.find('[data-test="factory-console-reopen"]').exists()).toBe(true);
  wrapper.unmount();
});

test('a refused open shows the server message and the reopen button', async () => {
  const wrapper = setup({ open: () => ({ status: 409, body: { error: 'at most 4 consoles can be open at once' } }) });
  await flushPromises();
  expect(wrapper.find('[data-test="factory-console-status"]').text()).toBe('at most 4 consoles can be open at once');
  expect(wrapper.find('[data-test="factory-console-reopen"]').exists()).toBe(true);
  wrapper.unmount();
});

test('focus() focuses the terminal', async () => {
  const wrapper = setup();
  await flushPromises();
  wrapper.vm.focus();
  expect(term.focused).toBe(true);
  wrapper.unmount();
});

test('unmount closes the shell, stops observing and disposes the terminal', async () => {
  const wrapper = setup();
  await flushPromises();
  wrapper.unmount();
  expect(calls.at(-1)).toMatchObject({ url: `/api/factory/terminals/${TM}`, method: 'DELETE' });
  expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
  expect(term.disposed).toBe(true);
});

test('without an injected ResizeObserver it observes with the global one', async () => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ terminal: { id: TM, repo: 'api', cwd: '/ws/api' } }) }));
  const wrapper = mount(FactoryConsole, { props: { thread: 'th_1', fetchImpl, EventSourceImpl: FakeEventSource, terminalFactory: () => { term = fakeTerm(); return term; } } });
  await flushPromises();
  expect(FakeResizeObserver.instances).toHaveLength(1);
  wrapper.unmount();
  vi.unstubAllGlobals();
});
