import { test, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import RetroDocPage from './RetroDocPage.vue';

const config = {
  'oc-be': { url: 'https://h/oc-be.git', technologies: ['nestjs', 'postgres'] },
  'lk-mind': { url: 'https://h/lk-mind.git', technologies: ['nextjs'] },
};
const now = Date.parse('2026-09-14T10:00:00.000Z');

function fetchWith({ jobs = [], status = 200, onPost = () => ({ status: 202, body: { job: {} } }) } = {}) {
  return vi.fn(async (url, init) => {
    if (init?.method === 'POST') {
      const answer = onPost(JSON.parse(init.body));
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    }
    return { ok: status < 400, status, json: async () => ({ jobs }) };
  });
}

async function page(fetchImpl) {
  const w = mount(RetroDocPage, { props: { config, now, fetchImpl } });
  await flushPromises();
  return w;
}

test('lists every repository of the config, alphabetically, with its technologies', async () => {
  const w = await page(fetchWith());
  const names = w.findAll('tbody tr').map((row) => row.get('td').text());
  expect(names[0]).toContain('lk-mind');
  expect(names[1]).toContain('oc-be');
  expect(names[1]).toContain('postgres');
  expect(w.get('[data-test=retro-never-lk-mind]').exists()).toBe(true);
});

test('generates the repository of the row, with the LLM chosen on that row', async () => {
  const posted = [];
  const fetchImpl = fetchWith({
    onPost: (body) => {
      posted.push(body);
      return { status: 202, body: { job: { id: 'x', repo: body.repo, status: 'running' } } };
    },
  });
  const w = await page(fetchImpl);
  await w.get('[data-test=retro-provider-oc-be]').setValue('copilot');
  await w.get('[data-test=retro-run-oc-be]').trigger('click');
  await flushPromises();

  expect(posted).toEqual([{ repo: 'oc-be', provider: 'copilot' }]);
});

test('each row keeps its own choice of LLM', async () => {
  const posted = [];
  const w = await page(fetchWith({
    onPost: (body) => {
      posted.push(body);
      return { status: 202, body: { job: {} } };
    },
  }));
  await w.get('[data-test=retro-provider-oc-be]').setValue('copilot');
  await w.get('[data-test=retro-run-lk-mind]').trigger('click');
  await flushPromises();
  expect(posted).toEqual([{ repo: 'lk-mind', provider: 'claude' }]);
});

test('a running row shows the batch in flight and cannot be started twice', async () => {
  const w = await page(fetchWith({
    jobs: [{
      id: 'x', repo: 'oc-be', status: 'running', startedAt: '2026-09-14T09:57:30.000Z',
      log: [
        { at: '2026-09-14T09:57:30.000Z', text: 'digest 1/5: 9 document(s), 192135 chars' },
        { at: '2026-09-14T09:59:12.000Z', text: 'digesting batch 2/5' },
      ],
    }],
  }));
  expect(w.get('[data-test=retro-running-oc-be]').text()).toContain('digesting batch 2/5');
  expect(w.get('[data-test=retro-running-oc-be]').text()).toContain('running for 2m 30s');
  expect(w.get('[data-test=retro-run-oc-be]').attributes('disabled')).toBeDefined();
  expect(w.get('[data-test=retro-run-lk-mind]').attributes('disabled')).toBeUndefined();
});

test('a finished row shows the path, the generator and when it ran', async () => {
  const w = await page(fetchWith({
    jobs: [{
      id: 'x', repo: 'oc-be', status: 'done', generator: 'GitHub Copilot CLI',
      out: 'docs/ai/retro-documentation.md', finishedAt: '2026-09-14T09:58:00.000Z',
    }],
  }));
  const line = w.get('[data-test=retro-done-oc-be]').text();
  expect(line).toContain('docs/ai/retro-documentation.md');
  expect(line).toContain('GitHub Copilot CLI');
  expect(line).toContain('2 min ago');
});

test('a failed row shows what the LLM or its CLI said', async () => {
  const w = await page(fetchWith({
    jobs: [{ id: 'x', repo: 'oc-be', status: 'error', error: '`copilot` exited with code 1: not logged in' }],
  }));
  expect(w.get('[data-test=retro-failed-oc-be]').text()).toContain('not logged in');
});

test('a board started without a config offers no button and says why', async () => {
  const w = await page(fetchWith({ status: 503 }));
  expect(w.get('[data-test=retro-unavailable]').text()).toContain('--config');
  expect(w.get('[data-test=retro-run-oc-be]').attributes('disabled')).toBeDefined();
  expect(w.get('[data-test=retro-provider-oc-be]').attributes('disabled')).toBeDefined();
});

test('an empty config says so instead of showing an empty table', async () => {
  const w = mount(RetroDocPage, { props: { config: {}, now, fetchImpl: fetchWith() } });
  await flushPromises();
  expect(w.get('[data-test=retro-empty]').exists()).toBe(true);
  expect(w.find('table').exists()).toBe(false);
});

const runningJob = {
  id: 'x', repo: 'oc-be', status: 'running', startedAt: '2026-09-14T09:57:30.000Z',
  log: [
    { at: '2026-09-14T09:57:30.000Z', text: 'digest 1/5: 9 document(s), 192135 chars — docs/superpowers/specs/a.md' },
    { at: '2026-09-14T09:59:12.000Z', text: '  ↳ digest 1/5 answered in 1m 42s — 4821 chars' },
  ],
};

test('a running row opens its console, timestamped, without being asked', async () => {
  const w = await page(fetchWith({ jobs: [runningJob] }));
  const box = w.get('[data-test=retro-row-oc-be] [data-test=retro-log]').text();
  expect(box).toContain('digest 1/5: 9 document(s), 192135 chars');
  expect(box).toContain('answered in 1m 42s — 4821 chars');
  expect(box).toMatch(/\d{2}:\d{2}:\d{2}/);
  expect(w.find('[data-test=retro-row-lk-mind] [data-test=retro-log]').exists()).toBe(false);
});

test('the console of a finished run is kept, one toggle away', async () => {
  const w = await page(fetchWith({
    jobs: [{ ...runningJob, status: 'done', out: 'docs/ai/retro-documentation.md', finishedAt: '2026-09-14T09:59:00.000Z' }],
  }));
  expect(w.find('[data-test=retro-row-oc-be] [data-test=retro-log]').exists()).toBe(false);
  await w.get('[data-test=retro-toggle-log-oc-be]').trigger('click');
  expect(w.get('[data-test=retro-row-oc-be] [data-test=retro-log]').text()).toContain('digest 1/5');
});

test('the console of a running row can be closed', async () => {
  const w = await page(fetchWith({ jobs: [runningJob] }));
  await w.get('[data-test=retro-toggle-log-oc-be]').trigger('click');
  expect(w.find('[data-test=retro-row-oc-be] [data-test=retro-log]').exists()).toBe(false);
});

test('a finished run says how many documents it produced', async () => {
  const w = await page(fetchWith({
    jobs: [{
      id: 'x', repo: 'oc-be', status: 'done', generator: 'claude-opus-5',
      out: 'docs/ai/retro-doc/README.md', finishedAt: '2026-09-14T09:58:00.000Z',
      files: ['docs/ai/retro-doc/README.md', 'docs/ai/retro-doc/sync.md', 'docs/ai/retro-doc/board.md'],
    }],
  }));
  const line = w.get('[data-test=retro-done-oc-be]').text();
  expect(line).toContain('docs/ai/retro-doc/README.md');
  expect(line).toContain('3 documents');
});
