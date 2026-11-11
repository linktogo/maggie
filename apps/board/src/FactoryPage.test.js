import { test, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import FactoryPage from './FactoryPage.vue';
import { createBoardRouter } from './router.js';
import { setLocale } from './i18n.js';

class FakeEventSource {
  static count = 0;

  constructor() { this.listeners = {}; FakeEventSource.count += 1; }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }

  close() {}
}

const HEALTH = { providers: { available: ['claude-cli', 'copilot'], default: 'claude-cli' }, repos: ['api', 'web'] };
const SKILLS = [{ id: 'nx/monorepo' }];
const PROJECTS = [{ repo: 'api', threads: 2, running: 0, lastActivity: null }, { repo: 'web', threads: 0, running: 0, lastActivity: null }];
const NOW = '2026-11-07T10:00:00.000Z';
const THREAD = { id: 'th_0123456789abcdef', repo: 'api', provider: 'claude-cli', model: 'opus', skill: null, title: 'Fix the flaky test', sessionId: 's1', status: 'idle', createdAt: NOW, updatedAt: NOW };
const MESSAGES = [
  { id: 'm1', threadId: THREAD.id, role: 'user', kind: 'text', content: 'fix the flaky test', runId: 'r1', createdAt: NOW },
  { id: 'm2', threadId: THREAD.id, role: 'agent', kind: 'text', content: 'Done, **really**.', runId: 'r1', createdAt: NOW },
];

function fetchWith({ health = { status: 200, body: HEALTH }, onPost = () => ({ status: 201, body: { thread: THREAD } }), onMessage = () => ({ status: 202, body: { thread: { ...THREAD, status: 'running' } } }) } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    calls.push([init.method ?? 'GET', url]);
    const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url === '/api/factory/terminals') return answer(201, { terminal: { id: TM, repo: 'api', cwd: '/ws/api' } });
    if (url.startsWith('/api/factory/terminals/')) return answer(204, {});
    if (init.method === 'POST' && url.endsWith('/messages')) { const r = onMessage(JSON.parse(init.body)); return answer(r.status, r.body); }
    if (init.method === 'POST') { const r = onPost(JSON.parse(init.body)); return answer(r.status, r.body); }
    if (url === '/api/factory/health') return answer(health.status, health.body);
    if (url === '/api/factory/skills') return answer(200, { skills: SKILLS });
    if (url === '/api/factory/projects') return answer(200, { projects: PROJECTS });
    if (url.startsWith(`/api/factory/threads/${THREAD.id}`)) return answer(200, { thread: THREAD, messages: MESSAGES });
    if (url.startsWith('/api/factory/threads')) return answer(200, { threads: [THREAD] });
    return answer(404, {});
  });
  fetchImpl.calls = calls;
  return fetchImpl;
}

const mounted = [];
afterEach(() => { setLocale('en'); while (mounted.length) mounted.pop().unmount(); });

async function page(fetchImpl, path = '/factory', extra = {}) {
  const router = createBoardRouter(createMemoryHistory());
  await router.push(path);
  const w = mount(FactoryPage, { props: { fetchImpl, EventSourceImpl: FakeEventSource, ...extra }, global: { plugins: [router] }, attachTo: document.body });
  mounted.push(w);
  await flushPromises();
  return { w, router };
}

test('deep link /factory/api/th_… opens that thread', async () => {
  const fetchImpl = fetchWith();
  const { w } = await page(fetchImpl, `/factory/api/${THREAD.id}`);
  expect(fetchImpl.calls).toContainEqual(['GET', `/api/factory/threads/${THREAD.id}`]);
  expect(w.get('[data-test=factory-user]').text()).toBe('fix the flaky test');
  expect(w.get('[data-test=factory-agent] strong').text()).toBe('really');
  expect(w.get('[data-test=factory-reply]').exists()).toBe(true);
  expect(w.get(`[data-test=factory-thread-${THREAD.id}]`).exists()).toBe(true);
});

test('selecting a project then a thread updates the route', async () => {
  const { w, router } = await page(fetchWith());
  await w.get('[data-test=factory-project-api]').trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.fullPath).toBe('/factory/api');
  await w.get(`[data-test=factory-thread-${THREAD.id}]`).trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.fullPath).toBe(`/factory/api/${THREAD.id}`);
  expect(w.get('[data-test=factory-user]').exists()).toBe(true);
});

