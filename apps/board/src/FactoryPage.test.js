import { test, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import FactoryPage from './FactoryPage.vue';
import { setLocale } from './i18n.js';

class FakeEventSource {
  static instances = [];

  constructor(url) { this.url = url; this.listeners = {}; FakeEventSource.instances.push(this); }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }

  close() { this.closed = true; }

  emit(type, data) { for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) }); }
}

const HEALTH = { providers: { available: ['claude-cli', 'copilot'], default: 'copilot' }, repos: ['api', 'web'] };
const SKILLS = [{ id: 'nx/monorepo', techno: 'nx', name: 'monorepo', description: 'Keep Nx tidy' }];

function fetchWith({ health = { status: 200, body: HEALTH }, runs = [], onPost = () => ({ status: 202, body: { id: 'run-1', run: { id: 'run-1', status: 'running' } } }), onDelete = () => ({ status: 202, body: {} }) } = {}) {
  return vi.fn(async (url, init = {}) => {
    const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (init.method === 'POST') { const r = onPost(JSON.parse(init.body)); return answer(r.status, r.body); }
    if (init.method === 'DELETE') { const r = onDelete(url); return answer(r.status, r.body); }
    if (url === '/api/factory/health') return answer(health.status, health.body);
    if (url === '/api/factory/skills') return answer(200, { skills: SKILLS });
    return answer(200, { runs });
  });
}

const mounted = [];
afterEach(() => { setLocale('en'); while (mounted.length) mounted.pop().unmount(); });

// Attached to the document: jsdom only submits a form that is connected.
async function page(fetchImpl) {
  FakeEventSource.instances = [];
  const w = mount(FactoryPage, { props: { fetchImpl, EventSourceImpl: FakeEventSource }, attachTo: document.body });
  mounted.push(w);
  await flushPromises();
  return w;
}

test('the form offers the repos and providers of the agents server, preselecting its default provider', async () => {
  const w = await page(fetchWith());
  expect(w.findAll('[data-test=factory-repo] option').map((o) => o.text())).toEqual(['api', 'web']);
  expect(w.findAll('[data-test=factory-provider] option').map((o) => o.element.value)).toEqual(['claude-cli', 'copilot']);
  expect(w.get('[data-test=factory-provider]').element.value).toBe('copilot');
});

test('the run button waits for a prompt', async () => {
  const w = await page(fetchWith());
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(true);
  await w.get('[data-test=factory-prompt]').setValue('fix the failing test');
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(false);
});

test('running posts the chosen repo, provider, model and prompt, then follows the output', async () => {
  const posted = [];
  const w = await page(fetchWith({ onPost: (body) => { posted.push(body); return { status: 202, body: { id: 'run-1', run: { id: 'run-1', status: 'running' } } }; } }));
  await w.get('[data-test=factory-repo]').setValue('web');
  await w.get('[data-test=factory-provider]').setValue('claude-cli');
  await w.get('[data-test=factory-model]').setValue('sonnet');
  await w.get('[data-test=factory-prompt]').setValue('fix it');
  await w.get('[data-test=factory-run]').trigger('click');
  await flushPromises();

  expect(posted).toEqual([{ repo: 'web', provider: 'claude-cli', model: 'sonnet', prompt: 'fix it' }]);
  FakeEventSource.instances[0].emit('stdout', { text: 'working…' });
  await flushPromises();
  expect(w.get('[data-test=factory-output]').text()).toContain('working…');
});

test('skill mode needs a skill and posts it, the prompt becoming extra instructions', async () => {
  const posted = [];
  const w = await page(fetchWith({ onPost: (body) => { posted.push(body); return { status: 202, body: { id: 'run-1', run: {} } }; } }));
  await w.get('[data-test=factory-mode-skill]').setValue(true);
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(true);
  await w.get('[data-test=factory-skill]').setValue('nx/monorepo');
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(false);
  await w.get('[data-test=factory-run]').trigger('click');
  await flushPromises();
  expect(posted).toEqual([{ repo: 'api', provider: 'copilot', skill: 'nx/monorepo' }]);
});

test('an unreachable agents server explains how to start it and disables the form', async () => {
  const w = await page(fetchWith({ health: { status: 503, body: { error: 'agents-unavailable', detail: 'agents server unreachable at http://127.0.0.1:4318' } } }));
  expect(w.get('[data-test=factory-unavailable]').text()).toContain('not reachable');
  expect(w.get('[data-test=factory-unavailable]').text()).toContain('npm run agents');
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(true);
});

test('a server with no agent CLI says so', async () => {
  const w = await page(fetchWith({ health: { status: 200, body: { ...HEALTH, providers: { available: [], default: 'claude-cli' } } } }));
  expect(w.get('[data-test=factory-no-provider]').exists()).toBe(true);
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(true);
});

