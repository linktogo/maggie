import { test, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createMemoryHistory } from 'vue-router';
import App from './App.vue';
import Column from './Column.vue';
import { createBoardRouter } from './router.js';
import { DEFAULT_LOCALE, locale, STORAGE_KEY } from './i18n.js';

// The /history route mounts real chart components; jsdom has no <canvas>
// support, so Chart.js is mocked the same way the dedicated chart test
// files do, rather than exercising real canvas rendering here.
vi.mock('chart.js', () => {
  class Chart {
    static register() {}
    constructor() {}
    update() {}
    destroy() {}
  }
  return { Chart, BarController: {}, BarElement: {}, CategoryScale: {}, LinearScale: {}, Tooltip: {}, Legend: {} };
});

afterEach(() => {
  vi.restoreAllMocks();
  locale.value = DEFAULT_LOCALE;
  window.localStorage.clear();
});

function routedFetch() {
  return vi.fn().mockImplementation((url) => {
    if (url === '/api/config') {
      return Promise.resolve({ json: async () => ({ repos: { a: { url: 'u', technologies: ['nestjs'], targets: [] } } }) });
    }
    if (url === '/api/history') {
      return Promise.resolve({ json: async () => ([]) });
    }
    return Promise.resolve({ json: async () => ({
      version: 2,
      repos: {
        a: { sessions: {} }, // idle repo -> todo placeholder card
        b: { sessions: { s1: { status: 'question', lastEvent: 'Stop', updatedAt: 'T', title: 'fix login', lastPrompt: 'fix login', events: [] } } },
        c: { sessions: { s2: { status: 'question', lastEvent: 'Notification', updatedAt: 'T', title: 'review PR', lastPrompt: 'review PR', events: [] } } },
        d: { sessions: { // one repo, two sessions in two different statuses -> two separate cards
          s3: { status: 'todo', lastEvent: 'init', updatedAt: 'T', title: 'd todo item', lastPrompt: 'd todo item', events: [] },
          s4: { status: 'question', lastEvent: 'Stop', updatedAt: 'T', title: 'd question item', lastPrompt: 'd question item', events: [] },
        } },
      },
    }) });
  });
}

// vue-router's navigation guard pipeline resolves push() over many chained
// microtasks (more than a handful of nextTick/Promise.resolve hops cover),
// so settle() also does a real macrotask flush via @vue/test-utils'
// flushPromises() to reliably wait out in-flight route navigations.
async function settle() {
  await nextTick(); await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick();
  await flushPromises();
  await nextTick();
}

async function mountApp(fetchImpl, { path = '/' } = {}) {
  // Reuses the real route table instead of duplicating it, so the test
  // exercises exactly what main.js installs.
  const router = createBoardRouter(createMemoryHistory());
  router.push(path);
  await router.isReady();
  const wrapper = mount(App, { props: { fetchImpl, intervalMs: 100000 }, global: { plugins: [router] } });
  await settle();
  return { wrapper, router };
}

test('App groups repos into the four columns', async () => {
  const { wrapper } = await mountApp(routedFetch());
  const columns = wrapper.findAll('section');
  expect(columns).toHaveLength(4);
  expect(columns[2].text()).toContain('(3)'); // repos b, c and d each have a session in "question"
  expect(wrapper.text()).toContain('a');
  expect(wrapper.text()).toContain('b');
});

test('a repo with sessions in two different statuses gets a separate card per matching column', async () => {
  const { wrapper } = await mountApp(routedFetch());
  const columns = wrapper.findAll('section');
  const todoColumn = columns[0];
  const questionColumn = columns[2];

  expect(todoColumn.text()).toContain('d');
  expect(questionColumn.text()).toContain('d');
  expect(todoColumn.text()).toContain('d todo item');
  expect(todoColumn.text()).not.toContain('d question item');
  expect(questionColumn.text()).toContain('d question item');
  expect(questionColumn.text()).not.toContain('d todo item');
});

test('App renders the summary header and filter bar', async () => {
  const { wrapper } = await mountApp(routedFetch());
  expect(wrapper.text()).toContain('repos');
  expect(wrapper.find('[data-test=search]').exists()).toBe(true);
});

test('clicking a session row opens the detail panel', async () => {
  const { wrapper } = await mountApp(routedFetch());
  await wrapper.get('[data-test=session-row]').trigger('click');
  expect(wrapper.find('aside').exists()).toBe(true);
});

test('typing in the search filters the cards', async () => {
  const { wrapper } = await mountApp(routedFetch());
  await wrapper.get('[data-test=search]').setValue('b');
  await nextTick();
  expect(wrapper.text()).toContain('b');
  expect(wrapper.text()).not.toContain('Notification'); // card 'c' filtered out
});