test('creating a request opens its thread', async () => {
  const posted = [];
  const fetchImpl = fetchWith({ onPost: (body) => { posted.push(body); return { status: 201, body: { thread: THREAD } }; } });
  const { w, router } = await page(fetchImpl, '/factory/api');
  await w.get('[data-test=factory-new]').trigger('click');
  expect(w.get('[data-test=factory-repo]').element.value).toBe('api');
  await w.get('[data-test=factory-prompt]').setValue('fix the flaky test');
  await w.get('form').trigger('submit');
  await flushPromises();
  expect(posted).toEqual([{ repo: 'api', provider: 'claude-cli', prompt: 'fix the flaky test', worktree: true }]);
  expect(router.currentRoute.value.fullPath).toBe(`/factory/api/${THREAD.id}`);
  expect(w.find('[data-test=factory-run]').exists()).toBe(false);
  expect(w.get('[data-test=factory-user]').exists()).toBe(true);
});

test('a busy repo error is shown in the composer', async () => {
  const { w } = await page(fetchWith({ onMessage: () => ({ status: 409, body: { error: 'a run is already active on api' } }) }), `/factory/api/${THREAD.id}`);
  await w.get('[data-test=factory-reply]').setValue('go on');
  await w.get('form').trigger('submit');
  await flushPromises();
  expect(w.get('[data-test=factory-error]').text()).toContain('already active');
  // The refused reply is still there to send again.
  expect(w.get('[data-test=factory-reply]').element.value).toBe('go on');
});

test('restart as a new request prefills the form with the last prompt', async () => {
  const fetchImpl = fetchWith();
  const base = fetchImpl.getMockImplementation();
  fetchImpl.mockImplementation(async (url, init) => (url.startsWith(`/api/factory/threads/${THREAD.id}`)
    ? { ok: true, status: 200, json: async () => ({ thread: { ...THREAD, status: 'failed', sessionId: null }, messages: MESSAGES }) }
    : base(url, init)));
  const { w, router } = await page(fetchImpl, `/factory/api/${THREAD.id}`);
  await w.get('[data-test=factory-restart]').trigger('click');
  await flushPromises();
  expect(w.get('[data-test=factory-prompt]').element.value).toBe('fix the flaky test');
  expect(w.get('[data-test=factory-model]').element.value).toBe('opus');
  expect(router.currentRoute.value.fullPath).toBe('/factory/api');
});

test('the unavailable banner is unchanged', async () => {
  const { w } = await page(fetchWith({ health: { status: 503, body: { error: 'agents-unavailable', detail: 'agents server unreachable at http://127.0.0.1:4318' } } }));
  expect(w.get('[data-test=factory-unavailable]').text()).toContain('not reachable');
  expect(w.get('[data-test=factory-unavailable]').text()).toContain('npm run agents');
});

test('a server with no agent CLI or no allowed repository says so', async () => {
  const noProvider = await page(fetchWith({ health: { status: 200, body: { ...HEALTH, providers: { available: [], default: 'claude-cli' } } } }));
  expect(noProvider.w.get('[data-test=factory-no-provider]').exists()).toBe(true);
  const noRepos = await page(fetchWith({ health: { status: 200, body: { ...HEALTH, repos: [] } } }));
  expect(noRepos.w.get('[data-test=factory-no-repos]').exists()).toBe(true);
});

test('the back button goes up one level', async () => {
  const { w, router } = await page(fetchWith(), `/factory/api/${THREAD.id}`);
  await w.get('[data-test=factory-back]').trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.fullPath).toBe('/factory/api');
  await w.get('[data-test=factory-back]').trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.fullPath).toBe('/factory');
  expect(w.find('[data-test=factory-back]').exists()).toBe(false);
});

const TM = 'tm_0123456789abcdef';
const CONSOLE_HEALTH = { status: 200, body: { ...HEALTH, terminal: { available: true } } };

vi.mock('./xtermAdapter.js', () => ({
  createXterm: () => ({ cols: 80, rows: 24, fit() {}, onData() {}, write() {}, setTheme() {}, clear() {}, focus() {}, dispose() {} }),
}));