test('a refused run shows the reason', async () => {
  const w = await page(fetchWith({ onPost: () => ({ status: 409, body: { error: 'a run is already active on api' } }) }));
  await w.get('[data-test=factory-prompt]').setValue('again');
  await w.get('[data-test=factory-run]').trigger('click');
  await flushPromises();
  expect(w.get('[data-test=factory-error]').text()).toContain('already active');
});

test('runs are listed; a running one can be stopped, any one can be followed', async () => {
  const deleted = [];
  const runs = [
    { id: 'run-2', repo: 'web', provider: 'copilot', skill: 'nx/monorepo', status: 'running' },
    { id: 'run-1', repo: 'api', provider: 'claude-cli', skill: null, status: 'succeeded' },
  ];
  const w = await page(fetchWith({ runs, onDelete: (url) => { deleted.push(url); return { status: 202, body: {} }; } }));
  expect(w.get('[data-test=factory-run-row-run-2]').text()).toContain('running');
  expect(w.get('[data-test=factory-run-row-run-1]').text()).toContain('succeeded');
  expect(w.find('[data-test=factory-stop-run-1]').exists()).toBe(false);

  await w.get('[data-test=factory-stop-run-2]').trigger('click');
  expect(deleted).toEqual(['/api/factory/runs/run-2']);

  await w.get('[data-test=factory-follow-run-1]').trigger('click');
  expect(FakeEventSource.instances.at(-1).url).toBe('/api/factory/runs/run-1/events');
});

test('with nothing to show the page says so', async () => {
  const w = await page(fetchWith());
  expect(w.get('[data-test=factory-no-runs]').exists()).toBe(true);
  expect(w.get('[data-test=factory-no-output]').exists()).toBe(true);
});

test('a default provider that is not installed falls back to the first available one', async () => {
  const w = await page(fetchWith({ health: { status: 200, body: { ...HEALTH, providers: { available: ['claude-cli'], default: 'copilot' } } } }));
  expect(w.get('[data-test=factory-provider]').element.value).toBe('claude-cli');
});

test('a server with no allowed repository says so', async () => {
  const w = await page(fetchWith({ health: { status: 200, body: { ...HEALTH, repos: [] } } }));
  expect(w.get('[data-test=factory-no-repos]').exists()).toBe(true);
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(true);
});

test('failed and timed-out runs are flagged, the others are not', async () => {
  const runs = [
    { id: 'a', repo: 'api', provider: 'copilot', skill: null, status: 'failed' },
    { id: 'b', repo: 'api', provider: 'copilot', skill: null, status: 'timed-out' },
    { id: 'c', repo: 'api', provider: 'copilot', skill: null, status: 'cancelled' },
  ];
  const w = await page(fetchWith({ runs }));
  const flagged = (id) => w.get(`[data-test=factory-run-row-${id}] span:nth-child(3)`).classes();
  expect(flagged('a')).toContain('text-question-on-soft');
  expect(flagged('b')).toContain('text-question-on-soft');
  expect(flagged('c')).not.toContain('text-question-on-soft');
  expect(w.get('[data-test=factory-run-row-b]').text()).toContain('timed out');
});

test('the output shows stdout, stderr and status lines as plain text', async () => {
  const w = await page(fetchWith({ runs: [{ id: 'run-1', repo: 'api', provider: 'copilot', skill: null, status: 'running' }] }));
  await w.get('[data-test=factory-follow-run-1]').trigger('click');
  const stream = FakeEventSource.instances[0];
  stream.emit('stdout', { text: '<b>not html</b>\n' });
  stream.emit('stderr', { text: 'oops\n' });
  stream.emit('status', { status: 'succeeded' });
  await flushPromises();
  const out = w.get('[data-test=factory-output]');
  expect(out.text()).toContain('<b>not html</b>');
  expect(out.find('b').exists()).toBe(false);
  expect(out.text()).toContain('— succeeded');
  const spans = out.findAll('span');
  expect(spans[1].classes()).toContain('text-question-on-soft');
  expect(spans[0].classes()).not.toContain('text-question-on-soft');
  expect(w.get('h3 .font-normal, h3 span').text()).toContain('run-1');
});

test('the run list and the status lines of the output follow the locale', async () => {
  setLocale('fr');
  const runs = [{ id: 'run-1', repo: 'api', provider: 'copilot', skill: null, status: 'timed-out' }];
  const w = await page(fetchWith({ runs }));
  expect(w.get('[data-test=factory-run-row-run-1]').text()).toContain('délai dépassé');
  expect(w.get('[data-test=factory-run-row-run-1]').text()).toContain('prompt · copilot');
  await w.get('[data-test=factory-follow-run-1]').trigger('click');
  FakeEventSource.instances[0].emit('status', { status: 'succeeded' });
  await flushPromises();
  expect(w.get('[data-test=factory-output]').text()).toContain('— réussie');
  expect(w.get('[data-test=factory-output]').text()).not.toContain('succeeded');
});
