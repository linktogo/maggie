import { test, expect, vi } from 'vitest';
import { useHistory } from './useHistory.js';

test('useHistory fetches immediately and exposes entries', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ([{ repo: 'a', sessionId: 's1' }]) });
  const { entries } = useHistory({ fetchImpl });
  await Promise.resolve();
  await Promise.resolve();
  expect(fetchImpl).toHaveBeenCalledWith('/api/history');
  expect(entries.value).toEqual([{ repo: 'a', sessionId: 's1' }]);
});

test('useHistory falls back to an empty list on a fetch error', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
  const { entries } = useHistory({ fetchImpl });
  await Promise.resolve();
  await Promise.resolve();
  expect(entries.value).toEqual([]);
});

test('load() re-fetches on demand', async () => {
  const responses = [
    { json: async () => ([]) },
    { json: async () => ([{ repo: 'a', sessionId: 's1' }]) },
  ];
  const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()));
  const { entries, load } = useHistory({ fetchImpl });
  await Promise.resolve();
  await Promise.resolve();
  expect(entries.value).toEqual([]);
  await load();
  expect(entries.value).toEqual([{ repo: 'a', sessionId: 's1' }]);
});