class NoResize { observe() {} disconnect() {} }

async function threadPage(health = CONSOLE_HEALTH) {
  vi.stubGlobal('ResizeObserver', NoResize);
  const fetchImpl = fetchWith({ health });
  const result = await page(fetchImpl, `/factory/api/${THREAD.id}`);
  return { ...result, fetchImpl };
}

const terminalCalls = (fetchImpl, method) => fetchImpl.calls.filter(([m, url]) => m === method && url.startsWith('/api/factory/terminals'));

afterEach(() => { vi.unstubAllGlobals(); });

test('without a console there are no tabs, and the Console button is enabled', async () => {
  const { w } = await threadPage();
  expect(w.find('[data-test=factory-tabs]').exists()).toBe(false);
  expect(w.find('[data-test=factory-console]').exists()).toBe(false);
  expect(w.get('[data-test=factory-console-button]').attributes('disabled')).toBeUndefined();
});

test('clicking Console opens the shell and selects the console tab', async () => {
  const { w, fetchImpl } = await threadPage();
  await w.get('[data-test=factory-console-button]').trigger('click');
  await flushPromises();
  expect(w.get('[data-test=factory-tabs]').exists()).toBe(true);
  expect(w.get('[data-test=factory-tab-console]').attributes('aria-selected')).toBe('true');
  expect(w.get('[data-test=factory-console]').isVisible()).toBe(true);
  expect(w.get('[data-test=factory-user]').isVisible()).toBe(false);
  expect(w.get('[data-test=factory-reply]').isVisible()).toBe(false);
  expect(terminalCalls(fetchImpl, 'POST')).toEqual([['POST', '/api/factory/terminals']]);
});

test('clicking Console again selects the tab without a second console', async () => {
  const { w, fetchImpl } = await threadPage();
  await w.get('[data-test=factory-console-button]').trigger('click');
  await flushPromises();
  await w.get('[data-test=factory-tab-conversation]').trigger('click');
  await w.get('[data-test=factory-console-button]').trigger('click');
  await flushPromises();
  expect(w.get('[data-test=factory-tab-console]').attributes('aria-selected')).toBe('true');
  expect(w.findAll('[data-test=factory-console]')).toHaveLength(1);
  expect(terminalCalls(fetchImpl, 'POST')).toHaveLength(1);
});

test('switching back to Conversation keeps the console alive, hidden', async () => {
  const { w, fetchImpl } = await threadPage();
  await w.get('[data-test=factory-console-button]').trigger('click');
  await flushPromises();
  await w.get('[data-test=factory-tab-conversation]').trigger('click');
  expect(w.get('[data-test=factory-tab-conversation]').attributes('aria-selected')).toBe('true');
  expect(w.get('[data-test=factory-user]').isVisible()).toBe(true);
  expect(w.get('[data-test=factory-console]').isVisible()).toBe(false);
  expect(terminalCalls(fetchImpl, 'DELETE')).toEqual([]);
});

test('the close button of the tab kills the shell and removes the tabs', async () => {
  const { w, fetchImpl } = await threadPage();
  await w.get('[data-test=factory-console-button]').trigger('click');
  await flushPromises();
  await w.get('[data-test=factory-console-close]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test=factory-tabs]').exists()).toBe(false);
  expect(w.find('[data-test=factory-console]').exists()).toBe(false);
  expect(w.get('[data-test=factory-user]').isVisible()).toBe(true);
  expect(terminalCalls(fetchImpl, 'DELETE')).toEqual([['DELETE', `/api/factory/terminals/${TM}`]]);
});

test('leaving the conversation closes the console', async () => {
  const { w, router, fetchImpl } = await threadPage();
  await w.get('[data-test=factory-console-button]').trigger('click');
  await flushPromises();
  await router.push('/factory/api');
  await flushPromises();
  expect(terminalCalls(fetchImpl, 'DELETE')).toHaveLength(1);
  await router.push(`/factory/api/${THREAD.id}`);
  await flushPromises();
  expect(w.find('[data-test=factory-tabs]').exists()).toBe(false);
});

