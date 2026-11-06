import { test, expect, vi } from 'vitest';
import { nextTick } from 'vue';
import { useBoard } from './useBoard.js';

test('useBoard fetches immediately and exposes repos', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ version: 2, repos: { a: { sessions: {} } } }) });
  const { repos, stop } = useBoard({ intervalMs: 1000, fetchImpl });
  await nextTick();
  await Promise.resolve();
  expect(fetchImpl).toHaveBeenCalledWith('/api/board');
  expect(repos.value).toEqual({ a: { sessions: {} } });
  stop();
});

test('useBoard polls on the interval', async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ version: 2, repos: {} }) });
  const { stop } = useBoard({ intervalMs: 500, fetchImpl });
  await vi.advanceTimersByTimeAsync(1100);
  expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3); // immediate + 2 ticks
  stop();
  vi.useRealTimers();
});

test('useBoard reports no transitions on the first fetch (baseline)', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ repos: { a: { sessions: { s1: { status: 'question' } } } } }) });
  const { transitions, stop } = useBoard({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  expect(transitions.value).toEqual([]);
  stop();
});

test('useBoard detects session transitions into question/done on later fetches', async () => {
  const responses = [
    { repos: { a: { sessions: { s1: { status: 'inprogress', title: 'fix login' } } }, b: { sessions: { s2: { status: 'todo' } } } } },
    { repos: { a: { sessions: { s1: { status: 'question', title: 'fix login' } } }, b: { sessions: { s2: { status: 'done' } } } } },
  ];
  const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve({ json: async () => responses.shift() }));
  const { transitions, refresh, stop } = useBoard({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  await refresh();
  expect(transitions.value).toEqual([
    { name: 'a', sessionId: 's1', title: 'fix login', status: 'question' },
    { name: 'b', sessionId: 's2', title: undefined, status: 'done' },
  ]);
  stop();
});

test('useBoard does not report a transition for a session whose status is unchanged', async () => {
  const responses = [
    { repos: { a: { sessions: { s1: { status: 'question', title: 't' } } } } },
    { repos: { a: { sessions: { s1: { status: 'question', title: 't' } } } } },
  ];
  const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve({ json: async () => responses.shift() }));
  const { transitions, refresh, stop } = useBoard({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  await refresh();
  expect(transitions.value).toEqual([]);
  stop();
});

test('useBoard sets connected=false on a fetch error', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
  const { connected, stop } = useBoard({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  expect(connected.value).toBe(false);
  stop();
});

test('useBoard reports loaded only after the first successful fetch', async () => {
  let resolve;
  const fetchImpl = vi.fn().mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const { loaded, stop } = useBoard({ intervalMs: 100000, fetchImpl });
  await nextTick();
  expect(loaded.value).toBe(false);
  resolve({ json: async () => ({ version: 2, repos: {} }) });
  await vi.waitFor(() => expect(loaded.value).toBe(true));
  stop();
});

test('useBoard stays not loaded when the first fetch fails', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
  const { loaded, connected, stop } = useBoard({ intervalMs: 100000, fetchImpl });
  await vi.waitFor(() => expect(connected.value).toBe(false));
  expect(loaded.value).toBe(false);
  stop();
});
