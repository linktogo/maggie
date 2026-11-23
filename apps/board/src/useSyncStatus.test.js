import { test, expect, vi } from 'vitest';
import { nextTick } from 'vue';
import { useSyncStatus } from './useSyncStatus.js';

const settle = async () => { await nextTick(); await Promise.resolve(); await nextTick(); };

test('useSyncStatus fetches immediately and exposes the repos and the check time', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ generatedAt: 'T', repos: { a: { status: 'drift' } } }) });
  const { repos, generatedAt, stop } = useSyncStatus({ intervalMs: 100000, fetchImpl });
  await settle();
  expect(fetchImpl).toHaveBeenCalledWith('/api/sync-status');
  expect(repos.value.a.status).toBe('drift');
  expect(generatedAt.value).toBe('T');
  stop();
});

test('useSyncStatus treats an empty payload as no status', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({}) });
  const { repos, generatedAt, stop } = useSyncStatus({ intervalMs: 100000, fetchImpl });
  await settle();
  expect(repos.value).toEqual({});
  expect(generatedAt.value).toBeNull();
  stop();
});

test('useSyncStatus keeps the last status when a fetch fails, and polls', async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce({ json: async () => ({ repos: { a: { status: 'in-sync' } } }) })
    .mockRejectedValue(new Error('down'));
  const { repos, stop } = useSyncStatus({ intervalMs: 500, fetchImpl });
  await vi.advanceTimersByTimeAsync(1100);
  expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(repos.value).toEqual({ a: { status: 'in-sync' } });
  stop();
  vi.useRealTimers();
});