test('the Console button is disabled with the reason when the server has no console', async () => {
  const { w } = await threadPage({ status: 200, body: { ...HEALTH, terminal: { available: false, reason: 'disabled' } } });
  const button = w.get('[data-test=factory-console-button]');
  expect(button.attributes('disabled')).toBeDefined();
  expect(button.attributes('aria-label')).toBe('Console unavailable: disabled');
});

test('the console is opened for the thread, not the repo', async () => {
  const bodies = [];
  vi.stubGlobal('ResizeObserver', NoResize);
  const fetchImpl = fetchWith({ health: CONSOLE_HEALTH });
  const base = fetchImpl.getMockImplementation();
  fetchImpl.mockImplementation(async (url, init = {}) => {
    if (url === '/api/factory/terminals') bodies.push(JSON.parse(init.body));
    return base(url, init);
  });
  const { w } = await page(fetchImpl, `/factory/api/${THREAD.id}`);
  await w.get('[data-test=factory-console-button]').trigger('click');
  await flushPromises();
  expect(bodies).toEqual([{ thread: THREAD.id, cols: 80, rows: 24 }]);
});

const WT_THREAD = { ...THREAD, worktree: { path: '/wk/.worktrees/api/x', branch: 'factory/x', base: 'origin/main', exists: true, dirty: true, ahead: 0 } };

// A thread with a worktree whose DELETE answers come from `answers` in order; afterwards the worktree is gone.
// `branchKept` is what a successful DELETE answers; `gate`, when given, is awaited before the DELETE answers.
async function worktreePage(answers, confirms, { branchKept = false, gate = null } = {}) {
  vi.stubGlobal('ResizeObserver', NoResize);
  const confirmImpl = vi.fn(() => confirms.shift());
  const fetchImpl = fetchWith({ health: CONSOLE_HEALTH });
  const base = fetchImpl.getMockImplementation();
  let removed = false;
  fetchImpl.mockImplementation(async (url, init = {}) => {
    if (init.method === 'DELETE' && url.startsWith(`/api/factory/threads/${THREAD.id}/worktree`)) {
      fetchImpl.calls.push(['DELETE', url]);
      if (gate) await gate;
      const status = answers.shift();
      if (status === 200) removed = true;
      return { ok: status < 400, status, json: async () => (status === 409 ? { error: 'worktree-dirty' } : { thread: THREAD, branchKept }) };
    }
    if (url === `/api/factory/threads/${THREAD.id}`) {
      fetchImpl.calls.push(['GET', url]);
      // Removing the worktree forgets the Claude session with it.
      return { ok: true, status: 200, json: async () => ({ thread: removed ? { ...THREAD, sessionId: null } : WT_THREAD, messages: MESSAGES }) };
    }
    return base(url, init);
  });
  const result = await page(fetchImpl, `/factory/api/${THREAD.id}`, { confirmImpl });
  return { ...result, fetchImpl, confirmImpl };
}

const deletes = (fetchImpl) => fetchImpl.calls.filter(([m]) => m === 'DELETE').map(([, url]) => url);

test('refusing the first confirmation removes nothing', async () => {
  const { w, fetchImpl, confirmImpl } = await worktreePage([], [false]);
  await w.get('[data-test=factory-worktree-remove]').trigger('click');
  await flushPromises();
  expect(confirmImpl).toHaveBeenCalledTimes(1);
  expect(confirmImpl.mock.calls[0][0]).toContain('Remove this worktree');
  expect(deletes(fetchImpl)).toEqual([]);
});

test('a clean worktree is removed after one confirmation and the badge disappears', async () => {
  const { w, fetchImpl, confirmImpl } = await worktreePage([200], [true]);
  expect(w.get('[data-test=factory-worktree-badge]').exists()).toBe(true);
  await w.get('[data-test=factory-worktree-remove]').trigger('click');
  await flushPromises();
  expect(confirmImpl).toHaveBeenCalledTimes(1);
  expect(deletes(fetchImpl)).toEqual([`/api/factory/threads/${THREAD.id}/worktree`]);
  expect(w.find('[data-test=factory-worktree-badge]').exists()).toBe(false);
  // no session left: the reply box is disabled and a restart is offered instead
  expect(w.find('[data-test=factory-cannot-resume]').exists()).toBe(true);
  expect(w.get('[data-test=factory-reply]').element.disabled).toBe(true);
  expect(w.find('[data-test=factory-restart]').exists()).toBe(true);
});