function ciRoutedFetch({ board = { version: 2, repos: {} }, ci = { repos: {}, lastSyncError: null } }) {
  return vi.fn().mockImplementation((url) => {
    if (url === '/api/config') return Promise.resolve({ json: async () => ({ repos: {} }) });
    if (url === '/api/ci') return Promise.resolve({ json: async () => ci });
    if (url === '/api/history') return Promise.resolve({ json: async () => ([]) });
    return Promise.resolve({ json: async () => board });
  });
}

const CARD = { sessions: {} }; // idle repo -> todo placeholder card

test('renders CI badges coming from /api/ci', async () => {
  const fetchImpl = ciRoutedFetch({
    board: { version: 2, repos: { 'oc-be': CARD } },
    ci: { repos: { 'oc-be': { users: { alice: { state: 'failure' } } } }, lastSyncError: null },
  });
  const { wrapper } = await mountApp(fetchImpl);
  expect(wrapper.get('[data-test=ci-badge]').text()).toBe('AL');
});

test('the CI filter hides repos that do not match', async () => {
  const fetchImpl = ciRoutedFetch({
    board: { version: 2, repos: { 'repo-green': CARD, 'repo-red': CARD } },
    ci: { repos: {
      'repo-green': { users: { alice: { state: 'success' } } },
      'repo-red': { users: { alice: { state: 'failure' } } },
    }, lastSyncError: null },
  });
  const { wrapper } = await mountApp(fetchImpl);
  await wrapper.get('[data-test=ci]').setValue('failure');
  await nextTick();
  expect(wrapper.text()).toContain('repo-red');
  expect(wrapper.text()).not.toContain('repo-green');
});

test('shows a desync banner when the server reports a sync error', async () => {
  const fetchImpl = ciRoutedFetch({ ci: { repos: {}, lastSyncError: 'could not read from remote' } });
  const { wrapper } = await mountApp(fetchImpl);
  expect(wrapper.get('[data-test=ci-desync]').text()).toContain('CI out of sync');
});

test('shows a board-wide banner when CI is unavailable, distinct from the desync banner', async () => {
  const fetchImpl = ciRoutedFetch({
    board: { version: 2, repos: { 'oc-be': CARD } },
    ci: {
      repos: { 'oc-be': { users: {}, unavailable: 'status repo not configured' } },
      lastSyncError: null,
    },
  });
  const { wrapper } = await mountApp(fetchImpl);
  expect(wrapper.get('[data-test=ci-unavailable-banner]').text()).toContain('status repo not configured');
  expect(wrapper.find('[data-test=ci-desync]').exists()).toBe(false);
});

test('clicking the History tab navigates to /history and shows history entries instead of the board', async () => {
  const fetchImpl = vi.fn().mockImplementation((url) => {
    if (url === '/api/config') return Promise.resolve({ json: async () => ({ repos: {} }) });
    if (url === '/api/history') {
      return Promise.resolve({
        json: async () => ([{
          repo: 'oc-be', sessionId: 's1', title: 'fix login',
          startedAt: '2026-06-21T09:00:00.000Z', endedAt: '2026-06-21T09:10:00.000Z',
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 },
        }]),
      });
    }
    return Promise.resolve({ json: async () => ({ version: 2, repos: {} }) });
  });
  const { wrapper, router } = await mountApp(fetchImpl);
  await wrapper.get('[data-test=view-history]').trigger('click');
  await settle();
  expect(router.currentRoute.value.path).toBe('/history');
  expect(wrapper.find('section').exists()).toBe(false);
  expect(wrapper.text()).toContain('fix login');
});

test('opening /history directly renders the history page (deep link)', async () => {
  const fetchImpl = vi.fn().mockImplementation((url) => {
    if (url === '/api/history') {
      return Promise.resolve({
        json: async () => ([{
          repo: 'oc-be', sessionId: 's1', title: 'fix login',
          startedAt: '2026-06-21T09:00:00.000Z', endedAt: '2026-06-21T09:10:00.000Z',
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 },
        }]),
      });
    }
    return Promise.resolve({ json: async () => ({ version: 2, repos: {} }) });
  });
  const { wrapper } = await mountApp(fetchImpl, { path: '/history' });
  expect(wrapper.text()).toContain('fix login');
  expect(wrapper.find('section').exists()).toBe(false);
});

