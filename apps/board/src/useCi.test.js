import { test, expect, vi } from 'vitest';
import { nextTick } from 'vue';
import { useCi } from './useCi.js';

function respond(body) {
  return vi.fn().mockResolvedValue({ json: async () => body });
}

test('useCi fetches immediately and exposes repos', async () => {
  const fetchImpl = respond({ repos: { a: { users: { alice: { state: 'failure' } } } }, lastSyncError: null });
  const { repos, stop } = useCi({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve();
  expect(fetchImpl).toHaveBeenCalledWith('/api/ci');
  expect(repos.value.a.users.alice.state).toBe('failure');
  stop();
});

test('useCi polls on the interval', async () => {
  vi.useFakeTimers();
  const fetchImpl = respond({ repos: {} });
  const { stop } = useCi({ intervalMs: 500, fetchImpl });
  await vi.advanceTimersByTimeAsync(1100);
  expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3);
  stop();
  vi.useRealTimers();
});

test('useCi surfaces the server-reported sync error', async () => {
  const fetchImpl = respond({ repos: {}, lastSyncError: 'could not read from remote' });
  const { syncError, stop } = useCi({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  expect(syncError.value).toBe('could not read from remote');
  stop();
});

test('useCi keeps the last known repos when a fetch fails', async () => {
  const responses = [{ repos: { a: { users: {} } }, lastSyncError: null }];
  const fetchImpl = vi.fn()
    .mockImplementationOnce(() => Promise.resolve({ json: async () => responses[0] }))
    .mockImplementationOnce(() => Promise.reject(new Error('down')));
  const { repos, syncError, refresh, stop } = useCi({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  await refresh();
  expect(repos.value).toEqual({ a: { users: {} } });
  expect(syncError.value).toBe('unreachable');
  stop();
});