test('a dirty worktree asks a second time, then forces', async () => {
  const { w, fetchImpl, confirmImpl } = await worktreePage([409, 200], [true, true]);
  await w.get('[data-test=factory-worktree-remove]').trigger('click');
  await flushPromises();
  expect(confirmImpl).toHaveBeenCalledTimes(2);
  expect(confirmImpl.mock.calls[1][0]).toContain('Uncommitted changes will be lost');
  expect(deletes(fetchImpl)).toEqual([`/api/factory/threads/${THREAD.id}/worktree`, `/api/factory/threads/${THREAD.id}/worktree?force=1`]);
  expect(w.find('[data-test=factory-worktree-badge]').exists()).toBe(false);
});

test('refusing the forced removal keeps the worktree', async () => {
  const { w, fetchImpl } = await worktreePage([409], [true, false]);
  await w.get('[data-test=factory-worktree-remove]').trigger('click');
  await flushPromises();
  expect(deletes(fetchImpl)).toEqual([`/api/factory/threads/${THREAD.id}/worktree`]);
  expect(w.get('[data-test=factory-worktree-badge]').exists()).toBe(true);
});

test('a failed removal that is not dirty does not ask to force', async () => {
  const { w, confirmImpl } = await worktreePage([502], [true]);
  await w.get('[data-test=factory-worktree-remove]').trigger('click');
  await flushPromises();
  expect(confirmImpl).toHaveBeenCalledTimes(1);
  expect(w.find('[data-test=factory-worktree-notice]').exists()).toBe(false);
});

test('a removal that keeps the branch says so, a deleted branch says nothing', async () => {
  const kept = await worktreePage([200], [true], { branchKept: true });
  await kept.w.get('[data-test=factory-worktree-remove]').trigger('click');
  await flushPromises();
  expect(kept.w.get('[data-test=factory-worktree-notice]').text()).toBe('Branch factory/x kept (it has commits)');
  const deleted = await worktreePage([200], [true]);
  await deleted.w.get('[data-test=factory-worktree-remove]').trigger('click');
  await flushPromises();
  expect(deleted.w.find('[data-test=factory-worktree-notice]').exists()).toBe(false);
});

test('a successful worktree removal closes the open console', async () => {
  const { w } = await worktreePage([200], [true]);
  await w.get('[data-test=factory-console-button]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test=factory-console]').exists()).toBe(true);
  await w.get('[data-test=factory-worktree-remove]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test=factory-console]').exists()).toBe(false);
});

test('a failed worktree removal leaves the console open', async () => {
  const { w } = await worktreePage([502], [true]);
  await w.get('[data-test=factory-console-button]').trigger('click');
  await flushPromises();
  await w.get('[data-test=factory-worktree-remove]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test=factory-console]').exists()).toBe(true);
});

test('the remove button is disabled while a removal is in flight', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { w, fetchImpl } = await worktreePage([200], [true], { gate });
  await w.get('[data-test=factory-worktree-remove]').trigger('click');
  await flushPromises();
  expect(w.get('[data-test=factory-worktree-remove]').element.disabled).toBe(true);
  release();
  await flushPromises();
  expect(deletes(fetchImpl)).toHaveLength(1);
  expect(w.find('[data-test=factory-worktree-badge]').exists()).toBe(false);
});

test('the default confirmation is window.confirm', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const fetchImpl = fetchWith();
  const base = fetchImpl.getMockImplementation();
  fetchImpl.mockImplementation(async (url, init) => (url === `/api/factory/threads/${THREAD.id}`
    ? { ok: true, status: 200, json: async () => ({ thread: WT_THREAD, messages: MESSAGES }) }
    : base(url, init)));
  const { w } = await page(fetchImpl, `/factory/api/${THREAD.id}`);
  await w.get('[data-test=factory-worktree-remove]').trigger('click');
  expect(confirm).toHaveBeenCalledTimes(1);
  confirm.mockRestore();
});

test('the console streams through the injected EventSource', async () => {
  const { w } = await threadPage();
  const before = FakeEventSource.count;
  await w.get('[data-test=factory-console-button]').trigger('click');
  await flushPromises();
  expect(FakeEventSource.count).toBe(before + 1);
});
