import { test, expect, vi, afterEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { useDayHistory } from './useDayHistory.js';

afterEach(() => { vi.useRealTimers(); });

function okFetch(entries) {
  return vi.fn().mockResolvedValue({ json: async () => entries });
}

test('fetches nothing while disabled', async () => {
  vi.useFakeTimers();
  const fetchImpl = okFetch([]);
  useDayHistory({ fetchImpl, intervalMs: 1000, enabled: ref(false) });
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('fetches immediately when enabled, then on every interval', async () => {
  vi.useFakeTimers();
  const fetchImpl = okFetch([{ endedAt: 'x' }]);
  const { entries, loaded } = useDayHistory({ fetchImpl, intervalMs: 1000, enabled: ref(true) });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledWith('/api/history');
  expect(entries.value).toEqual([{ endedAt: 'x' }]);
  expect(loaded.value).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test('starts when enabled later and stops, unloading, when disabled again', async () => {
  vi.useFakeTimers();
  const fetchImpl = okFetch([]);
  const enabled = ref(false);
  const { loaded } = useDayHistory({ fetchImpl, intervalMs: 1000, enabled });
  enabled.value = true;
  await nextTick();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(loaded.value).toBe(true);
  enabled.value = false;
  await nextTick();
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(loaded.value).toBe(false);
});

test('a failed fetch keeps the previous entries and does not mark loaded', async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce({ json: async () => [{ endedAt: 'x' }] })
    .mockRejectedValueOnce(new Error('down'));
  const { entries, loaded } = useDayHistory({ fetchImpl, intervalMs: 1000, enabled: ref(true) });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(entries.value).toEqual([{ endedAt: 'x' }]);
  expect(loaded.value).toBe(true);
});

test('a first failed fetch leaves it not loaded, and a non-array payload is ignored', async () => {
  vi.useFakeTimers();
  const bad = useDayHistory({ fetchImpl: vi.fn().mockRejectedValue(new Error('down')), intervalMs: 1000, enabled: ref(true) });
  const odd = useDayHistory({ fetchImpl: okFetch({ not: 'an array' }), intervalMs: 1000, enabled: ref(true) });
  await vi.advanceTimersByTimeAsync(0);
  expect(bad.loaded.value).toBe(false);
  expect(odd.loaded.value).toBe(false);
  expect(odd.entries.value).toEqual([]);
});
