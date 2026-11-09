import { test, expect, vi } from 'vitest';
import { nextTick } from 'vue';
import { useRetroDoc } from './useRetroDoc.js';

const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

test('useRetroDoc lists the jobs the server already knows about', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(ok({ jobs: [{ id: 'api-1', repo: 'api', status: 'done', out: 'docs/ai/x.md' }] }));
  const { jobs, available, latestFor, stop } = useRetroDoc({ fetchImpl });
  await settle();
  expect(fetchImpl).toHaveBeenCalledWith('/api/retro-doc');
  expect(available.value).toBe(true);
  expect(latestFor('api').out).toBe('docs/ai/x.md');
  expect(latestFor('web')).toBe(null);
  expect(jobs.value.length).toBe(1);
  stop();
});

test('useRetroDoc reports the feature as unavailable on a board with no config', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(ok({ error: 'no config loaded' }, 503));
  const { available, stop } = useRetroDoc({ fetchImpl });
  await settle();
  expect(available.value).toBe(false);
  stop();
});

test('useRetroDoc posts the repo and the chosen LLM, then polls until the job ends', async () => {
  vi.useFakeTimers();
  const running = { jobs: [{ id: 'api-1', repo: 'api', status: 'running', log: [] }] };
  const done = { jobs: [{ id: 'api-1', repo: 'api', status: 'done', out: 'docs/ai/x.md' }] };
  let polls = 0;
  const fetchImpl = vi.fn(async (url, init) => {
    if (init?.method === 'POST') return ok({ job: { id: 'api-1', repo: 'api', status: 'running' } }, 202);
    polls += 1;
    return ok(polls <= 2 ? running : done);
  });

  const { jobs, start, stop } = useRetroDoc({ fetchImpl, intervalMs: 100 });
  const job = await start('api', 'copilot');
  expect(job.id).toBe('api-1');
  expect(JSON.parse(fetchImpl.mock.calls.find((call) => call[1]?.method === 'POST')[1].body))
    .toEqual({ repo: 'api', provider: 'copilot' });

  await vi.advanceTimersByTimeAsync(350);
  expect(jobs.value[0].status).toBe('done');
  const callsAfterDone = fetchImpl.mock.calls.length;
  await vi.advanceTimersByTimeAsync(500);
  expect(fetchImpl.mock.calls.length).toBe(callsAfterDone);
  stop();
  vi.useRealTimers();
});

test('useRetroDoc surfaces a refusal from the server instead of pretending it started', async () => {
  const fetchImpl = vi.fn(async (url, init) => (init?.method === 'POST'
    ? ok({ error: 'a retro-documentation of api is already running' }, 409)
    : ok({ jobs: [] })));
  const { error, start, stop } = useRetroDoc({ fetchImpl });
  expect(await start('api', 'claude')).toBe(null);
  expect(error.value).toMatch(/already running/);
  stop();
});

test('useRetroDoc survives a server that answers with something other than JSON', async () => {
  const fetchImpl = vi.fn(async (url, init) => (init?.method === 'POST'
    ? { ok: false, status: 500, json: async () => { throw new Error('not json'); } }
    : ok({ jobs: [] })));
  const { error, start, stop } = useRetroDoc({ fetchImpl });
  expect(await start('api', 'claude')).toBe(null);
  expect(error.value).toBe('HTTP 500');
  stop();
});

test('useRetroDoc keeps the last known jobs when the board goes away', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('connection refused'));
  const { jobs, error, stop } = useRetroDoc({ fetchImpl });
  await settle();
  expect(jobs.value).toEqual([]);
  expect(error.value).toBe('connection refused');
  stop();
});

test('useRetroDoc reports a non-Error failure as text', async () => {
  const fetchImpl = vi.fn().mockRejectedValue('offline');
  const { error, stop } = useRetroDoc({ fetchImpl });
  await settle();
  expect(error.value).toBe('offline');
  stop();
});

test('useRetroDoc does not start a second poll for a second job, and returns null when no job is echoed', async () => {
  vi.useFakeTimers();
  try {
    const running = ok({ jobs: [{ id: 'api-1', repo: 'api', status: 'running' }] });
    const fetchImpl = vi.fn().mockImplementation(async (url, opts) => (opts ? ok({}) : running));
    const { start, stop } = useRetroDoc({ fetchImpl, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await start('api', 'claude')).toBeNull();
    expect(await start('web', 'claude')).toBeNull();
    const before = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl.mock.calls.length - before).toBe(1); // one interval, not two
    stop();
  } finally {
    vi.useRealTimers();
  }
});