test('dropping a session on Done confirms, closes it via the API, and refreshes the board', async () => {
  const calls = [];
  const fetchImpl = vi.fn().mockImplementation((url) => {
    calls.push(url);
    if (url === '/api/config') return Promise.resolve({ json: async () => ({ repos: {} }) });
    if (url === '/api/sessions/close') return Promise.resolve({ json: async () => ({ closed: true }) });
    return Promise.resolve({ json: async () => ({
      version: 2,
      repos: { b: { sessions: { s1: { status: 'question', lastEvent: 'Stop', updatedAt: 'T', title: 'fix login', lastPrompt: 'fix login', events: [] } } } },
    }) });
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { wrapper } = await mountApp(fetchImpl);
  const boardCallsBefore = calls.filter((u) => u === '/api/board').length;

  const doneColumn = wrapper.findAllComponents(Column)[3];
  await doneColumn.vm.$emit('close-session', { repo: 'b', sessionId: 's1' });
  await settle();

  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('fix login'));
  const closeCall = fetchImpl.mock.calls.find(([u]) => u === '/api/sessions/close');
  expect(closeCall[1]).toMatchObject({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'b', sessionId: 's1' }),
  });
  const boardCallsAfter = calls.filter((u) => u === '/api/board').length;
  expect(boardCallsAfter).toBeGreaterThan(boardCallsBefore);
});

test('declining the confirm on drop does not call the close API', async () => {
  const fetchImpl = routedFetch();
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { wrapper } = await mountApp(fetchImpl);
  const doneColumn = wrapper.findAllComponents(Column)[3];
  await doneColumn.vm.$emit('close-session', { repo: 'b', sessionId: 's1' });
  await settle();
  expect(fetchImpl.mock.calls.some(([u]) => u === '/api/sessions/close')).toBe(false);
});

test('renders in English by default, with the four columns in English', async () => {
  const { wrapper } = await mountApp(routedFetch());
  expect(wrapper.get('[data-test=view-history]').text()).toBe('History');
  const columns = wrapper.findAll('section h2');
  expect(columns.map((c) => c.text().replace(/\s*\(\d+\)$/, ''))).toEqual(['To do', 'In progress', 'Question', 'Done']);
  expect(wrapper.text()).toContain('No active session');
});

test('picking a language re-renders the whole board in it and remembers the choice', async () => {
  const { wrapper } = await mountApp(routedFetch());
  await wrapper.get('[data-test=locale]').setValue('fr');
  await settle();
  expect(wrapper.get('[data-test=view-history]').text()).toBe('Historique');
  expect(wrapper.findAll('section h2')[0].text()).toContain('À faire');
  expect(wrapper.text()).toContain('Aucune session active');
  expect(window.localStorage.getItem(STORAGE_KEY)).toBe('fr');

  await wrapper.get('[data-test=locale]').setValue('de');
  await settle();
  expect(wrapper.get('[data-test=view-history]').text()).toBe('Verlauf');

  await wrapper.get('[data-test=locale]').setValue('es');
  await settle();
  expect(wrapper.get('[data-test=view-history]').text()).toBe('Historial');
});

test('a session send-message posts the queued message to the API and refreshes the board', async () => {
  const calls = [];
  const fetchImpl = vi.fn().mockImplementation((url) => {
    calls.push(url);
    if (url === '/api/config') return Promise.resolve({ json: async () => ({ repos: {} }) });
    if (url === '/api/sessions/message') return Promise.resolve({ json: async () => ({ queued: true, count: 1 }) });
    return Promise.resolve({ json: async () => ({
      version: 2,
      repos: { b: { sessions: { s1: { status: 'question', lastEvent: 'Stop', updatedAt: 'T', title: 'fix login', lastPrompt: 'fix login', events: [] } } } },
    }) });
  });
  const { wrapper } = await mountApp(fetchImpl);
  const boardCallsBefore = calls.filter((u) => u === '/api/board').length;

  const questionColumn = wrapper.findAllComponents(Column)[2];
  await questionColumn.vm.$emit('send-message', { repo: 'b', sessionId: 's1', text: 'please rebase' });
  await settle();

  const messageCall = fetchImpl.mock.calls.find(([u]) => u === '/api/sessions/message');
  expect(messageCall[1]).toMatchObject({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'b', sessionId: 's1', message: 'please rebase' }),
  });
  const boardCallsAfter = calls.filter((u) => u === '/api/board').length;
  expect(boardCallsAfter).toBeGreaterThan(boardCallsBefore);
});

test('the retro-doc tab mounts its page, with the repos of the config', async () => {
  const router = createBoardRouter(createMemoryHistory());
  const w = mount(App, { props: { fetchImpl: routedFetch(), intervalMs: 100000 }, global: { plugins: [router] } });
  await router.isReady();
  await flushPromises();

  await w.get('[data-test=view-retro-doc]').trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.name).toBe('retro-doc');
  expect(w.get('[data-test=retro-run-a]').exists()).toBe(true);
});

test('the header carries the theme and mode pickers', async () => {
  const { wrapper } = await mountApp(routedFetch());
  expect(wrapper.find('[data-test=theme]').exists()).toBe(true);
  expect(wrapper.find('[data-test=mode]').exists()).toBe(true);
  expect(wrapper.find('[data-test=locale]').exists()).toBe(true);
});
